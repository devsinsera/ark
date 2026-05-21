#!/usr/bin/env bash
# Install Ark Hub as a launchd user agent on macOS. The Hub will start
# at login + restart automatically if it crashes.
#
# Idempotent: re-running unloads the old agent before loading the new
# one. Standalone `node hub/src/index.mjs` processes are killed first
# so port 7400 is free for launchd.
set -euo pipefail

LABEL="co.sinsera.ark.hub"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "ERROR: plist not found at $PLIST_SRC" >&2
  exit 1
fi

echo "→ stopping any running Hub processes…"
# kill standalone node processes holding port 7400
if lsof -nP -iTCP:7400 -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -nP -iTCP:7400 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs -I{} kill {} 2>/dev/null || true
  sleep 1
fi

# bootout any existing launchd agent with the same label
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "→ removing existing launchd agent…"
  launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
fi

echo "→ installing plist → $PLIST_DST"
cp "$PLIST_SRC" "$PLIST_DST"

echo "→ loading agent…"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/${LABEL}"

sleep 3

echo "→ verifying Hub is listening on :7400…"
if curl -sS --max-time 3 http://localhost:7400/api/health >/dev/null 2>&1; then
  echo "✓ Hub is running. Tail logs: tail -f ~/Library/Logs/ark-hub.log"
  echo "  Uninstall: bash hub/launchd/uninstall.sh"
else
  echo "✗ Hub did not respond on :7400. Check ~/Library/Logs/ark-hub.log"
  exit 1
fi
