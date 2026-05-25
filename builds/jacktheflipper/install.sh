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
# watch progress: ssh peta@jacktheflipper.local 'tail -f /var/log/jacktheflipper-install.log'

set +e
exec > >(tee -a /var/log/jacktheflipper-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " JackTheFlipper phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"

step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 1. apt update + base deps ──
step "apt-get update + base deps"
APT_OK=0
for try in 1 2 3; do
  if apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3-pip python3-serial python3-spidev python3-pil python3-smbus python3-smbus2 \
       python3-numpy python3-pyudev python3-rpi.gpio python3-netifaces \
       i2c-tools git nmap; then
    APT_OK=1; echo "apt-get install OK on try $try"; break
  fi
  echo "apt-get attempt $try failed; sleeping 15s"; sleep 15
done
if [ "$APT_OK" != 1 ]; then
  echo "WARN: apt-get install never succeeded. Install_raspyjack may still proceed, but expect failures."
fi

# ── 2. Extract RaspyJack source ──
step "Extract /opt/ark-extras/raspyjack-src.tar.gz → /opt/raspyjack"
mkdir -p /opt/raspyjack /var/lib/raspyjack
if [ -f /opt/ark-extras/raspyjack-src.tar.gz ]; then
  tar -xzf /opt/ark-extras/raspyjack-src.tar.gz -C /opt/raspyjack
  cp /opt/ark-extras/raspyjack-src.tar.gz /var/lib/raspyjack/source.tar.gz
  echo "extracted $(ls /opt/raspyjack | wc -l) entries"
else
  echo "WARN: /opt/ark-extras/raspyjack-src.tar.gz not present — falling back to upstream clone"
  git clone --depth=1 https://github.com/7h30th3r0n3/Raspyjack /opt/raspyjack-tmp \
    && mv /opt/raspyjack-tmp/* /opt/raspyjack/ \
    && mv /opt/raspyjack-tmp/.* /opt/raspyjack/ 2>/dev/null \
    || echo "git clone failed"
fi

# ── 3. Mirror SSH key to peta + raspyjack user (when raspyjack creates one) ──
step "Mirror SSH key to other users so we can SSH as them after raspyjack install"
for user in pi peta; do
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

# ── 5. Flipper bridge sanity check ──
step "Verify Flipper bridge is callable"
if [ -x /opt/jacktheflipper/flipper-bridge.py ]; then
  /opt/jacktheflipper/flipper-bridge.py list || true
else
  echo "ERROR: /opt/jacktheflipper/flipper-bridge.py not executable or missing"
fi

# ── 6. Reload udev for Flipper symlink ──
step "udev reload (for /dev/flipper symlink)"
udevadm control --reload-rules || true
udevadm trigger || true

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
