#!/usr/bin/env bash
# Uninstall the Ark Hub launchd agent.
set -euo pipefail

LABEL="co.sinsera.ark.hub"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "→ unloading agent…"
  launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
fi

if [[ -f "$PLIST_DST" ]]; then
  echo "→ removing $PLIST_DST"
  rm "$PLIST_DST"
fi

echo "✓ done"
