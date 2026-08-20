#!/bin/bash
# car-off-shutdown — power Node 5 down cleanly once the car has been off a while.
#
# There is no ignition wire to read, so we infer it: the Thinkware dashcam and the
# AirPlay dongle are both powered by the car, and their wifi vanishes the moment
# you switch it off (verified 2026-08-20). When none of those markers has been
# seen for GRACE_MIN minutes, shut down.
#
# GUARD: if wlan0 is on the home wifi we NEVER shut down. That makes this inert
# on the bench and at the house, where the dashcam is also off — without it the
# Pi would power itself off in your driveway.
#
# Disable at any time:  sudo touch /opt/gr86/no-autoshutdown
set -uo pipefail

STATE=/run/gr86-caroff.count
DISABLE=/opt/gr86/no-autoshutdown
HOME_CON="${GR86_HOME_CON:-uplink-home-wifi}"
GRACE_MIN="${GR86_GRACE_MIN:-10}"
INTERVAL_S=60
NEEDED=$(( GRACE_MIN * 60 / INTERVAL_S ))
# Anything here being on air means the car has power.
# Semicolon-separated, because an SSID may legitimately contain spaces —
# splitting on whitespace silently breaks the match and the cancel never fires.
MARKERS="${GR86_CAR_MARKERS:-Thinkware_DA;WirelessDongle-215C}"

log() { logger -t gr86-caroff "$*"; }

[ -f "$DISABLE" ] && exit 0

# --- guard: never at home -----------------------------------------------------
ACTIVE=$(nmcli -t -f DEVICE,CONNECTION device 2>/dev/null | awk -F: '$1=="wlan0"{print $2}')
if [ "$ACTIVE" = "$HOME_CON" ]; then
  rm -f "$STATE"
  exit 0
fi

# --- is the car awake? --------------------------------------------------------
SEEN=""
SSIDS=$(nmcli -t -f SSID device wifi list ifname wlan0 --rescan yes 2>/dev/null)
while IFS= read -r m; do
  [ -z "$m" ] && continue
  if printf '%s\n' "$SSIDS" | grep -qxF "$m"; then SEEN="$m"; break; fi
done <<< "$(printf '%s' "$MARKERS" | tr ';' '\n')"

if [ -n "$SEEN" ]; then
  if [ -f "$STATE" ]; then
    log "car back on ($SEEN) — countdown cancelled"
    rm -f "$STATE"
  fi
  exit 0
fi

# --- nothing seen: count towards shutdown -------------------------------------
N=$(cat "$STATE" 2>/dev/null || echo 0)
N=$(( N + 1 ))
echo "$N" > "$STATE"

if [ "$N" -ge "$NEEDED" ]; then
  log "car has been off for ${GRACE_MIN} min — shutting down cleanly"
  rm -f "$STATE"
  systemctl poweroff
else
  log "car markers absent ($N/$NEEDED) — shutting down in $(( (NEEDED - N) * INTERVAL_S / 60 )) min"
fi
