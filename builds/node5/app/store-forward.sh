#!/bin/bash
# store-forward.sh — Node 5 (GR86) store-and-forward of the local OBD buffer.
#
# Mirrors the Node-4 Vigil archive pattern (memory: node4-recording-archive):
# a systemd timer runs this every few minutes; when the car is on HOME WiFi and
# Node 3's NVMe is reachable, rsync the local OBD buffer to Node 3, copy-only +
# idempotent so a mid-drive network drop never stalls logging.
#
# The live cloud path is handled by the bridge itself (it POSTs to Supabase when
# it has uplink). This script is the DURABLE second home for the raw buffer.
#
# SCAFFOLD NOTE: bridge.py currently batches in-memory and pushes to Supabase; it
# does not yet also append to BUF_DIR. Wiring the plumbing here (dir + timer +
# reachability guard + rsync) so that once the bridge writes JSONL to BUF_DIR the
# forwarding "just works". See README "known gaps".
set -euo pipefail

BUF_DIR="${GR86_BUF_DIR:-/var/lib/garage-obd/buffer}"
NODE3_HOST="${NODE3_HOST:-192.168.4.182}"          # Node 3 on the home LAN
NODE3_DEST="${NODE3_DEST:-/opt/garage-obd/node5}"  # chown peta:peta on Node 3
SSH_KEY="${GR86_SSH_KEY:-/home/peta/.ssh/id_ed25519}"

mkdir -p "$BUF_DIR"

# Only forward when Node 3's NVMe box is reachable (i.e. we're home). A hotspot /
# 4G uplink can't see 192.168.4.182, so this is naturally a no-op away from home.
if ! ping -c1 -W2 "$NODE3_HOST" >/dev/null 2>&1; then
  exit 0
fi

# Nothing buffered → done.
if [ -z "$(ls -A "$BUF_DIR" 2>/dev/null)" ]; then
  exit 0
fi

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8"

# Copy-only + idempotent: never delete the source on failure, skip existing.
rsync -a --ignore-existing --timeout=30 \
  -e "ssh $SSH_OPTS" \
  "$BUF_DIR"/ "peta@${NODE3_HOST}:${NODE3_DEST}/" \
  && logger -t gr86-store-forward "flushed OBD buffer to Node 3 (${NODE3_HOST})"

exit 0
