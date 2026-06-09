#!/bin/bash
# vigil-cam — phase 2 install. Runs once on first network-up boot via
# /etc/systemd/system/vigil-cam-install.service.
#
# Target: Raspberry Pi Zero 2 W + Logitech C920 USB webcam. NO HDMI / NO LCD —
# a fully HEADLESS security camera. Captures the C920, runs frame-diff motion
# detection, serves a full-rate LAN MJPEG stream, and (once VIGIL_PASSWORD is
# set) uploads private snapshots + motion events to sinsera.co/vigil.
#
# The app is baked to /opt/vigil/ by the bake script; this only installs deps
# + the systemd service. Logs to /var/log/vigil-cam-install.log.

set +e
exec > >(tee -a /var/log/vigil-cam-install.log) 2>&1
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " vigil-cam phase-2 install starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
step() { echo ""; echo "── $(date -u +%H:%M:%S) · $* ──"; }

# ── 1. Python CV stack (NO pygame/SDL/X — headless) ──
step "apt-get update + install Vigil deps"
APT_OK=0
for try in 1 2 3 4; do
  if apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 python3-pip \
       python3-opencv \
       python3-numpy \
       python3-requests \
       python3-dotenv \
       v4l-utils \
       fonts-dejavu-core \
       ca-certificates; then
    APT_OK=1; echo "apt-get install OK on try $try"; break
  fi
  echo "apt-get attempt $try failed; sleeping 20s"; sleep 20
done
[ "$APT_OK" = 1 ] || { echo "ERROR: apt-get never succeeded — re-run install.sh after fixing network."; exit 1; }

# ── 1b. locale ──
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
locale-gen 2>/dev/null || true; update-locale LANG=en_AU.UTF-8 2>/dev/null || true

# ── 1c. swap bump (OpenCV headroom on a 512 MB board) ──
step "increase swap to 512 MB"
if [ -f /etc/dphys-swapfile ]; then
  sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/' /etc/dphys-swapfile
  dphys-swapfile setup 2>/dev/null || true; dphys-swapfile swapon 2>/dev/null || true
fi

# ── 1d. Headless: free RAM/GPU (no display) ──
step "headless tuning (gpu_mem low, no HDMI needed)"
BOOTCFG=/boot/firmware/config.txt; [ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ] && ! grep -q "vigil-cam" "$BOOTCFG"; then
  cat >> "$BOOTCFG" <<'EOF'

# ── vigil-cam (headless camera — no display) ──
gpu_mem=16
EOF
fi

# ── 2. 'vigil' service user (camera access, no login) ──
step "vigil user (+video group)"
if ! id vigil >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin --groups video,plugdev vigil
  echo "vigil user created"
fi
chmod +x /opt/vigil/run-vigil.sh 2>/dev/null || true
chown -R vigil:vigil /opt/vigil 2>/dev/null || true
touch /var/log/vigil.log && chown vigil:vigil /var/log/vigil.log

# ── 3. install + enable the vigil service ──
step "install vigil.service"
cp /opt/vigil/vigil.service /etc/systemd/system/vigil.service
systemctl daemon-reload
systemctl enable vigil.service

# ── 4. disable self ──
systemctl disable vigil-cam-install.service 2>/dev/null || true

# ── 5. MOTD ──
cat > /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  VIGIL  —  Security Camera (Pi Zero 2 W + C920, headless)     ║
  ║                                                               ║
  ║  LAN stream:  http://vigil-cam.local:8090/stream  (full-rate) ║
  ║  Private cloud feed → sinsera.co/vigil once you set the pass: ║
  ║    sudo nano /opt/vigil/.env   (fill VIGIL_PASSWORD)          ║
  ║    sudo systemctl restart vigil                               ║
  ║  SSH: peta@vigil-cam.local   ·   App log: /var/log/vigil.log  ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

step "DONE — rebooting in 5s into Vigil"
echo "════════════════════════════════════════════════════════════════"
echo " vigil-cam phase-2 install complete $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════════"
sync
( sleep 5; systemctl reboot ) &
exit 0
