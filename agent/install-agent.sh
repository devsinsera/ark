#!/usr/bin/env bash
# Install the Ark Agent on a Pi. Idempotent: re-run to upgrade.
#
# Usage on a freshly-flashed Pi:
#   curl -fsSL <url-to-this-script> | sudo HUB_URL=http://10.0.0.50:7400 bash
#
# Or, when invoked by the Ark installer engine at first boot:
#   sudo HUB_URL=$ARK_HUB_URL bash /ark/agent/install-agent.sh
#
# Required env:
#   HUB_URL              — e.g. http://192.168.4.124:7400
# Optional env:
#   AGENT_INTERVAL_S     — default 30
#   MANIFEST_ID          — link the device to its build manifest
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)" >&2
  exit 1
fi
if [[ -z "${HUB_URL:-}" ]]; then
  echo "ERROR: HUB_URL is required (e.g. http://192.168.4.124:7400)" >&2
  exit 1
fi

AGENT_INTERVAL_S="${AGENT_INTERVAL_S:-30}"
MANIFEST_ID="${MANIFEST_ID:-}"

# Repo root: this script lives at agent/ when running from a clone,
# or at /ark/agent/ when staged by the installer engine. Resolve from
# script location.
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_PY="${SRC_DIR}/ark-agent.py"
UNIT_FILE="${SRC_DIR}/ark-agent.service"

if [[ ! -f "$AGENT_PY" ]]; then
  echo "ERROR: $AGENT_PY not found" >&2; exit 1
fi
if [[ ! -f "$UNIT_FILE" ]]; then
  echo "ERROR: $UNIT_FILE not found" >&2; exit 1
fi

# Make sure python3 is available — the agent is stdlib-only so this is
# the only dep. The Ark installer engine usually has installed this by
# the time we get here, but be defensive.
if ! command -v python3 >/dev/null 2>&1; then
  echo "→ installing python3"
  apt-get update -y
  apt-get install -y python3
fi

echo "→ copying agent to /usr/local/bin/ark-agent.py"
install -m 0755 "$AGENT_PY" /usr/local/bin/ark-agent.py

echo "→ writing /etc/ark-agent.env"
cat > /etc/ark-agent.env <<EOF
ARK_HUB_URL=${HUB_URL}
ARK_AGENT_INTERVAL_S=${AGENT_INTERVAL_S}
$( [[ -n "$MANIFEST_ID" ]] && echo "ARK_MANIFEST_ID=${MANIFEST_ID}" )
EOF
chmod 0644 /etc/ark-agent.env

echo "→ installing systemd unit"
install -m 0644 "$UNIT_FILE" /etc/systemd/system/ark-agent.service

systemctl daemon-reload
systemctl enable --now ark-agent.service

# Wait a moment + verify
sleep 2
if systemctl is-active --quiet ark-agent.service; then
  echo "✓ ark-agent.service is running. Logs: journalctl -u ark-agent -f"
else
  echo "✗ ark-agent.service failed to start. Last 20 log lines:"
  journalctl -u ark-agent -n 20 --no-pager
  exit 1
fi
