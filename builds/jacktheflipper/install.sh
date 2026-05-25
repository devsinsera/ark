#!/bin/bash
# JackTheFlipper — phase 2 install. Runs once after first network-up
# boot, triggered by /etc/systemd/system/jacktheflipper-install.service.
#
# What it does:
#   1. apt update + install RaspyJack apt deps + extras
#   2. Extract /opt/ark-extras/raspyjack-src.tar.gz → /opt/raspyjack/
#   3. Run /opt/raspyjack/install_raspyjack.sh (RaspyJack's own installer
#      enables SPI/I2C, sets up systemd units, etc.)
#   4. Make sure /opt/jacktheflipper/flipper-bridge.py is executable
#   5. Reload udev rules so /dev/flipper symlink works once a Flipper
#      is plugged in
#   6. Disable this service (single-shot)
#   7. Reboot so SPI dtoverlay actually loads
#
# Logs to /var/log/jacktheflipper-install.log. SSH in and tail to
# watch progress: ssh jacktheflipper@jacktheflipper.local 'tail -f /var/log/jacktheflipper-install.log'

set +e
exec > >(tee -a /var/log/jacktheflipper-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " JackTheFlipper phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"

step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 1. apt update + full system upgrade + base deps ──
# First boot: bring the whole OS to current Bookworm patch level
# before installing anything else. Prevents the situation where
# RaspyJack pulls in a Python package that needs a newer libc/etc.
step "apt-get update + full system upgrade (this takes a while on Pi Zero 2 W)"
for try in 1 2 3; do
  if apt-get update -y; then
    echo "apt-get update OK on try $try"; break
  fi
  echo "apt-get update attempt $try failed; sleeping 15s"; sleep 15
done
DEBIAN_FRONTEND=noninteractive apt-get -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  full-upgrade || echo "WARN: full-upgrade had non-fatal issues; continuing"
apt-get -y autoremove || true
apt-get -y autoclean   || true

step "apt-get install base deps"
APT_OK=0
for try in 1 2 3; do
  if DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3-pip python3-serial python3-spidev python3-pil python3-smbus python3-smbus2 \
       python3-numpy python3-pyudev python3-rpi.gpio python3-netifaces \
       i2c-tools git nmap \
       tor torsocks; then
    APT_OK=1; echo "apt-get install OK on try $try"; break
  fi
  echo "apt-get attempt $try failed; sleeping 15s"; sleep 15
done

# ── 1b. Tor — start + enable so localhost:9050 is always available ──
step "Configure + enable tor"
systemctl enable tor 2>/dev/null || true
systemctl start  tor 2>/dev/null || true
# Quick test: does the SOCKS port come up?
sleep 3
if ss -ltn 2>/dev/null | grep -q ':9050'; then
  echo "tor SOCKS proxy listening on 127.0.0.1:9050"
else
  echo "WARN: tor not listening yet — may need a moment, or check /var/log/tor/log"
fi
if [ "$APT_OK" != 1 ]; then
  echo "WARN: apt-get install never succeeded. Install_raspyjack may still proceed, but expect failures."
fi

# ── 2. Extract RaspyJack source ──
# Upstream install_raspyjack.sh has /root/Raspyjack/ hardcoded as the
# install location (it writes gui_conf.json, expects the source layout
# there). We extract to BOTH /opt/raspyjack (operator-friendly path)
# and /root/Raspyjack (what the installer expects). Symlink-aware so
# they share data.
step "Extract /opt/ark-extras/raspyjack-src.tar.gz → /opt/raspyjack + /root/Raspyjack"
mkdir -p /opt/raspyjack /root/Raspyjack /var/lib/raspyjack
if [ -f /opt/ark-extras/raspyjack-src.tar.gz ]; then
  tar -xzf /opt/ark-extras/raspyjack-src.tar.gz -C /opt/raspyjack
  # Stage at the installer's expected location too
  rsync -aH /opt/raspyjack/ /root/Raspyjack/
  cp /opt/ark-extras/raspyjack-src.tar.gz /var/lib/raspyjack/source.tar.gz
  echo "extracted $(ls /opt/raspyjack | wc -l) entries to both /opt/raspyjack and /root/Raspyjack"
else
  echo "WARN: /opt/ark-extras/raspyjack-src.tar.gz not present — falling back to upstream clone"
  git clone --depth=1 https://github.com/7h30th3r0n3/Raspyjack /opt/raspyjack-tmp \
    && cp -r /opt/raspyjack-tmp/. /opt/raspyjack/ \
    && cp -r /opt/raspyjack-tmp/. /root/Raspyjack/ \
    && rm -rf /opt/raspyjack-tmp \
    || echo "git clone failed"
fi

# ── 3. Mirror SSH key to jacktheflipper + other users that raspyjack might create ──
step "Mirror SSH key to other users so we can SSH as them after raspyjack install"
for user in pi jacktheflipper; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    if [ -f /root/.ssh/authorized_keys ] && [ ! -f "$home/.ssh/authorized_keys" ]; then
      install -d -o "$user" -g "$user" -m 700 "$home/.ssh"
      install -o "$user" -g "$user" -m 600 /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
      echo "mirrored SSH key to $user"
    fi
  fi
done

# ── 4. Run RaspyJack's own installer ──
step "Run /opt/raspyjack/install_raspyjack.sh"
cd /opt/raspyjack
if [ -f install_raspyjack.sh ]; then
  chmod +x install_raspyjack.sh
  # install_raspyjack.sh is idempotent + asks interactive questions. Pipe 'y'
  # to every prompt for non-interactive run.
  yes y 2>/dev/null | bash install_raspyjack.sh
  RC=$?
  echo "install_raspyjack.sh exit code: $RC"
  if [ $RC -ne 0 ]; then
    echo "NOTE: install_raspyjack.sh exited non-zero. Some payloads may not work."
    echo "      SSH in and re-run manually: cd /opt/raspyjack && bash install_raspyjack.sh"
  fi
else
  echo "ERROR: install_raspyjack.sh missing from /opt/raspyjack/"
fi

# ── 4b. RaspyJack LCD daemon auto-start ──
# Make the 1.44" Waveshare LCD HAT come up on every boot. install_
# raspyjack.sh may install its own systemd unit (raspyjack.service);
# enable it if found. Otherwise write a fallback unit so the LCD
# always lights up.
step "Configure raspyjack.py LCD daemon to auto-start on boot"
RJ_UNIT=""
for cand in /etc/systemd/system/raspyjack.service /lib/systemd/system/raspyjack.service \
            /etc/systemd/system/raspyjack-lcd.service /lib/systemd/system/raspyjack-lcd.service; do
  [ -f "$cand" ] && RJ_UNIT="$cand" && break
done
if [ -n "$RJ_UNIT" ]; then
  echo "found raspyjack systemd unit: $RJ_UNIT — enabling"
  systemctl daemon-reload
  systemctl enable "$(basename "$RJ_UNIT")"
else
  echo "no raspyjack systemd unit found — writing fallback"
  cat > /etc/systemd/system/raspyjack-lcd.service <<UNIT
[Unit]
Description=RaspyJack LCD UI daemon (1.44 inch HAT)
Documentation=https://github.com/7h30th3r0n3/Raspyjack
After=multi-user.target
ConditionPathExists=/dev/spidev0.0
ConditionPathExists=/opt/raspyjack/raspyjack.py

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/raspyjack/raspyjack.py
WorkingDirectory=/opt/raspyjack
Restart=on-failure
RestartSec=5
User=root
StandardOutput=append:/var/log/raspyjack-lcd.log
StandardError=append:/var/log/raspyjack-lcd.log

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable raspyjack-lcd.service
  echo "fallback unit raspyjack-lcd.service enabled"
fi

# ── 5. Flipper bridge sanity check ──
step "Verify Flipper bridge is callable"
if [ -x /opt/jacktheflipper/flipper-bridge.py ]; then
  /opt/jacktheflipper/flipper-bridge.py list || true
else
  echo "ERROR: /opt/jacktheflipper/flipper-bridge.py not executable or missing"
fi

# ── 5a. Ensure SPI + I2C dtparams are in config.txt (defensive, RaspyJack's
# installer should already have done this but belt-and-braces in case it
# didn't or partially failed). Without these, the LCD HAT and the UPS HAT
# both stay dark even after a reboot.
step "Ensure SPI + I2C are enabled in config.txt"
CFG=/boot/firmware/config.txt
[ -f "$CFG" ] || CFG=/boot/config.txt
if [ -f "$CFG" ]; then
  for p in "dtparam=spi=on" "dtparam=i2c_arm=on" "dtparam=i2c1=on" "dtoverlay=spi0-2cs"; do
    if ! grep -qxF "$p" "$CFG"; then
      echo "$p" >> "$CFG"
      echo "  appended: $p"
    else
      echo "  already present: $p"
    fi
  done
else
  echo "WARN: config.txt not found at /boot/firmware or /boot — skipping"
fi

# ── 5b. UPS CLI — install + try a one-shot read so the log shows what's detected ──
step "Install ups CLI + first detection"
if [ -f /opt/jacktheflipper/ups-cli.py ]; then
  install -m 755 /opt/jacktheflipper/ups-cli.py /usr/local/bin/ups
  echo "ups CLI installed at /usr/local/bin/ups"
  /usr/local/bin/ups --json 2>&1 | head -3 || true
fi

# ── 5c. Ragnar wrapper CLI — start/stop the vendored Ragnar via SSH ──
step "Install ragnar CLI"
if [ -f /opt/jacktheflipper/ragnar-cli.sh ]; then
  install -m 755 /opt/jacktheflipper/ragnar-cli.sh /usr/local/bin/ragnar
  echo "ragnar CLI installed at /usr/local/bin/ragnar"
fi

# ── 6. Reload udev for Flipper symlink ──
step "udev reload (for /dev/flipper symlink)"
udevadm control --reload-rules || true
udevadm trigger || true

# ── 6b. Tailscale (optional) — joins tailnet so you can SSH from anywhere ──
# Authkey baked at build time. Empty placeholder → block is a no-op.
TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
if [ -n "$TS_AUTHKEY" ]; then
  step "Tailscale install + tailnet join"
  for i in 1 2 3 4 5 6; do
    curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts.sh && break
    echo "tailscale fetch retry $i (waiting for network)…"; sleep 10
  done
  if [ -f /tmp/ts.sh ]; then
    sh /tmp/ts.sh
    tailscale up --auth-key="$TS_AUTHKEY" --hostname="jacktheflipper" --ssh --accept-routes \
      || echo "tailscale up failed (check authkey + tailnet ACLs)"
    rm -f /tmp/ts.sh
  fi
fi

# ── 7. Disable + remove this service ──
step "Disable jacktheflipper-install.service"
systemctl disable jacktheflipper-install.service 2>/dev/null || true
# Don't rm the service file — keeping it as a record. The service is
# disabled + has Type=oneshot + RemainAfterExit so it won't re-run.

# ── 8. MOTD ──
step "Update /etc/motd"
cat > /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  JackTheFlipper  —  RaspyJack + Flipper bridge                ║
  ║                                                               ║
  ║  RaspyJack:                                                   ║
  ║    Source at /opt/raspyjack/                                  ║
  ║    Launch LCD UI:  sudo python3 /opt/raspyjack/raspyjack.py   ║
  ║                                                               ║
  ║  Flipper bridge:                                              ║
  ║    /opt/jacktheflipper/flipper-bridge.py — READ-ONLY allow-list║
  ║    Plug Flipper into USB; symlink at /dev/flipper             ║
  ║    Test: python3 /opt/jacktheflipper/flipper-bridge.py info   ║
  ║                                                               ║
  ║  Drive from Ark on your Mac:                                  ║
  ║    https://sinsera.co/ark/#security/raspyjack                 ║
  ║    https://sinsera.co/ark/#security/flipper                   ║
  ║                                                               ║
  ║  UPS battery:                                                 ║
  ║    Run: ups          (snapshot of V/A/SOC + charging state)   ║
  ║    Or:  ups --watch  (live, refresh every 2 s)                ║
  ║    Auto-detects Waveshare INA219 or PiSugar IP5306.           ║
  ║                                                               ║
  ║  Ragnar (vendored offensive recon stack):                     ║
  ║    Start: ragnar start    Stop: ragnar stop                   ║
  ║    Status + dashboard URL: ragnar status                      ║
  ║    Web UI: http://<this-pi-ip>:8091                           ║
  ║                                                               ║
  ║  Tor:                                                         ║
  ║    SOCKS proxy at 127.0.0.1:9050  (sudo systemctl status tor) ║
  ║    Route any command:  torsocks <cmd>                         ║
  ║                                                               ║
  ║  Authorised use only — own hardware, own networks, written    ║
  ║  permission. The Flipper bridge refuses TX/clone/emulate.     ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

step "DONE — rebooting in 5s for SPI dtoverlay to take effect"
echo "════════════════════════════════════════════════════════════════"
echo " JackTheFlipper phase-2 install complete $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
sync
( sleep 5; systemctl reboot ) &
exit 0
