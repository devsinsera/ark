#!/bin/bash
# node-status-reporter — reports this Pi's CPU/temp/RAM/uptime to Supabase node_status,
# which the Sinsera dashboard reads for the left-menu status bars (?node=<hostname>).
# Signs in as the camera account (same creds the kiosk wall uses) so RLS lets it upsert.
AUTH=/opt/sinsera-node/kiosk-auth.env
[ -f "$AUTH" ] || exit 0
set -a; . "$AUTH"; set +a
NODE=$(hostname)
CORES=$(nproc)

report() {
  TOK=$(curl -s --max-time 12 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$VIGIL_EMAIL\",\"password\":\"$VIGIL_PASSWORD\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
  [ -n "$TOK" ] || return
  CPU=$(awk -v c="$CORES" '{v=$1/c*100; print (v>100?100:int(v))}' /proc/loadavg)  # parens: awk treats bare > as redirect
  TEMP=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
  RAM=$(free | awk '/Mem:/{printf "%d", $3/$2*100}')
  UP=$(uptime -p 2>/dev/null | sed 's/^up //')
  curl -s --max-time 12 -X POST "$SUPABASE_URL/rest/v1/node_status" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates" \
    -d "{\"node\":\"$NODE\",\"cpu\":$CPU,\"temp\":${TEMP:-0},\"ram\":$RAM,\"uptime\":\"$UP\",\"updated_at\":\"$(date -u +%FT%TZ)\"}" >/dev/null
}

# loop forever, every 30s (run under a systemd service)
while true; do report; sleep 30; done
