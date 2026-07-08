#!/usr/bin/env python3
"""
SwitchBot contact (door) sensors -> Vigil. Runs on a Sinsera node with BLE.

Passively reads SwitchBot WoContact advertisements (service UUID fd3d, company
0x0969), decodes open/closed + battery, and mirrors them into Vigil the same way
the Eufy bridge does:
  - keeps the vigil_cameras sensor row current (status open/closed, battery, last_seen_at)
  - on a state change, posts a vigil_events row -> surfaces in the Vigil feed,
    the Command Centre Alerts widget, and notifications.

Direct BLE — does NOT depend on the Eufy HomeBase, so it works while the cameras
are down. Auth uses the same camera account as the node reporters
(/opt/sinsera-node/kiosk-auth.env). Log: /var/log/switchbot-sensor.log

NOTE: open/closed is decoded as (servicedata[3] & 0x02) per the documented
WoContact format. If a door reads inverted after a real open/close test, flip
OPEN_BIT_SET_MEANS_OPEN below.
"""
import os, sys, time, json, subprocess, urllib.request

ENV = "/opt/sinsera-node/kiosk-auth.env"
LOG = "/var/log/switchbot-sensor.log"
SCAN_SECS = 15          # BLE scan window per cycle — long enough to reliably catch a
                        # door-change advertisement burst as it happens
LOOP_SLEEP = 3          # short gap between cycles: the adapter now scans ~80% of the
                        # time, so a door opened/closed during the gap is still caught
                        # on the very next cycle (the old 6s/22s left a 22s blind window
                        # that let real changes slip through and the row sit stale for
                        # hours). BLE scan overhead is negligible vs the kiosk render.
HEARTBEAT = 300         # refresh the row at least this often even with no change
OPEN_BIT_SET_MEANS_OPEN = True

# BLE MAC -> (vigil_cameras slug, label). Slugs match the rows already created.
SENSORS = {
    "B0:E9:FE:54:D6:54": ("switchbot-b0e9fe54d654", "Robe Door"),
    "B0:E9:FE:54:CC:13": ("switchbot-b0e9fe54cc13", "Bedroom Door"),
}


