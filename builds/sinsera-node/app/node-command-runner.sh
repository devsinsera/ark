#!/bin/bash
# node-command-runner — polls Supabase `node_commands` for THIS host and executes a
# remote poweroff/reboot issued from the Vigil "Nodes" panel. Runs as root (baked
# systemd service) so it can power the box down directly — no sudoers needed.
# Signs in as the camera account (same creds as node-status-reporter) so RLS lets it
# read + update its own command rows.
AUTH=/opt/sinsera-node/kiosk-auth.env
[ -f "$AUTH" ] || exit 0
set -a; . "$AUTH"; set +a
NODE=$(hostname)

token() {
  curl -s --max-time 12 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$VIGIL_EMAIL\",\"password\":\"$VIGIL_PASSWORD\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null
}

poll() {
  TOK=$(token); [ -n "$TOK" ] || return
  ROW=$(curl -s --max-time 12 \
    "$SUPABASE_URL/rest/v1/node_commands?node=eq.$NODE&status=eq.pending&order=created_at.asc&limit=1" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK")
  ID=$(echo "$ROW"  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")' 2>/dev/null)
  CMD=$(echo "$ROW" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["command"] if d else "")' 2>/dev/null)
  [ -n "$ID" ] || return

  # Claim it first (status=running) so the UI reflects it and we never double-execute.
  curl -s --max-time 12 -X PATCH "$SUPABASE_URL/rest/v1/node_commands?id=eq.$ID" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"running\",\"picked_at\":\"$(date -u +%FT%TZ)\"}" >/dev/null

  case "$CMD" in
    poweroff)
      logger -t node-command-runner "poweroff requested via Vigil Nodes panel"
      sleep 2; /sbin/poweroff ;;
    reboot)
      logger -t node-command-runner "reboot requested via Vigil Nodes panel"
      sleep 2; /sbin/reboot ;;
    refresh)
      # Apply a new kiosk view without a reboot: kill cog/cage; the launcher loop
      # (.bash_profile) relaunches it, re-reading this node's kiosk_config target.
      logger -t node-command-runner "refresh requested — restarting kiosk browser"
      pkill -x cog 2>/dev/null; pkill -x cage 2>/dev/null
      curl -s --max-time 12 -X PATCH "$SUPABASE_URL/rest/v1/node_commands?id=eq.$ID" \
        -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
        -H "Content-Type: application/json" \
        -d "{\"status\":\"done\",\"done_at\":\"$(date -u +%FT%TZ)\"}" >/dev/null ;;
    *)
      curl -s --max-time 12 -X PATCH "$SUPABASE_URL/rest/v1/node_commands?id=eq.$ID" \
        -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \
        -H "Content-Type: application/json" \
        -d "{\"status\":\"failed\",\"done_at\":\"$(date -u +%FT%TZ)\"}" >/dev/null ;;
  esac
}

# Poll every 5s (run under a systemd service). Snappy enough for a "power off the TV" action.
while true; do poll; sleep 5; done
