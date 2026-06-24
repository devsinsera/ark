#!/bin/bash
# Sinsera Node kiosk launcher. What each screen shows is baked per-node in
# /opt/sinsera-node/display.env (resilient: works even if Supabase is down), via KIOSK_VIEW:
#   KIOSK_VIEW=""            → the Sinsera dashboard/hub on sinsera.co   (Node 1 / main)
#   KIOSK_VIEW="/weather"    → that in-app module on sinsera.co          (Node 2 / bedroom)
#   KIOSK_VIEW="http://…"    → an external page, e.g. the LAN camera wall (Node 3 / lounge)
# Also: KIOSK_CURSOR (ui→red-eye), KIOSK_ZOOM (app CSS zoom), KIOSK_SCALE (device-scale).
# External views skip the Supabase auth (not needed) and keep working with Supabase down.
#
# DISPLAY: prefers Xorg + openbox + chromium + unclutter (SINSERA-XSWITCH) — the only proven
# way to hide the pointer on the touchscreens (cog/Wayland draws a cursor nothing can hide).
# Falls back to cage+cog if Xorg fails so the screen never strands black. The actual chromium
# launch lives in /home/kiosk/.config/openbox/autostart, which reads the URL from /tmp/kiosk_url.
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
    URL="${KIOSK_VIEW}"   # SINSERA-FIX: bridge exact-matches path; appended query 404s (white screen)
    for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 4 "$KIOSK_VIEW" && break; sleep 2; done
    ;;
  *)
    # In-app view on sinsera.co (hub when KIOSK_VIEW is empty, else a route like /weather).
    BASE="https://sinsera.co${KIOSK_VIEW}?kiosk=1&node=$(hostname)&cursor=${KIOSK_CURSOR}&zoom=${KIOSK_ZOOM}&_cb=${CB}"
    URL="$BASE"
    for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 4 "$BASE" && break; sleep 2; done
    # auto-auth: hand the app a session in the URL hash. REUSE the saved session
    # wherever possible — a fresh password grant on every boot/relaunch created a
    # new auth session each time (thousands of them) and was a major driver of the
    # egress overage that suspended the cloud project. Order: (1) reuse the cached
    # access_token while it's still valid → NO network; (2) else refresh_token grant
    # (cheap, no new session); (3) password grant only as a last resort / first run.
    # The cache survives reboots, so steady-state makes ZERO sign-in calls.
    AUTH=/opt/sinsera-node/kiosk-auth.env
    if [ -f "$AUTH" ]; then
      set -a; . "$AUTH"; set +a
      HASH=$(SESSION_CACHE=/opt/sinsera-node/kiosk-session.json python3 - <<'PY' 2>/dev/null
import json, os, time, urllib.request

URL   = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON  = os.environ.get("SUPABASE_ANON_KEY", "")
EMAIL = os.environ.get("VIGIL_EMAIL", "")
PASS  = os.environ.get("VIGIL_PASSWORD", "")
CACHE = os.environ.get("SESSION_CACHE", "/opt/sinsera-node/kiosk-session.json")
SKEW  = 300  # treat a token expiring within 5 min as already expired

def post(grant, body):
    req = urllib.request.Request(
        f"{URL}/auth/v1/token?grant_type={grant}",
        data=json.dumps(body).encode(),
        headers={"apikey": ANON, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def save(d):
    d.setdefault("expires_at", int(time.time()) + int(d.get("expires_in", 3600)))
    try:
        with open(CACHE, "w") as f: json.dump(d, f)
        os.chmod(CACHE, 0o600)
    except Exception: pass

d = None
try:
    with open(CACHE) as f: d = json.load(f)
except Exception: d = None

# (1) reuse a still-valid cached token — no network at all
if d and d.get("access_token") and d.get("refresh_token") \
   and int(d.get("expires_at", 0)) - SKEW > time.time():
    pass
# (2) refresh with the cached refresh_token (no new auth session)
elif d and d.get("refresh_token"):
    try:
        d = post("refresh_token", {"refresh_token": d["refresh_token"]}); save(d)
    except Exception:
        d = None
# (3) last resort: password grant (first run, or refresh failed/expired)
if not (d and d.get("access_token") and d.get("refresh_token")):
    try:
        d = post("password", {"email": EMAIL, "password": PASS}); save(d)
    except Exception:
        d = None

if d and d.get("access_token") and d.get("refresh_token"):
    print("access_token=%s&expires_in=%s&refresh_token=%s&token_type=bearer&type=magiclink" % (
        d["access_token"], d.get("expires_in", 3600), d["refresh_token"]))
PY
)
      [ -n "$HASH" ] && URL="$BASE#$HASH"
    fi
    ;;
esac

# SINSERA-XSWITCH: prefer Xorg+chromium+unclutter (hides the touch cursor cog can't);
# fall back to cage+cog if X fails so the screen never strands black. The openbox autostart
# reads the URL from /tmp/kiosk_url and runs the actual `chromium --kiosk` relaunch loop.
if command -v startx >/dev/null 2>&1 && command -v chromium >/dev/null 2>&1 && command -v unclutter >/dev/null 2>&1; then
  echo "$URL" > /tmp/kiosk_url
  startx /usr/bin/openbox-session -- vt1 -keeptty >>/var/log/sinsera-kiosk.log 2>&1
  echo "[launch] startx exited rc=$? — falling back to cage+cog" >>/var/log/sinsera-kiosk.log
fi
# Fallback only. cog runs as a WAYLAND CLIENT of cage. --cookie-store/jar persist logins.
exec cage -d -- cog --scale=${KIOSK_SCALE:-1.0} --cookie-store=always --cookie-jar=sqlite:/home/kiosk/.cog-cookies.db "$URL" 2>>/var/log/sinsera-kiosk.log
