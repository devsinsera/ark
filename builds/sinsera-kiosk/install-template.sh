#!/bin/bash
# Sinsera Kiosk — Ark install plan.
#
# Strategy: this script runs in the chroot during the Ark image build.
# Since the DietPi base partition is only big enough for the base
# install (~1 GB), we can't apt-install chromium during the chroot —
# disk runs out. Instead, we drop a /boot/Automation_Custom_Script.sh
# (DietPi convention) that DietPi runs at the END of its first-boot
# setup, AFTER the rootfs has been expanded to fill the entire SD
# card. At that point there's plenty of disk space.
#
# So the chroot is fast (just file writes) and the actual chromium
# install happens on the Pi at first boot (~3-5 min added to boot).
#
# After flashing and booting:
#   - DietPi runs first-boot setup (~60 s)
#   - DietPi expands rootfs to fill SD
#   - DietPi runs /boot/Automation_Custom_Script.sh below
#   - System reboots
#   - kiosk user auto-logs into tty1
#   - .bash_profile execs startx
#   - openbox session starts
#   - Chromium --kiosk loads https://sinsera.co/

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
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'KIOSK_FIRSTBOOT'
#!/bin/bash
# Sinsera Kiosk — DietPi Automation_Custom_Script.sh
# Runs ONCE at the end of DietPi first-boot setup, after partition
# expansion. Installs Chromium + X stack and configures auto-launch
# into kiosk mode pointed at https://sinsera.co/.

set -e
exec > >(tee -a /var/log/sinsera-kiosk-install.log) 2>&1
echo "[sinsera-kiosk] starting first-boot install $(date)"

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  chromium chromium-sandbox \
  xserver-xorg xserver-xorg-input-libinput xinit \
  x11-xserver-utils \
  openbox \
  unclutter \
  fonts-liberation \
  ca-certificates

# ── kiosk user with autologin on tty1 ──
if ! id kiosk >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash \
    --groups video,audio,input,tty,plugdev,netdev kiosk
  passwd -l kiosk   # disable password login; only tty1 autologin
fi

mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/ark-autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
EOF
systemctl daemon-reload

# ── bash_profile: only launches X on tty1 ──
cat > /home/kiosk/.bash_profile <<'EOF'
if [[ -z "$DISPLAY" && $(tty) == /dev/tty1 ]]; then
  exec startx
fi
EOF
chown kiosk:kiosk /home/kiosk/.bash_profile

# ── X session → openbox ──
cat > /home/kiosk/.xinitrc <<'EOF'
#!/bin/sh
exec openbox-session
EOF
chmod +x /home/kiosk/.xinitrc
chown kiosk:kiosk /home/kiosk/.xinitrc

# ── openbox autostart launches Chromium kiosk ──
mkdir -p /home/kiosk/.config/openbox
cat > /home/kiosk/.config/openbox/autostart <<'EOF'
#!/bin/sh
# Sinsera Kiosk — openbox autostart
xset -dpms
xset s off
xset s noblank
unclutter -idle 0.1 -root &
exec chromium \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --start-fullscreen \
  https://sinsera.co/
EOF
chmod +x /home/kiosk/.config/openbox/autostart
chown -R kiosk:kiosk /home/kiosk/.config

# Allow any user to start X (so the kiosk user can without sudo)
cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=no
EOF

# ── Tailscale (optional) — joins tailnet so you can SSH from anywhere.
# Authkey baked at build time by bake-creds.sh from ~/.ark/tailscale.env.
# Empty placeholder → block is a no-op.
TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
if [ -n "$TS_AUTHKEY" ]; then
  echo "[sinsera-kiosk] installing Tailscale + joining tailnet"
  for i in 1 2 3 4 5 6; do
    curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts.sh && break
    echo "[sinsera-kiosk] tailscale fetch retry $i (waiting for network)…"; sleep 10
  done
  if [ -f /tmp/ts.sh ]; then
    sh /tmp/ts.sh
    tailscale up --auth-key="$TS_AUTHKEY" --hostname="sinsera-kiosk" --ssh --accept-routes \
      || echo "[sinsera-kiosk] tailscale up failed (check authkey + tailnet ACLs)"
    rm -f /tmp/ts.sh
  fi
fi

echo "[sinsera-kiosk] install complete; rebooting into kiosk mode"
# DietPi will reboot after this script returns. The kiosk user
# autologin + openbox autostart picks up from there.
KIOSK_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# ── Tweak dietpi.txt: WiFi + SSH key + autologin ──
# Auto-join the operator's WiFi on first boot (creds baked in by
# bake-creds.sh from ~/.ark/wifi.env). Plus the autologin/console
# tweaks already in this template.
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
  set_dp AUTO_SETUP_NET_HOSTNAME           'SinseraKiosk'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED       '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE  'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID          'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY           'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE               'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                 'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT        'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX       '-1'
  set_dp AUTO_SETUP_ACCEPT_LICENSE         '1'
  # Disable serial console prompt + DietPi survey
  sed -i 's/^AUTO_SETUP_SERIAL_CONSOLE_ENABLE=.*/AUTO_SETUP_SERIAL_CONSOLE_ENABLE=0/' "$BOOT_DIR/dietpi.txt" || true
  set_dp SURVEY_OPTED_IN                   '0'
  # Headless-style autostart: console autologin (the kiosk user
  # autologin systemd unit overrides this anyway, but having
  # AUTO_SETUP_AUTOSTART_TARGET_INDEX=1 prevents DietPi from trying
  # to install a desktop environment we don't need.)
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX '1'
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
printf '{"name":"sinsera-kiosk","version":"1","installed_at":"%s","kiosk_url":"https://sinsera.co/","profile":"sinsera-kiosk","strategy":"first-boot-install"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-kiosk.json
ark_log "registered sinsera-kiosk"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Kiosk image baked. Next steps for the operator:"
ark_log ""
ark_log "  1. dd / Etcher the produced .img onto an SD card."
ark_log "  2. (Optional) Pre-set WiFi in /boot/dietpi.txt before boot,"
ark_log "     or use Ethernet on first boot."
ark_log "  3. Power on. ~5-10 min for first-boot setup +"
ark_log "     /boot/Automation_Custom_Script.sh to install Chromium."
ark_log "  4. System reboots once; Chromium launches full-screen on"
ark_log "     https://sinsera.co/"
ark_log "================================================================"
exit 0
