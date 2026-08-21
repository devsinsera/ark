#!/bin/bash
# gr86-arrival — fire once when the car gets home, and once when it leaves.
#
# The trigger is free: NetworkManager already tells us which network wlan0 is on,
# so joining the home wifi IS the "arrived home" event. No geofence, no GPS.
#
# On arrival: push the drive's clips to Node 1 and raise a Garage alert.
# On departure: raise an alert so you know the car left (useful when you didn't
# take it).
#
# Edge-triggered via a state file, so it fires on the CHANGE, not every poll.
set -uo pipefail

STATE=/var/lib/gr86-arrival/last
AUTH=/opt/sinsera-node/kiosk-auth.env
HOME_CON="${GR86_HOME_CON:-uplink-home-wifi}"
REC_DIR=/var/lib/vigil/rec
ARCHIVE_HOSTS="${GR86_ARCHIVE_HOSTS:-192.168.4.182 sinsera-node-3.local}"   # Node 1 / Core
ARCHIVE_PATH="${GR86_ARCHIVE_PATH:-/opt/vigil/recordings/node5}"
# same key store-forward already uses and that Core already trusts
KEY="${GR86_SSH_KEY:-/home/peta/.ssh/id_ed25519}"

log() { logger -t gr86-arrival "$*"; }
mkdir -p "$(dirname "$STATE")"

ACTIVE=$(nmcli -t -f DEVICE,CONNECTION device 2>/dev/null | awk -F: '$1=="wlan0"{print $2}')
NOW="away"; [ "$ACTIVE" = "$HOME_CON" ] && NOW="home"
WAS=$(cat "$STATE" 2>/dev/null || echo "unknown")
[ "$NOW" = "$WAS" ] && exit 0          # no change, nothing to do
echo "$NOW" > "$STATE"
log "state change: $WAS -> $NOW"

alert() {   # alert <title> <body>
  [ -f "$AUTH" ] || return 0
  set -a; . "$AUTH"; set +a
  TOK=$(curl -s --max-time 12 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$VIGIL_EMAIL\",\"password\":\"$VIGIL_PASSWORD\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
  [ -n "$TOK" ] || { log "alert skipped: no token"; return 0; }
  UID_=$(curl -s --max-time 12 "$SUPABASE_URL/auth/v1/user" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
  [ -n "$UID_" ] || return 0
  curl -s --max-time 12 -X POST "$SUPABASE_URL/rest/v1/garage_alerts" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    -d "{\"user_id\":\"$UID_\",\"title\":$(printf '%s' "$1" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))'),\"body\":$(printf '%s' "$2" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))'),\"severity\":\"info\"}" >/dev/null
}

if [ "$NOW" = "home" ]; then
  # only count the rolling clips; saved/ is deliberate keepsakes, copied too but
  # never deleted here.
  N=$(find "$REC_DIR" -maxdepth 1 -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ')
  COPIED=0; DRONE=0; HOST=""
  if [ "$N" -gt 0 ] && [ -f "$KEY" ]; then
    for h in $ARCHIVE_HOSTS; do
      if ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
           peta@"$h" "mkdir -p $ARCHIVE_PATH" 2>/dev/null; then HOST="$h"; break; fi
    done
    if [ -n "$HOST" ]; then
      # copy-only; deleting is a separate decision and needs verification first
      # cabin clips sit at the top level; mediamtx writes drone recordings into
      # rec/drone/, which a bare *.mp4 glob never matches. Ship both.
      if rsync -a --ignore-existing --min-size=50k --timeout=60 \
           -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
           "$REC_DIR"/*.mp4 peta@"$HOST":"$ARCHIVE_PATH"/ 2>/dev/null; then
        COPIED=$N
      fi
      if [ -d "$REC_DIR/drone" ]; then
        DRONE=$(find "$REC_DIR/drone" -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ')
        if [ "$DRONE" -gt 0 ]; then
          ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
              peta@"$HOST" "mkdir -p $ARCHIVE_PATH/drone" 2>/dev/null
          rsync -a --ignore-existing --min-size=50k --timeout=60 \
            -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
            "$REC_DIR"/drone/ peta@"$HOST":"$ARCHIVE_PATH"/drone/ 2>/dev/null || DRONE=0
        fi
      fi
    fi
  fi
  log "arrived home; $N cabin clips ($COPIED copied), $DRONE drone recording(s) -> ${HOST:-nowhere}"
  alert "GR86 is home" "Back on the home network. ${COPIED} of ${N} cabin clip(s) and ${DRONE} drone recording(s) copied to Node 3."
else
  log "left home"
  alert "GR86 has left" "The car dropped off the home network."
fi
