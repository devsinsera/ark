#!/bin/bash
# Sinsera Node kiosk launcher — cage+cog. What each screen shows is baked per-node in
# /opt/sinsera-node/display.env (resilient: works even if Supabase is down), via KIOSK_VIEW:
#   KIOSK_VIEW=""            → the Sinsera dashboard/hub on sinsera.co   (Node 1 / main)
#   KIOSK_VIEW="/weather"    → that in-app module on sinsera.co          (Node 2 / bedroom)
#   KIOSK_VIEW="http://…"    → an external page, e.g. the LAN camera wall (Node 3 / lounge)
# Also: KIOSK_CURSOR (ui→red-eye), KIOSK_ZOOM (app CSS zoom), KIOSK_SCALE (cog scale).
# External views skip the Supabase auth (not needed) and keep working with Supabase down.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export LIBSEAT_BACKEND=logind
export WLR_NO_HARDWARE_CURSORS=1
XCURSOR_THEME=blank
[ -f /opt/sinsera-node/cursor.env ] && . /opt/sinsera-node/cursor.env
export XCURSOR_THEME XCURSOR_SIZE
[ -f /opt/sinsera-node/display.env ] && . /opt/sinsera-node/display.env
CB=$(date +%s)

case "$KIOSK_VIEW" in
  http://*|https://*)
    # External view (LAN camera wall) — load directly, no Supabase auth needed.
    SEP="?"; case "$KIOSK_VIEW" in *\?*) SEP="&";; esac
    URL="${KIOSK_VIEW}${SEP}cursor=${KIOSK_CURSOR}&zoom=${KIOSK_ZOOM}&_cb=${CB}"
    for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 4 "$KIOSK_VIEW" && break; sleep 2; done
    ;;
  *)
    # In-app view on sinsera.co (hub when KIOSK_VIEW is empty, else a route like /weather).
    BASE="https://sinsera.co${KIOSK_VIEW}?kiosk=1&node=$(hostname)&cursor=${KIOSK_CURSOR}&zoom=${KIOSK_ZOOM}&_cb=${CB}"
    URL="$BASE"
    for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 4 "$BASE" && break; sleep 2; done
    # auto-auth: sign in the camera account, embed the session in the hash
    AUTH=/opt/sinsera-node/kiosk-auth.env
    if [ -f "$AUTH" ]; then
      set -a; . "$AUTH"; set +a
      TOK=$(curl -s --max-time 15 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
        -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
        -d "{\"email\":\"$VIGIL_EMAIL\",\"password\":\"$VIGIL_PASSWORD\"}" 2>/dev/null)
      HASH=$(printf '%s' "$TOK" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print("access_token=%s&expires_in=%s&refresh_token=%s&token_type=bearer&type=magiclink" % (
        d["access_token"], d.get("expires_in", 3600), d["refresh_token"]))
except Exception:
    print("")' 2>/dev/null)
      [ -n "$HASH" ] && URL="$BASE#$HASH"
    fi
    ;;
esac

# cog runs as a WAYLAND CLIENT of cage. --cookie-store/jar persist logins across reboots.
exec cage -d -- cog --scale=${KIOSK_SCALE:-1.0} --cookie-store=always --cookie-jar=sqlite:/home/kiosk/.cog-cookies.db "$URL" 2>>/var/log/sinsera-kiosk.log
