#!/bin/bash
# sinsera-kiosk — phase 2 install. Runs once on first network-up boot
# via /etc/systemd/system/sinsera-kiosk-install.service.
#
# What it does:
#   1. apt-installs Chromium + X11 minimal stack + helpers
#   2. Creates a 'kiosk' user with autologin on tty1
#   3. Writes .bash_profile (startx on tty1), .xinitrc (openbox), and
#      openbox autostart that launches Chromium --kiosk on sinsera.co
#   4. Allows non-root users to start X
#   5. Disables itself, reboots into kiosk mode
#
# Logs to /var/log/sinsera-kiosk-install.log.
# ssh peta@sinsera-kiosk.local 'tail -f /var/log/sinsera-kiosk-install.log'

set +e
exec > >(tee -a /var/log/sinsera-kiosk-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " sinsera-kiosk phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"

step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 1. apt update + Chromium + X11 minimal stack ──
step "apt-get update + install kiosk deps"
APT_OK=0
for try in 1 2 3; do
  if apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       chromium chromium-sandbox \
       xserver-xorg xserver-xorg-input-libinput xinit \
       x11-xserver-utils \
       openbox \
       unclutter \
       fonts-liberation \
       ca-certificates; then
    APT_OK=1; echo "apt-get install OK on try $try"; break
  fi
  echo "apt-get attempt $try failed; sleeping 15s"; sleep 15
done
if [ "$APT_OK" != 1 ]; then
  echo "ERROR: apt-get install never succeeded. Re-run install.sh after fixing network."
  exit 1
fi

# Resolve chromium binary (Debian Trixie has both 'chromium' + 'chromium-browser' names)
CHROMIUM_BIN=""
for cand in /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -x "$cand" ] && CHROMIUM_BIN="$cand" && break
done
[ -z "$CHROMIUM_BIN" ] && CHROMIUM_BIN="/usr/bin/chromium"
echo "chromium binary: $CHROMIUM_BIN"

# ── 2. kiosk user with tty1 autologin ──
step "kiosk user + autologin"
if ! id kiosk >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash \
    --groups video,audio,input,tty,plugdev,netdev,render kiosk
  passwd -l kiosk
  echo "kiosk user created"
fi

mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/ark-autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
EOF
systemctl daemon-reload
systemctl enable getty@tty1.service

# ── 3. kiosk user shell + X session ──
step ".bash_profile + .xinitrc + openbox autostart"
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

mkdir -p /home/kiosk/.config/openbox
cat > /home/kiosk/.config/openbox/autostart <<EOF
#!/bin/sh
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

# Allow any user to start X
cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=no
EOF

# ── 4. Disable self ──
step "Disable sinsera-kiosk-install.service"
systemctl disable sinsera-kiosk-install.service 2>/dev/null || true

# ── 5. MOTD ──
cat > /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Sinsera Kiosk  —  Pi 5 → https://sinsera.co/                 ║
  ║                                                               ║
  ║  Auto-launches Chromium --kiosk on tty1 at boot.              ║
  ║  Headless / SSH access: peta@sinsera-kiosk.local              ║
  ║                                                               ║
  ║  To restart Chromium: pkill -KILL chromium  (autostart relaunches)
  ║  To exit kiosk for maintenance: Ctrl-Alt-F2 to switch tty     ║
  ║  Install log: /var/log/sinsera-kiosk-install.log              ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

step "DONE — rebooting in 5s into kiosk mode"
echo "════════════════════════════════════════════════════════════════"
echo " sinsera-kiosk phase-2 install complete $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
sync
( sleep 5; systemctl reboot ) &
exit 0
