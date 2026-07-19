#!/bin/bash
# sinsera-kiosk-freshurl — keep /tmp/kiosk_url's auth hash fresh by REUSING one
# Supabase session per node (refresh-token grant) instead of minting a new one
# per relaunch. Fixes two real problems:
#   1. pkill→relaunch used to serve the BOOT-time hash (1h access token + a
#      single-use refresh token) → any browser restart hours after boot woke
#      the kiosk signed OUT (bit us twice on 2026-07-19/20).
#   2. per-launch password grants piled up sessions (~5000) and helped trip
#      the Supabase egress quota — the flagged recurrence guard.
# Run as the kiosk user by the openbox autostart loop before each chromium
# (re)launch. No-op when the current token still has >5 min left.
set -u
URL_FILE=/tmp/kiosk_url
SESSION_FILE="$HOME/.kiosk-session.json"
AUTH_ENV=/opt/sinsera-node/kiosk-auth.env
[ -f "$URL_FILE" ] || exit 0
[ -f "$AUTH_ENV" ] || exit 0
set -a; . "$AUTH_ENV"; set +a
export SESSION_FILE URL_FILE
python3 - <<'PYEOF'
import base64, json, os, re, sys, time, urllib.request
url_file = os.environ["URL_FILE"]; session_file = os.environ["SESSION_FILE"]
SB = os.environ.get("SUPABASE_URL"); ANON = os.environ.get("SUPABASE_ANON_KEY")
EMAIL = os.environ.get("VIGIL_EMAIL"); PW = os.environ.get("VIGIL_PASSWORD")
if not (SB and ANON):
    sys.exit(0)
raw = open(url_file).read().strip()
base = raw.split("#", 1)[0]

def token_ttl(u):
    try:
        tok = u.split("access_token=", 1)[1].split("&", 1)[0]
        pad = tok.split(".")[1]
        d = json.loads(base64.urlsafe_b64decode(pad + "=" * (-len(pad) % 4)))
        return d["exp"] - time.time()
    except Exception:
        return -1

if token_ttl(raw) > 300:
    sys.exit(0)                      # current hash still good — nothing to do

def grant(payload, kind):
    req = urllib.request.Request(f"{SB}/auth/v1/token?grant_type={kind}",
        data=json.dumps(payload).encode(),
        headers={"apikey": ANON, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=15))

d = None
try:                                 # preferred: refresh the SAVED session (no new session)
    rt = json.load(open(session_file)).get("refresh_token")
    if rt:
        d = grant({"refresh_token": rt}, "refresh_token")
except Exception:
    d = None
if d is None and EMAIL and PW:       # fallback: one password grant, then reuse forever
    try:
        d = grant({"email": EMAIL, "password": PW}, "password")
    except Exception:
        d = None
if not d or "access_token" not in d:
    sys.exit(0)                      # leave the old URL — better stale than broken
try:
    with open(session_file, "w") as fh:
        json.dump({"refresh_token": d.get("refresh_token")}, fh)
    os.chmod(session_file, 0o600)
except Exception:
    pass
base = re.sub(r"_cb=\d+", f"_cb={int(time.time())}", base)
hashq = (f"access_token={d['access_token']}&expires_in={d.get('expires_in', 3600)}"
         f"&refresh_token={d.get('refresh_token', '')}&token_type=bearer&type=magiclink")
with open(url_file, "w") as fh:
    fh.write(f"{base}#{hashq}\n")
print("kiosk url refreshed")
PYEOF
exit 0
