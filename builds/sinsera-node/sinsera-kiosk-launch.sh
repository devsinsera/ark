#!/bin/bash
# Sinsera Node kiosk launcher — cage+cog → the Vigil camera wall, AUTO-AUTHENTICATED.
# Reads the camera-account creds from /opt/sinsera-node/kiosk-auth.env, signs in fresh
# on every boot, and hands cog the session in the URL hash so the wall shows cameras
# with zero interaction (and can't silently "log out" — it re-auths each launch).
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export LIBSEAT_BACKEND=logind
export XCURSOR_THEME=blank
export WLR_NO_HARDWARE_CURSORS=1

# cache-buster (_cb) forces cog to fetch the latest build, not a stale WebKit cache
BASE="https://sinsera.co/vigil?wall=1&kiosk=1&_cb=$(date +%s)"
URL="$BASE"

# wait for the page to be reachable before launching (no white screen on boot)
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

# cog runs as a WAYLAND CLIENT of cage (NOT -P drm — that fights cage for DRM → black)
# --cookie-store=always (keep 3rd-party cookies — needed for Spotify/Apple Music embeds)
# + --cookie-jar=sqlite (persist logins across reboots, so music sign-in sticks)
exec cage -d -- cog --cookie-store=always --cookie-jar=sqlite:/home/kiosk/.cog-cookies.db "$URL" 2>>/var/log/sinsera-kiosk.log
