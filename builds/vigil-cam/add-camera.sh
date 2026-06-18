#!/bin/bash
# add-camera.sh — spin up an additional Vigil camera instance on this Pi.
# The vigil app is fully env-driven, so a 2nd+ camera is just its own .env + service.
#
#   sudo ./add-camera.sh <slug> [video_index] [mjpeg_port]
#   e.g.  sudo ./add-camera.sh garage 2 8091
#
# Needs a 2nd USB camera present at /dev/video<index> (use a USB hub on the Zero 2 W,
# which has a single data port) — or run this on a second Pi. It registers a new
# camera row (slug) in Vigil, so it appears in sinsera.co/vigil automatically.
set -e
SLUG="${1:?usage: add-camera.sh <slug> [video_index] [mjpeg_port]}"
IDX="${2:-2}"; PORT="${3:-8091}"
ENV="/opt/vigil/${SLUG}.env"

cp /opt/vigil/.env "$ENV"
sed -i '/^CAMERA_SLUG=/d;/^CAMERA_LABEL=/d;/^CAM_INDEX=/d;/^MJPEG_PORT=/d;/^RECORD_DIR=/d' "$ENV"
{
  echo "CAMERA_SLUG=${SLUG}"
  echo "CAMERA_LABEL=$(echo "$SLUG" | tr 'a-z-' 'A-Z ')"
  echo "CAM_INDEX=${IDX}"
  echo "MJPEG_PORT=${PORT}"
  echo "RECORD_DIR=/opt/vigil/recordings-${SLUG}"
} >> "$ENV"
chown vigil:vigil "$ENV"; chmod 600 "$ENV"
mkdir -p "/opt/vigil/recordings-${SLUG}"; chown vigil:vigil "/opt/vigil/recordings-${SLUG}"

cat > "/etc/systemd/system/vigil-${SLUG}.service" <<EOF
[Unit]
Description=Vigil camera (${SLUG})
After=network-online.target bluetooth.target

[Service]
User=vigil
EnvironmentFile=${ENV}
ExecStart=/usr/bin/python3 /opt/vigil/vigil_cam.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "vigil-${SLUG}"
echo "✅ camera '${SLUG}' up on :${PORT} (/dev/video${IDX}) — registers in Vigil within ~30s"
