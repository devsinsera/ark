#!/usr/bin/env python3
"""Parking sentry: motion in the cabin while the car is parked and away.

Deliberately narrow, because a cabin camera in a moving car sees motion
constantly and a sentry that cries wolf gets ignored:

  * only when the car is AWAY from home (at home, it's your own driveway)
  * only when the car appears to be OFF (the dashcam / AirPlay dongle wifi has
    gone, the same signal the auto-shutdown uses)
  * at most one alert every 10 minutes

It reads the camera daemon's own log rather than re-running detection — the
daemon already writes "MOTION DETECTED", so there is no second pass over frames
and no extra CPU on a 2GB Pi.
"""
import os
import re
import subprocess
import sys
import time

LOG_GLOB = "/var/log/vigil"
STATE = "/var/lib/gr86-sentry/last_alert"
AUTH = "/opt/sinsera-node/kiosk-auth.env"
HOME_CON = os.environ.get("GR86_HOME_CON", "uplink-home-wifi")
MARKERS = os.environ.get("GR86_CAR_MARKERS", "Thinkware_DA;WirelessDongle-215C").split(";")
COOLDOWN = int(os.environ.get("GR86_SENTRY_COOLDOWN", "600"))
WINDOW = 120           # look this far back in the log for motion


def sh(cmd, timeout=25):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def at_home():
    return sh("nmcli -t -f DEVICE,CONNECTION device | awk -F: '$1==\"wlan0\"{print $2}'") == HOME_CON


def car_awake():
    """Is the car powered? Same wifi-marker test the auto-shutdown uses."""
    ssids = sh("nmcli -t -f SSID device wifi list ifname wlan0 --rescan yes", timeout=40)
    seen = set(ssids.splitlines())
    return any(m.strip() in seen for m in MARKERS if m.strip())


def recent_motion():
    """Count MOTION DETECTED lines written in the last WINDOW seconds."""
    hits = 0
    now = time.time()
    try:
        for name in os.listdir(LOG_GLOB):
            path = os.path.join(LOG_GLOB, name)
            if not name.endswith(".log") or now - os.path.getmtime(path) > WINDOW:
                continue
            out = sh(f"tail -n 200 {path!r} | grep -c 'MOTION DETECTED'")
            hits += int(out or 0)
    except (OSError, ValueError):
        pass
    return hits


def alert(title, body):
    script = f'''
set -a; . {AUTH}; set +a
TOK=$(curl -s --max-time 12 -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \\
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \\
  -d "{{\\"email\\":\\"$VIGIL_EMAIL\\",\\"password\\":\\"$VIGIL_PASSWORD\\"}}" \\
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
[ -n "$TOK" ] || exit 0
UID_=$(curl -s --max-time 12 "$SUPABASE_URL/auth/v1/user" -H "apikey: $SUPABASE_ANON_KEY" \\
  -H "Authorization: Bearer $TOK" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
[ -n "$UID_" ] || exit 0
curl -s --max-time 12 -X POST "$SUPABASE_URL/rest/v1/garage_alerts" \\
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $TOK" \\
  -H "Content-Type: application/json" -H "Prefer: return=minimal" \\
  -d "{{\\"user_id\\":\\"$UID_\\",\\"title\\":\\"{title}\\",\\"body\\":\\"{body}\\",\\"severity\\":\\"warning\\"}}" >/dev/null
'''
    subprocess.run(["sudo", "-n", "bash", "-c", script], capture_output=True, timeout=40)


def main():
    dry = "--dry-run" in sys.argv
    if at_home():
        print("at home — sentry idle")
        return
    if car_awake():
        print("car is awake — sentry idle")
        return
    hits = recent_motion()
    if not hits:
        print("parked, no motion")
        return
    last = 0
    try:
        last = float(open(STATE).read().strip())
    except (OSError, ValueError):
        pass
    if time.time() - last < COOLDOWN:
        print(f"motion ({hits}) but within cooldown — not alerting")
        return
    if dry:
        print(f"DRY RUN: would alert on {hits} motion event(s)")
        return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    open(STATE, "w").write(str(time.time()))
    alert("Movement in the GR86", f"The cabin camera saw movement while the car was parked "
                                  f"({hits} event(s) in the last two minutes). Footage is on the card.")
    print(f"ALERTED on {hits} motion event(s)")


if __name__ == "__main__":
    main()
