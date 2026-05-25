#!/bin/bash
# pi-zero2-kiosk — phase 2 install. Runs once on first network-up boot
# via /etc/systemd/system/pi-zero2-kiosk-install.service.
#
# Pi Zero 2 W variant of sinsera-kiosk. Same structure but:
#   - target URL is https://sinsera.co/ark/ (not the marketing root)
#   - Chromium runs with extra memory-saving flags for the A53 SoC
#   - 30 s grace before Chromium launches at first paint so the UI
#     can actually load (sinsera.co/ark is heavy + the Pi is slow)

set +e
exec > >(tee -a /var/log/pi-zero2-kiosk-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " pi-zero2-kiosk phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"

step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 0. full-upgrade first so the base is current ──
step "apt-get update + full system upgrade"
for try in 1 2 3; do
  if apt-get update -y; then break; fi
  echo "apt-get update attempt $try failed; sleeping 15s"; sleep 15
done
DEBIAN_FRONTEND=noninteractive apt-get -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  full-upgrade || echo "WARN: full-upgrade had non-fatal issues; continuing"
apt-get -y autoremove || true

# ── 1. kiosk deps ──
step "apt-get install chromium + X11 + openbox"
APT_OK=0
for try in 1 2 3; do
  if DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
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

# ── 3. kiosk shell + X session + openbox autostart ──
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
# Chromium flags tuned for Pi Zero 2 W:
#   --no-sandbox             — Pi 5 GPU sandbox crash-loop fix, also helps on Pi Zero
#   --process-per-site       — fewer renderer processes, lower mem
#   --renderer-process-limit=1
#   --disable-extensions
#   --disable-translate / etc — drop UI overhead
#   --no-default-browser-check
cat > /home/kiosk/.config/openbox/autostart <<EOF
#!/bin/sh
xset -dpms
xset s off
xset s noblank
unclutter -idle 0.1 -root &
# Let Pi finish bringing up network + cache before launching the slow browser
sleep 5
exec ${CHROMIUM_BIN} \\
  --kiosk \\
  --no-sandbox \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=Translate \\
  --disable-extensions \\
  --process-per-site \\
  --renderer-process-limit=1 \\
  --check-for-update-interval=31536000 \\
  --overscroll-history-navigation=0 \\
  --autoplay-policy=no-user-gesture-required \\
  --no-first-run \\
  --no-default-browser-check \\
  --start-fullscreen \\
  https://sinsera.co/ark/
EOF
chmod +x /home/kiosk/.config/openbox/autostart
chown -R kiosk:kiosk /home/kiosk/.config

cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=no
EOF

# ── 4. GPU memory split (helps Chromium on Pi Zero 2 W) ──
step "Bump GPU memory split to 128MB"
CFG=/boot/firmware/config.txt
[ -f "$CFG" ] || CFG=/boot/config.txt
if [ -f "$CFG" ]; then
  if grep -q "^gpu_mem=" "$CFG"; then
    sed -i "s/^gpu_mem=.*/gpu_mem=128/" "$CFG"
  else
    echo "gpu_mem=128" >> "$CFG"
  fi
fi

# ── 5. Disable self ──
step "Disable pi-zero2-kiosk-install.service"
systemctl disable pi-zero2-kiosk-install.service 2>/dev/null || true

# ── 6. MOTD ──
cat > /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Pi Zero 2 W kiosk  →  https://sinsera.co/ark/                ║
  ║                                                               ║
  ║  Auto-launches Chromium --kiosk on tty1 at boot.              ║
  ║  Headless / SSH access: kiosk_admin@pi-zero2-kiosk.local      ║
  ║                                                               ║
  ║  To restart Chromium: pkill -KILL chromium  (autostart relaunches)
  ║  To exit kiosk for maintenance: Ctrl-Alt-F2 to switch tty     ║
  ║  Install log: /var/log/pi-zero2-kiosk-install.log             ║
  ║                                                               ║
  ║  First paint of sinsera.co/ark is slow on this hardware       ║
  ║  (single-core A53). Give it ~20-30 s after boot.              ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

step "DONE — rebooting in 5s into kiosk mode"
echo "════════════════════════════════════════════════════════════════"
echo " pi-zero2-kiosk phase-2 install complete $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
sync
( sleep 5; systemctl reboot ) &
exit 0
