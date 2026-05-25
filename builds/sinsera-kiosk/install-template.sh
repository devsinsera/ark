#!/bin/bash
# Sinsera Kiosk — Ark install plan.
#
# Strategy: the heavy install (Chromium + X stack) happens at FIRST
# BOOT on the Pi, not in the chroot — the chroot rootfs only has
# ~200 MB free and Chromium needs more. We drop a custom script
# that DietPi runs at the end of its first-boot setup (once the
# rootfs has been expanded to fill the SD).
#
# After flashing + first boot:
#   - DietPi first-boot setup (~60 s) — expands rootfs, sets up WiFi
#   - DietPi runs /boot/firmware/Automation_Custom_Script.sh below
#   - apt-installs chromium + xorg + openbox + helpers (~3-5 min)
#   - configures kiosk user + autologin + .xinitrc + openbox autostart
#   - reboots
#   - kiosk user auto-logs into tty1
#   - .bash_profile execs startx
#   - openbox session starts
#   - Chromium --kiosk loads https://sinsera.co/
#
# Diagnostic log on the Pi: /var/log/sinsera-kiosk-install.log

set -e
set -o pipefail

LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/builds /ark/registry
echo "[ark] install plan begin: sinsera-kiosk" | tee -a "$LOG"

ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
ark_run() { ark_log "RUN: $*"; "$@" 2>&1 | tee -a "$LOG"; }

# ── Detect where the boot partition is mounted in the chroot ──
BOOT_DIR=""
for cand in /boot/firmware /boot; do
  if [[ -d "$cand" ]] && [[ -f "$cand/cmdline.txt" || -f "$cand/dietpi.txt" || -f "$cand/config.txt" ]]; then
    BOOT_DIR="$cand"
    break
  fi
done
if [[ -z "$BOOT_DIR" ]]; then
  ark_log "ERROR: could not find boot partition in chroot"
  exit 1
fi
ark_log "boot partition at: $BOOT_DIR"

# ── Write the FIRST-BOOT kiosk setup as Automation_Custom_Script.sh ──
# Notes on robustness:
#   - NO `set -e` here so a single apt failure doesn't abandon the
#     entire setup. Each step logs its own success/failure.
#   - apt-get retries up to 3× before giving up — first-boot can
#     coincide with the WiFi association still settling.
#   - Both `chromium` and `chromium-browser` are accepted (Debian
#     Trixie ships both; the symlink can vary by release).
#   - --no-sandbox flag in the kiosk launcher avoids the Pi-5 GPU /
#     Chromium-sandbox crash-loop.
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'KIOSK_FIRSTBOOT'
#!/bin/bash
# Sinsera Kiosk — DietPi Automation_Custom_Script.sh
# Runs ONCE at the end of DietPi first-boot setup.

exec > >(tee -a /var/log/sinsera-kiosk-install.log) 2>&1
echo "[sinsera-kiosk] starting first-boot install $(date -u +%H:%M:%S)"

step() { echo ""; echo "[sinsera-kiosk] ── $* ──"; }

# ── 1. apt-get with retries ──
step "apt-get update + install kiosk deps"
APT_OK=0
for try in 1 2 3; do
  if apt-get update -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         chromium chromium-sandbox \
         xserver-xorg xserver-xorg-input-libinput xinit \
         x11-xserver-utils \
         openbox \
         unclutter \
         fonts-liberation \
         ca-certificates; then
    APT_OK=1
    echo "[sinsera-kiosk] apt-get install OK on try $try"
    break
  fi
  echo "[sinsera-kiosk] apt-get attempt $try failed; sleeping 15s"
  sleep 15
done
if [ "$APT_OK" != 1 ]; then
  # Some Debian/DietPi mirrors use chromium-browser instead of chromium.
  echo "[sinsera-kiosk] retrying with chromium-browser package name"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    chromium-browser xserver-xorg xinit openbox unclutter || \
    echo "[sinsera-kiosk] ERROR: apt-get install never succeeded; SSH in and re-run manually"
fi

# Decide which chromium binary actually exists.
CHROMIUM_BIN=""
for cand in /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -x "$cand" ] && CHROMIUM_BIN="$cand" && break
done
if [ -z "$CHROMIUM_BIN" ]; then
  echo "[sinsera-kiosk] WARN: no chromium binary found — autostart will fail."
  CHROMIUM_BIN="/usr/bin/chromium"
fi
echo "[sinsera-kiosk] chromium binary: $CHROMIUM_BIN"

# ── 2. kiosk user ──
step "kiosk user + autologin"
if ! id kiosk >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash \
    --groups video,audio,input,tty,plugdev,netdev,render kiosk
  passwd -l kiosk
  echo "[sinsera-kiosk] kiosk user created"
else
  echo "[sinsera-kiosk] kiosk user already exists"
fi

mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/ark-autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
EOF
systemctl daemon-reload
systemctl enable getty@tty1.service

# ── 3. .bash_profile + .xinitrc ──
step ".bash_profile + .xinitrc + openbox config"
cat > /home/kiosk/.bash_profile <<'EOF'
if [[ -z "$DISPLAY" && $(tty) == /dev/tty1 ]]; then
  exec startx
