#!/bin/bash
# gr86-autorecord — start cabin recording when the engine starts, stop when it stops.
#
# You have twice found recording switched off when you wanted it on, including on
# a drive. Tying it to the engine removes the question entirely.
#
# EDGE-TRIGGERED on purpose. It acts on the transition (engine started / engine
# stopped) and then leaves the flag alone, so if you turn recording off by hand
# mid-drive it STAYS off — an automation that overrides you every minute is worse
# than no automation.
#
# "Engine running" = the OBD bridge is publishing fresh telemetry. That file only
# exists while the reader is connected and talking, which is exactly the signal.
set -uo pipefail

STATE=/var/lib/gr86-autorecord/last
OBD_STATE=/run/gr86/obd.json
FLAG=/opt/vigil/record_always
MAX_AGE=15            # seconds: telemetry older than this means not running
DISABLE=/opt/gr86/no-autorecord

log() { logger -t gr86-autorecord "$*"; }
[ -f "$DISABLE" ] && exit 0
mkdir -p "$(dirname "$STATE")"

NOW="off"
if [ -f "$OBD_STATE" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$OBD_STATE" 2>/dev/null || echo 0) ))
  [ "$AGE" -le "$MAX_AGE" ] && NOW="running"
fi

WAS=$(cat "$STATE" 2>/dev/null || echo "unknown")
[ "$NOW" = "$WAS" ] && exit 0          # no transition, leave the flag alone
echo "$NOW" > "$STATE"

if [ "$NOW" = "running" ]; then
  if [ ! -e "$FLAG" ]; then
    touch "$FLAG"
    log "engine started — cabin recording ON"
  else
    log "engine started — recording already on"
  fi
else
  if [ -e "$FLAG" ]; then
    rm -f "$FLAG"
    log "engine stopped — cabin recording off"
  else
    log "engine stopped — recording already off"
  fi
fi
