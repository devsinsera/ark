#!/bin/bash
# mirrorloop-kiosk — phase 2 install. Runs once on first network-up boot via
# /etc/systemd/system/mirrorloop-kiosk-install.service.
#
# Target: Raspberry Pi Zero 2 W + Logitech C920 USB webcam, HDMI to a TV.
# Launches the Mirror Loop Pygame renderer FULLSCREEN on the framebuffer
# (SDL kmsdrm — NO X, NO Chromium; a 512 MB Zero 2 W can't run Chromium well).
# The renderer also posts heartbeats/sessions to sinsera.co/mirrorloop via
# telemetry.py once MIRROR_PASSWORD is filled in /opt/mirror-loop/.env.
#
# The app itself is baked to /opt/mirror-loop/ by the bake script. This script
# only installs deps + wires autologin/autostart.
#
# Logs to /var/log/mirrorloop-kiosk-install.log.
# ssh peta@mirrorloop-kiosk.local 'tail -f /var/log/mirrorloop-kiosk-install.log'

set +e
exec > >(tee -a /var/log/mirrorloop-kiosk-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " mirrorloop-kiosk phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"

step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 1. apt update + Python CV/Pygame stack (NO Chromium/X) ──
step "apt-get update + install Mirror Loop deps"
APT_OK=0
for try in 1 2 3 4; do
  if apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 python3-pip \
       python3-opencv \
       python3-pygame \
       python3-numpy \
       python3-requests \
       python3-dotenv \
       python3-pil \
       libsdl2-2.0-0 \
       v4l-utils \
       fonts-dejavu-core \
       ca-certificates; then
    APT_OK=1; echo "apt-get install OK on try $try"; break
  fi
  echo "apt-get attempt $try failed; sleeping 20s"; sleep 20
done
if [ "$APT_OK" != 1 ]; then
  echo "ERROR: apt-get install never succeeded. Re-run install.sh after fixing network."
  exit 1
fi

# ── 1b. locale (avoid LC_* warnings) ──
step "locale en_AU.UTF-8"
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
locale-gen 2>/dev/null || true
update-locale LANG=en_AU.UTF-8 2>/dev/null || true

# ── 1c. swap bump — 512 MB headroom for OpenCV/Pygame on a 512 MB board ──
step "increase swap to 512 MB (Zero 2 W headroom)"
if [ -f /etc/dphys-swapfile ]; then
  sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/' /etc/dphys-swapfile
  dphys-swapfile setup 2>/dev/null || true
  dphys-swapfile swapon 2>/dev/null || true
fi

# ── 1d. HDMI: force output even if the TV is off/late at boot ──
step "HDMI force-hotplug for the Bravia"
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ] && ! grep -q "mirrorloop-kiosk" "$BOOTCFG"; then
  cat >> "$BOOTCFG" <<'EOF'

# ── mirrorloop-kiosk ──
# Output HDMI even if the TV is off or slow to handshake at boot (the KMS
# driver still honours hotplug; this helps the firmware stage on a Bravia).
hdmi_force_hotplug=1
disable_overscan=1
EOF
fi

# ── 2. 'mirror' user with tty1 autologin ──
step "mirror user + autologin"
if ! id mirror >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash \
    --groups video,audio,input,tty,render,plugdev,netdev,dialout mirror
  passwd -l mirror
  echo "mirror user created"
fi

mkdir -p /etc/systemd/system/getty@tty1.service.d
# Own the canonical autologin drop-in so 'mirror' reliably logs in on tty1.
rm -f /etc/systemd/system/getty@tty1.service.d/ark-autologin.conf
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin mirror --noclear %I \$TERM
EOF
systemctl daemon-reload
systemctl enable getty@tty1.service

# ── 3. autostart the renderer on tty1 login ──
step "mirror .bash_profile → run-mirror-loop.sh"
chmod +x /opt/mirror-loop/run-mirror-loop.sh 2>/dev/null || true
cat > /home/mirror/.bash_profile <<'EOF'
# Launch Mirror Loop fullscreen on tty1 autologin. Other ttys get a shell.
if [[ -z "$DISPLAY" && $(tty) == /dev/tty1 ]]; then
  exec /opt/mirror-loop/run-mirror-loop.sh
fi
EOF
chown mirror:mirror /home/mirror/.bash_profile

# Log file the launcher + renderer append to.
touch /var/log/mirror-loop.log
chown mirror:mirror /var/log/mirror-loop.log

# ── 4. disable self ──
step "disable mirrorloop-kiosk-install.service"
systemctl disable mirrorloop-kiosk-install.service 2>/dev/null || true

# ── 5. MOTD ──
cat > /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Mirror Loop Kiosk  —  Pi Zero 2 W + C920 → TV                ║
  ║                                                               ║
  ║  Pygame renderer auto-launches on tty1 (SDL kmsdrm, no X).    ║
  ║  Telemetry → sinsera.co/mirrorloop once MIRROR_PASSWORD set:  ║
  ║    sudo nano /opt/mirror-loop/.env   (fill MIRROR_PASSWORD)   ║
  ║  SSH: peta@mirrorloop-kiosk.local                             ║
  ║  Restart app: sudo systemctl restart getty@tty1              ║
  ║  App log:     /var/log/mirror-loop.log                        ║
  ║  Install log: /var/log/mirrorloop-kiosk-install.log          ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

step "DONE — rebooting in 5s into Mirror Loop"
echo "════════════════════════════════════════════════════════════════"
echo " mirrorloop-kiosk phase-2 install complete $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
sync
( sleep 5; systemctl reboot ) &
exit 0
