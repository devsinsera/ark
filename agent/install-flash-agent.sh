#!/usr/bin/env bash
# Install the Ark Flash Agent on a Pi. Run as root.
#
# Required env:
#   HUB_URL — e.g. http://192.168.4.124:7400
# Optional env:
#   NODE_NAME, LISTEN_PORT (default 7410)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root" >&2; exit 1
fi
if [[ -z "${HUB_URL:-}" ]]; then
  echo "ERROR: HUB_URL is required (e.g. http://192.168.4.124:7400)" >&2; exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_NAME="${NODE_NAME:-$(hostname)}"
LISTEN_PORT="${LISTEN_PORT:-7410}"

echo "→ installing system deps (python3, pip, bmaptool, parted)"
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-venv parted util-linux mount \
  bmap-tools || apt-get install -y bmaptool || true

echo "→ creating venv at /opt/ark-flash"
mkdir -p /opt/ark-flash /var/lib/ark-flash/images
python3 -m venv /opt/ark-flash/venv
/opt/ark-flash/venv/bin/pip install --upgrade pip
/opt/ark-flash/venv/bin/pip install fastapi 'uvicorn[standard]' python-multipart

echo "→ copying agent"
install -m 0755 "$SRC_DIR/ark-flash-agent.py" /opt/ark-flash/ark-flash-agent.py

cat > /etc/ark-flash-agent.env <<EOF
ARK_HUB_URL=${HUB_URL}
ARK_FLASH_NODE_NAME=${NODE_NAME}
ARK_FLASH_LISTEN_PORT=${LISTEN_PORT}
EOF
chmod 0644 /etc/ark-flash-agent.env

cat > /etc/systemd/system/ark-flash-agent.service <<'EOF'
[Unit]
Description=Ark Flash Agent — network imaging appliance
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/ark-flash-agent.env
ExecStart=/opt/ark-flash/venv/bin/python /opt/ark-flash/ark-flash-agent.py
Restart=on-failure
RestartSec=5
User=root

# Needs raw block-device access for writes. Don't tighten ProtectSystem
# beyond what's compatible with bmaptool / dd.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ark-flash-agent.service
sleep 2

if systemctl is-active --quiet ark-flash-agent.service; then
  echo "✓ ark-flash-agent listening on :${LISTEN_PORT}"
  echo "  Logs: journalctl -u ark-flash-agent -f"
  echo "  Health: curl http://localhost:${LISTEN_PORT}/healthz"
else
  echo "✗ ark-flash-agent failed to start"
  journalctl -u ark-flash-agent -n 30 --no-pager
  exit 1
fi
