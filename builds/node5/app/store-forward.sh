#!/bin/bash
# store-forward.sh — Node 5 (GR86) store-and-forward of the local OBD + dashcam
# buffer to NODE 1 (Core) when the car gets home.
#
# Mirrors the Node-4 Vigil archive pattern (memory: node4-recording-archive):
# a systemd timer runs this every few minutes; when the car is on HOME WiFi and
# the archive host is reachable, rsync the local buffer up, copy-only +
# idempotent so a mid-drive network drop never stalls logging.
#
# The live cloud path is handled by the bridge itself (it POSTs to Supabase when
# it has uplink). This script is the DURABLE second home for the raw buffer.
#
# SCAFFOLD NOTE: bridge.py currently batches in-memory and pushes to Supabase; it
# does not yet also append to BUF_DIR. The plumbing here (dir + timer +
# reachability guard + rsync) is wired so that once the bridge writes JSONL to
# BUF_DIR the forwarding "just works". See README "known gaps".
set -euo pipefail

BUF_DIR="${GR86_BUF_DIR:-/var/lib/garage-obd/buffer}"
# Node 1 = Core (sinsera-core). Both of its addresses are tried in order, then
# mDNS, because which interface answers depends on how it's cabled that day.
ARCHIVE_HOSTS="${GR86_ARCHIVE_HOSTS:-192.168.5.54 192.168.5.61 sinsera-core.local}"
ARCHIVE_DEST="${GR86_ARCHIVE_DEST:-/opt/garage-obd/node5}"   # chown peta:peta on Node 1
SSH_KEY="${GR86_SSH_KEY:-/home/peta/.ssh/id_ed25519}"

mkdir -p "$BUF_DIR"

# Nothing buffered → done. (Cheap check first, before any network work.)
if [ -z "$(ls -A "$BUF_DIR" 2>/dev/null)" ]; then
  exit 0
fi

# Only forward when Node 1 is reachable (i.e. we're home). A hotspot / 4G uplink
# can't see the home LAN, so this is naturally a no-op away from home.
HOST=""
for h in $ARCHIVE_HOSTS; do
  if ping -c1 -W2 "$h" >/dev/null 2>&1; then HOST="$h"; break; fi
done
[ -n "$HOST" ] || exit 0

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8"

# Copy-only + idempotent: never delete the source on failure, skip existing.
rsync -a --ignore-existing --timeout=30 \
  -e "ssh $SSH_OPTS" \
  "$BUF_DIR"/ "peta@${HOST}:${ARCHIVE_DEST}/" \
  && logger -t gr86-store-forward "flushed OBD/dashcam buffer to Node 1 (${HOST})"

exit 0