def log(m):
    line = time.strftime("%Y-%m-%dT%H:%M:%S ") + m
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if ln and not ln.startswith("#") and "=" in ln:
                    k, v = ln.split("=", 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


CFG = load_env(ENV)
SB_URL = CFG.get("SUPABASE_URL", "").rstrip("/")
ANON = CFG.get("SUPABASE_ANON_KEY") or CFG.get("SUPABASE_ANON", "")
EMAIL = CFG.get("VIGIL_EMAIL", "")
PW = CFG.get("VIGIL_PASSWORD", "")

_tok = {"at": None, "uid": None, "exp": 0.0}
_cam_ids = {}


def _req(method, path, body=None, token=None, tries=3):
    """Supabase REST/auth call with retries — the node's link to the cloud DB times
    out intermittently, and a dropped retry used to lose door events."""
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(SB_URL + path, data=data, method=method)
            req.add_header("apikey", ANON)
            req.add_header("Content-Type", "application/json")
            if token:
                req.add_header("Authorization", "Bearer " + token)
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else None
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def auth():
    if _tok["at"] and time.time() < _tok["exp"] - 120:
        return True
    try:
        r = _req("POST", "/auth/v1/token?grant_type=password", {"email": EMAIL, "password": PW})
        _tok["at"], _tok["uid"] = r["access_token"], r["user"]["id"]
        _tok["exp"] = time.time() + r.get("expires_in", 3600)
        return True
    except Exception as e:
        log("auth failed: %s" % e)
        return False


def cam_id(slug):
    if slug in _cam_ids:
        return _cam_ids[slug]
    try:
        q = "/rest/v1/vigil_cameras?slug=eq.%s&owner_id=eq.%s&select=id&limit=1" % (slug, _tok["uid"])
        rows = _req("GET", q, token=_tok["at"])
        if rows:
            _cam_ids[slug] = rows[0]["id"]
            return _cam_ids[slug]
    except Exception as e:
        log("cam_id %s: %s" % (slug, e))
    return None


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


def upsert_sensor(slug, label, status, battery):
    payload = {"status": status, "battery": battery, "last_seen_at": now_iso()}
    cid = cam_id(slug)
    try:
        if cid:
            _req("PATCH", "/rest/v1/vigil_cameras?id=eq.%s" % cid, payload, token=_tok["at"])
        else:
            row = {"owner_id": _tok["uid"], "slug": slug, "label": label,
                   "location": "Sensor · door", "connection": "ble", "ip_address": None}
            row.update(payload)
            _req("POST", "/rest/v1/vigil_cameras", row, token=_tok["at"])
            cam_id(slug)
        return True
    except Exception as e:
        log("upsert %s: %s" % (slug, e))
        return False


def post_event(slug, kind, note):
    cid = cam_id(slug)
    if not cid:
        return False
    try:
        _req("POST", "/rest/v1/vigil_events",
             {"owner_id": _tok["uid"], "camera_id": cid, "kind": kind, "note": note},
             token=_tok["at"])
        return True
    except Exception as e:
        log("event %s: %s" % (slug, e))
        return False


def read_servicedata(mac):
    """fd3d service-data bytes for a MAC (list of ints), or None."""
    try:
        out = subprocess.run(["bluetoothctl", "info", mac],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    grab = False
    for ln in out.splitlines():
        s = ln.strip()
        if s.startswith("ServiceData.0000fd3d"):
            grab = True
            continue
        if grab:
            hexpart = s.split("  ")[0].strip()   # bytes are before the ascii gutter
            toks = hexpart.split()
            try:
                return [int(t, 16) for t in toks if len(t) == 2]
            except Exception:
                return None
    return None


def decode(b):
    """SwitchBot WoContact (type 'd' = 0x64): battery = b[2]&0x7f, open = b[3]&0x02."""
    if not b or len(b) < 4 or b[0] != 0x64:
        return None
    op = bool(b[3] & 0x02)
    if not OPEN_BIT_SET_MEANS_OPEN:
        op = not op
    return {"open": op, "battery": b[2] & 0x7f}


def scan():
    try:
        subprocess.run(["bluetoothctl", "--timeout", str(SCAN_SECS), "scan", "on"],
                       capture_output=True, text=True, timeout=SCAN_SECS + 6)
    except Exception:
        pass


def main():
    if not SB_URL or not EMAIL:
        log("missing Supabase env at %s; exiting" % ENV)
        sys.exit(1)
    subprocess.run(["bluetoothctl", "power", "on"], capture_output=True)
    log("switchbot-sensor starting; watching %d sensors" % len(SENSORS))
    state, last_push = {}, {}
    while True:
        if not auth():
            time.sleep(20)
            continue
        scan()
        for mac, (slug, label) in SENSORS.items():
            d = decode(read_servicedata(mac))
            if not d:
                continue
            status = "open" if d["open"] else "closed"
            now = time.time()
            first = mac not in state
            changed = (not first) and state[mac] != d["open"]
            # keep the sensor row warm (status/battery/last_seen), heartbeat-throttled
            if first or changed or now - last_push.get(mac, 0) > HEARTBEAT:
                if upsert_sensor(slug, label, status, d["battery"]):
                    last_push[mac] = now
            if first:
                state[mac] = d["open"]              # baseline read — no event
            elif changed:
                if post_event(slug, "contact", "%s %s" % (label, "opened" if d["open"] else "closed")):
                    log("%s -> %s (battery %d%%)" % (label, status, d["battery"]))
                    state[mac] = d["open"]          # only advance once the event is in
                else:
                    log("%s changed to %s but post failed — retrying next cycle" % (label, status))
        time.sleep(LOOP_SLEEP)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
