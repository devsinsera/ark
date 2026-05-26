#!/bin/bash
# deploy.sh — rsync this app to the Pi 5 + restart the service.
#
# Usage:  bash deploy.sh
#         PI_HOST=192.168.4.169 bash deploy.sh    # override target
#
# Idempotent. Skips unchanged files. ~1-2 sec on LAN.

set -euo pipefail

PI_HOST="${PI_HOST:-brocoli@thehauntedbrocoli.local}"
REMOTE_DIR="/opt/brocoli-app"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[deploy] rsync $REPO_DIR → $PI_HOST:$REMOTE_DIR"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.log' \
  "$REPO_DIR/" "$PI_HOST:$REMOTE_DIR/"

echo "[deploy] restart service"
ssh "$PI_HOST" 'sudo -n systemctl restart thehauntedbrocoli-app.service && sudo -n systemctl is-active thehauntedbrocoli-app.service'

echo "[deploy] health"
ssh "$PI_HOST" 'curl -sS --max-time 4 http://localhost:8080/api/health'
echo
echo "[deploy] done"