fi
EOF
chown kiosk:kiosk /home/kiosk/.bash_profile

cat > /home/kiosk/.xinitrc <<'EOF'
#!/bin/sh
exec openbox-session
EOF
chmod +x /home/kiosk/.xinitrc
chown kiosk:kiosk /home/kiosk/.xinitrc

# ── 4. openbox autostart — Chromium kiosk ──
mkdir -p /home/kiosk/.config/openbox
# Substitute the actual chromium binary into the autostart script so
# we don't rely on $PATH resolution at user-session time.
cat > /home/kiosk/.config/openbox/autostart <<EOF
#!/bin/sh
# Sinsera Kiosk — openbox autostart
xset -dpms
xset s off
xset s noblank
unclutter -idle 0.1 -root &
exec ${CHROMIUM_BIN} \\
  --kiosk \\
  --no-sandbox \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=Translate \\
  --check-for-update-interval=31536000 \\
  --overscroll-history-navigation=0 \\
  --autoplay-policy=no-user-gesture-required \\
  --no-first-run \\
  --start-fullscreen \\
  https://sinsera.co/
EOF
chmod +x /home/kiosk/.config/openbox/autostart
chown -R kiosk:kiosk /home/kiosk/.config

# Allow any user to start X (so kiosk can without sudo).
cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=no
EOF

# ── 5. Tailscale (optional) ──
TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
if [ -n "$TS_AUTHKEY" ]; then
  step "Tailscale"
  for i in 1 2 3 4 5 6; do
    curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts.sh && break
    echo "[sinsera-kiosk] tailscale fetch retry $i"; sleep 10
  done
  if [ -f /tmp/ts.sh ]; then
    sh /tmp/ts.sh
    tailscale up --auth-key="$TS_AUTHKEY" --hostname="sinsera-kiosk" --ssh --accept-routes \
      || echo "[sinsera-kiosk] tailscale up failed"
    rm -f /tmp/ts.sh
  fi
fi

step "done — rebooting in 5s"
echo "[sinsera-kiosk] install complete $(date -u +%H:%M:%S)"
# DietPi reboots automatically after this script returns, BUT also
# schedule an explicit reboot in case DietPi's reboot trigger missed
# this run.
( sleep 5; systemctl reboot ) &
KIOSK_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# ── Tweak dietpi.txt: WiFi + autostart + kiosk-user autologin ──
# Critical flags:
#   AUTO_SETUP_CUSTOM_SCRIPT_EXEC=1  — actually run Automation_Custom_Script.sh
#   AUTO_SETUP_AUTOSTART_TARGET_INDEX=7 — console autologin (NOT 1, which is
#                                         manual login)
#   AUTO_SETUP_AUTOSTART_LOGIN_USER='kiosk' — autologin as the kiosk user
if [[ -f "$BOOT_DIR/dietpi.txt" ]]; then
  ark_log "tuning $BOOT_DIR/dietpi.txt for kiosk role"
  set_dp() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$BOOT_DIR/dietpi.txt"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$BOOT_DIR/dietpi.txt"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$BOOT_DIR/dietpi.txt"
    fi
  }
  set_dp AUTO_SETUP_NET_HOSTNAME            'SinseraKiosk'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED        '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE   'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID           'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY            'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE                'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                  'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT         'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX        '-1'
  set_dp AUTO_SETUP_ACCEPT_LICENSE          '1'
  set_dp SURVEY_OPTED_IN                    '0'
  # Run our custom script at the end of first-boot — this is the bit
  # that was missing on the previous build of this image.
  set_dp AUTO_SETUP_CUSTOM_SCRIPT_EXEC      '1'
  # Console autologin as the kiosk user. TARGET_INDEX=7 (autologin)
  # not 1 (manual login). Our getty drop-in inside the first-boot
  # script handles the same thing belt-and-braces, but having DietPi
  # configure it directly is more reliable.
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX  '7'
  set_dp AUTO_SETUP_AUTOSTART_LOGIN_USER    'kiosk'
  # Disable serial console prompt
  sed -i 's/^AUTO_SETUP_SERIAL_CONSOLE_ENABLE=.*/AUTO_SETUP_SERIAL_CONSOLE_ENABLE=0/' "$BOOT_DIR/dietpi.txt" || true
fi

# ── SSH public key (root) — baked by bake-creds.sh ──
ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# ── FINALISE — registry marker ──
mkdir -p /ark/registry
printf '{"name":"sinsera-kiosk","version":"2","installed_at":"%s","kiosk_url":"https://sinsera.co/","profile":"sinsera-kiosk","strategy":"first-boot-install"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-kiosk.json
ark_log "registered sinsera-kiosk v2"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Kiosk image baked (v2 — robust first-boot)."
ark_log "  1. Flash + boot. First boot ~5-10 min (Chromium install)."
ark_log "  2. Pi auto-reboots, kiosk user autologins, Chromium opens"
ark_log "     fullscreen on https://sinsera.co/."
ark_log "  Diagnostic log on the Pi: /var/log/sinsera-kiosk-install.log"
ark_log "================================================================"
exit 0
