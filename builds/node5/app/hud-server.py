#!/usr/bin/env python3
"""
GR86 command centre — Node 5.

ONE address for the whole car node: http://192.168.42.1:8080

Serves a tile menu (gauges / dashcam / recordings / drone / shut down) and opens
each one inside a shell with a persistent BACK bar, so the iPad never has to be
told another URL. Camera tiles are generated from the Vigil hotplug registry, so
plugging another USB camera into the car adds its own tile.

Everything here is stdlib-only and self-contained — NO web fonts, NO CDNs — the
car is offline most of the time.

  /                command centre (tile menu + viewer shell)
  /power           standalone shut-down page (also framed by the POWER tile)
  /api/status      JSON: uplink, OBD bridge, cameras, drone publishing
  /healthz         liveness

The real gauge HUD is still the Garage kiosk output at
sinsera.co/garage/<carUuid>/obd?hud=1 — framed when there's an uplink, with a
local placeholder when there isn't.
"""
import http.server
import socketserver
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request

PORT = int(os.environ.get("HUD_PORT", "8080"))
CAR_UUID = os.environ.get("GR86_CAR_UUID", "").strip()
# graph=0 -> the big gauges only, no line graphs (a car screen wants numbers).
# demo=1  -> the app's synthetic feed, which needs no signed-in session; used
#            while no OBD reader is connected so the tile still shows gauges
#            instead of the "needs a real vehicle" dead end.
_HUD_BASE = f"https://sinsera.co/garage/{CAR_UUID}/obd" if CAR_UUID else ""
CLOUD_HUD = f"{_HUD_BASE}?hud=1&graph=0" if _HUD_BASE else "https://sinsera.co/garage"
CLOUD_HUD_DEMO = f"{_HUD_BASE}?hud=1&graph=0&demo=1" if _HUD_BASE else CLOUD_HUD
HOTPLUG_JSON = "/opt/vigil/hotplug.json"
# Presence of this file = the camera records continuously (see vigil_cam.py).
RECORD_FLAG = "/opt/vigil/record_always"
RECORD_DIR = "/var/lib/vigil/rec"
SAVED_DIR = RECORD_DIR + "/saved"
ORDER_FILE = "/opt/gr86-hud/tile-order.json"
# Which of the account's cameras belong on the CAR screen. A JSON list of
# slugs; delete the file to show every camera that has a picture.
CLOUD_ALLOW_FILE = "/opt/gr86-hud/cloud-cameras.json"
AUTH_ENV = "/opt/sinsera-node/kiosk-auth.env"
DRONE_WEBRTC_PORT = 8889
DRONE_HLS_PORT = 8888
RELAY_API_PORT = 9997
DRONE_PATH = "drone"

# ---------------------------------------------------------------- status ----

_status_lock = threading.Lock()
_status_cache = {"at": 0.0, "data": None}


def have_uplink(timeout=1.2):
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=timeout):
            return True
    except OSError:
        return False


def port_open(port, host="127.0.0.1", timeout=0.4):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def cameras():
    """Vigil hotplug registry -> [{slug, port, label, up}] (newest layout wins)."""
    try:
        with open(HOTPLUG_JSON) as fh:
            reg = json.load(fh)
    except (OSError, ValueError):
        return []
    out = []
    for byid, entry in reg.items():
        port = entry.get("port")
        if not port:
            continue
        # The registry deliberately KEEPS unplugged cameras so a given camera always
        # gets the same slug + port when it comes back. Only show what is plugged in
        # right now: the registry key is the /dev/v4l/by-id name.
        if not os.path.exists(os.path.join("/dev/v4l/by-id", byid)):
            continue
        out.append({
            "slug": entry.get("slug", ""),
            "label": entry.get("label") or "Camera",
            "port": port,
            "up": port_open(port),
        })
    return sorted(out, key=lambda c: c["port"])


def unit_active(unit):
    try:
        res = subprocess.run(["systemctl", "is-active", unit],
                             capture_output=True, text=True, timeout=4)
        return res.stdout.strip() == "active"
    except (OSError, subprocess.SubprocessError):
        return False


def obd_state():
    """stopped | connected | no-reader — from the bridge's own log, not just the unit."""
    if not unit_active("garage-obd-bridge"):
        return "stopped"
    try:
        res = subprocess.run(
            ["journalctl", "-u", "garage-obd-bridge", "-n", "40", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=5)
        lines = res.stdout.strip().splitlines()
    except (OSError, subprocess.SubprocessError):
        return "running"
    for line in reversed(lines):
        if "connected to " in line:
            return "connected"
        if "not found" in line or "scanning for" in line:
            return "no-reader"
    return "running"


def streams():
    """mediamtx paths -> [{name, live}].

    `all_others:` is configured, so ANY publisher (a rear dashcam pushing to
    rtmp://192.168.42.1:1935/rear, say) creates its own path here and therefore
    gets its own tile with no code change.
    """
    try:
        url = f"http://127.0.0.1:{RELAY_API_PORT}/v3/paths/list"
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        return [{"name": DRONE_PATH, "live": False}]
    out = []
    for item in data.get("items", []):
        name = item.get("name") or ""
        if not name or name == "all_others":
            continue
        out.append({"name": name, "live": bool(item.get("ready"))})
    if not any(s["name"] == DRONE_PATH for s in out):
        out.append({"name": DRONE_PATH, "live": False})
    return sorted(out, key=lambda s: (not s["live"], s["name"]))



# ------------------------------------------------------------ cloud cams ----

_cloud = {"tok": None, "at": 0.0, "url": None, "key": None,
          "cams": [], "cams_at": 0.0, "thumbs": {}}


def _creds():
    """Read the fleet creds (root-owned) via sudo; peta has NOPASSWD."""
    if _cloud["url"] and _cloud["key"]:
        return True
    try:
        out = subprocess.run(["sudo", "-n", "cat", AUTH_ENV],
                             capture_output=True, text=True, timeout=8).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    env = {}
    for line in out.splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    _cloud["url"] = env.get("SUPABASE_URL")
    _cloud["key"] = env.get("SUPABASE_ANON_KEY")
    _cloud["email"] = env.get("VIGIL_EMAIL")
    _cloud["pw"] = env.get("VIGIL_PASSWORD")
    return bool(_cloud["url"] and _cloud["key"] and _cloud["pw"])


def _token():
    """Cached 45 min — a sign-in per request is what caused the 429 storm."""
    now = time.time()
    if _cloud["tok"] and now - _cloud["at"] < 2700:
        return _cloud["tok"]
    if not _creds():
        return None
    try:
        body = json.dumps({"email": _cloud["email"], "password": _cloud["pw"]}).encode()
        req = urllib.request.Request(
            _cloud["url"] + "/auth/v1/token?grant_type=password", data=body,
            headers={"apikey": _cloud["key"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=12) as r:
            payload = json.loads(r.read().decode())
        tok = payload.get("access_token")
        # frames are stored under {uid}/{slug}/latest.jpg
        uid = (payload.get("user") or {}).get("id")
        if uid:
            _cloud["uid"] = uid
        if tok:
            _cloud["tok"], _cloud["at"] = tok, now
        return tok
    except Exception:
        return None


def cloud_cameras():
    """Other cameras on the account (not this node's own USB ones)."""
    now = time.time()
    if _cloud["cams"] and now - _cloud["cams_at"] < 60:
        return _cloud["cams"]
    tok = _token()
    if not tok:
        return []
    try:
        req = urllib.request.Request(
            _cloud["url"] + "/rest/v1/vigil_cameras?select=slug,label,status&order=label",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=12) as r:
            rows = json.loads(r.read().decode())
    except Exception:
        return _cloud["cams"]
    allow = None
    try:
        with open(CLOUD_ALLOW_FILE) as fh:
            v = json.load(fh)
            if isinstance(v, list):
                allow = set(v)
    except (OSError, ValueError):
        allow = None

    out = []
    for c in rows:
        slug = str(c["slug"])
        if slug.startswith("node5-"):          # this node's own cams are listed locally
            continue
        if allow is not None and slug not in allow:
            continue                            # not wanted on the car screen
        if str(c.get("status")) not in ("online", "offline"):
            continue                            # sensors report temperature/open/closed
        if not _has_frame(slug):                # buttons and door sensors have no picture
            continue
        out.append({"slug": slug, "label": c.get("label") or slug,
                    "status": c.get("status")})
    _cloud["cams"], _cloud["cams_at"] = out, now
    return out


def _has_frame(slug):
    """Does this camera actually have a frame? Cached 10 min.

    The account holds buttons, motion and door sensors alongside real cameras;
    only the ones with a stored frame belong on a screen.
    """
    hit = _cloud.setdefault("hasframe", {}).get(slug)
    now = time.time()
    if hit and now - hit[0] < 600:
        return hit[1]
    ok = False
    try:
        req = urllib.request.Request(
            f"{_cloud['url']}/storage/v1/object/vigil-frames/"
            f"{_cloud.get('uid','')}/{slug}/latest.jpg",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + (_cloud["tok"] or "")},
            method="HEAD")
        with urllib.request.urlopen(req, timeout=8) as r:
            ok = r.status == 200
    except Exception:
        ok = False
    _cloud["hasframe"][slug] = (now, ok)
    return ok


def _shrink(data, width=420):
    """Scale a frame down for a tile.

    The cloud frames are ~200KB each. A tile is under 200px wide, so sending the
    full image wastes bandwidth that costs real money on the car's hotspot —
    roughly 140MB/hour per camera at a 5s refresh. Scaled down it is ~20KB.
    """
    try:
        res = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
             "-vf", f"scale={width}:-2", "-frames:v", "1", "-q:v", "6", "-f", "mjpeg", "pipe:1"],
            input=data, capture_output=True, timeout=15)
        return res.stdout if res.returncode == 0 and res.stdout else data
    except (OSError, subprocess.SubprocessError):
        return data


def cloud_thumb(slug, full=False):
    """Latest frame for a cloud camera; cached ~5s so tiles don't hammer it."""
    now = time.time()
    key = slug + ("|full" if full else "")
    hit = _cloud["thumbs"].get(key)
    if hit and now - hit[0] < 5:
        return hit[1]
    tok = _token()
    if not tok:
        return None
    try:
        req = urllib.request.Request(
            f"{_cloud['url']}/storage/v1/object/vigil-frames/{_cloud['uid']}/{slug}/latest.jpg"
            if _cloud.get("uid") else
            f"{_cloud['url']}/storage/v1/object/vigil-frames/{slug}/latest.jpg",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read()
        if not full:
            data = _shrink(data)
        _cloud["thumbs"][key] = (now, data)
        return data
    except Exception:
        return None


_stream_thumbs = {}
_stream_lock = threading.Lock()


def stream_thumb(name):
    """One JPEG off a live relay path, via RTSP. Cached ~6s.

    mediamtx has no still-image endpoint, so pull a single frame with ffmpeg.
    It costs ~2.7s on this Pi, hence the cache and the lock — without them a
    menu full of tiles would spawn an ffmpeg each.
    """
    if not name.replace("-", "").replace("_", "").isalnum():
        return None
    now = time.time()
    hit = _stream_thumbs.get(name)
    if hit and now - hit[0] < 6:
        return hit[1]
    # Wait for an in-flight grab rather than 404ing: with no cache yet (just after
    # a restart) a concurrent request would otherwise get nothing at all.
    if not _stream_lock.acquire(timeout=12):
        return hit[1] if hit else None
    # someone may have filled the cache while we queued
    hit = _stream_thumbs.get(name)
    if hit and time.time() - hit[0] < 6:
        _stream_lock.release()
        return hit[1]
    try:
        res = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
             "-i", f"rtsp://127.0.0.1:8554/{name}", "-frames:v", "1", "-q:v", "6",
             "-vf", "scale=420:-2", "-f", "mjpeg", "pipe:1"],
            capture_output=True, timeout=20)
        data = res.stdout if res.returncode == 0 and res.stdout else None
    except (OSError, subprocess.SubprocessError):
        data = None
    finally:
        _stream_lock.release()
    if data:
        _stream_thumbs[name] = (now, data)
    return data


def save_clips(minutes=2):
    """Copy clips touched in the last `minutes` into rec/saved/. Returns a count.

    Runs through sudo: the recordings belong to the `vigil` user and this server
    runs as `peta`.
    """
    script = (
        f'mkdir -p {SAVED_DIR}; '
        f'n=0; for f in $(find {RECORD_DIR} -maxdepth 1 -name "*.mp4" -mmin -{minutes + 1}); do '
        # `cp -n` exits 0 when it SKIPS an existing file, so counting on its exit
        # status reported "saved 2" every time you tapped. Only count genuinely new ones.
        f'  b=$(basename "$f"); [ -e "{SAVED_DIR}/$b" ] && continue; '
        f'  cp "$f" "{SAVED_DIR}/$b" && n=$((n+1)); '
        f'done; echo $n'
    )
    try:
        res = subprocess.run(["sudo", "-n", "bash", "-c", script],
                             capture_output=True, text=True, timeout=30)
        return int((res.stdout or "0").strip() or 0)
    except (OSError, ValueError, subprocess.SubprocessError):
        return -1


def saved_count():
    try:
        return len([f for f in os.listdir(SAVED_DIR) if f.endswith(".mp4")])
    except OSError:
        return 0


def drive_summary():
    """Last drive, summarised. Cached 60s — it hits the cloud."""
    now = time.time()
    hit = _cloud.get("drive")
    if hit and now - hit[0] < 60:
        return hit[1]
    tok = _token()
    if not tok:
        return None
    try:
        req = urllib.request.Request(
            _cloud["url"] + "/rest/v1/garage_obd_sessions"
            "?select=id,started_at,ended_at&order=started_at.desc&limit=1",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=12) as r:
            sessions = json.loads(r.read().decode())
        if not sessions:
            out = {"none": True}
            _cloud["drive"] = (now, out)
            return out
        sess = sessions[0]
        req = urllib.request.Request(
            _cloud["url"] + "/rest/v1/garage_obd_readings"
            f"?select=sampled_at,speed_kph,rpm,coolant_c,battery_v"
            f"&session_id=eq.{sess['id']}&order=sampled_at.asc&limit=5000",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read().decode())
    except Exception:
        return hit[1] if hit else None

    def num(v):
        return v if isinstance(v, (int, float)) else None

    speeds = [num(r.get("speed_kph")) for r in rows]
    speeds = [v for v in speeds if v is not None]
    rpms = [num(r.get("rpm")) for r in rows if num(r.get("rpm")) is not None]
    temps = [num(r.get("coolant_c")) for r in rows if num(r.get("coolant_c")) is not None]
    volts = [num(r.get("battery_v")) for r in rows if num(r.get("battery_v")) is not None]

    # integrate speed over the gaps between samples -> distance, no GPS needed
    km = 0.0
    for i in range(1, len(rows)):
        try:
            t0 = rows[i - 1]["sampled_at"]; t1 = rows[i]["sampled_at"]
            dt = (_parse_ts(t1) - _parse_ts(t0))
        except Exception:
            continue
        if dt <= 0 or dt > 30:      # ignore gaps (a pause, a dropout)
            continue
        v = num(rows[i].get("speed_kph")) or 0
        km += v * dt / 3600.0

    out = {
        "none": False,
        "started": sess.get("started_at"),
        "ended": sess.get("ended_at"),
        "samples": len(rows),
        "km": round(km, 1),
        "max_speed": max(speeds) if speeds else None,
        "max_rpm": max(rpms) if rpms else None,
        "max_coolant": max(temps) if temps else None,
        "min_volts": min(volts) if volts else None,
    }
    _cloud["drive"] = (now, out)
    return out


def _parse_ts(s):
    import datetime as _dt
    return _dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


INTERESTING = ("person", "vehicle", "animal", "possible_weapon", "rule")


def home_events(hours=12, limit=25):
    """Recent meaningful events from the house cameras. Cached 60s."""
    now = time.time()
    hit = _cloud.get("events")
    if hit and now - hit[0] < 60:
        return hit[1]
    tok = _token()
    if not tok:
        return []
    kinds = ",".join(INTERESTING)
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - hours * 3600))
    try:
        req = urllib.request.Request(
            _cloud["url"] + "/rest/v1/vigil_events"
            f"?select=kind,note,created_at,vigil_cameras(label)"
            f"&kind=in.({kinds})&created_at=gt.{since}"
            f"&order=created_at.desc&limit={limit}",
            headers={"apikey": _cloud["key"], "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.loads(r.read().decode())
    except Exception:
        return hit[1] if hit else []
    out = []
    for e in rows:
        cam = (e.get("vigil_cameras") or {})
        out.append({
            "kind": e.get("kind"),
            "camera": cam.get("label") or "camera",
            "note": e.get("note") or "",
            "at": e.get("created_at"),
        })
    _cloud["events"] = (now, out)
    return out


def storage():
    """How full the recording card is, so pruning is never a surprise."""
    try:
        st = os.statvfs(RECORD_DIR)
        free_gb = st.f_bavail * st.f_frsize / 1e9
        total_gb = st.f_blocks * st.f_frsize / 1e9
        used = subprocess.run(["du", "-sb", RECORD_DIR], capture_output=True,
                              text=True, timeout=20).stdout.split()[0]
        clips_gb = int(used) / 1e9
    except Exception:
        return None
    return {"clips_gb": round(clips_gb, 2), "free_gb": round(free_gb, 1),
            "disk_gb": round(total_gb, 1)}


def tile_order():
    try:
        with open(ORDER_FILE) as fh:
            v = json.load(fh)
            return v if isinstance(v, list) else []
    except (OSError, ValueError):
        return []


def save_tile_order(order):
    # Dedupe here, not just in the page: a browser still running an older copy of
    # the script can post an order containing the same tile twice, and the client
    # is the one place we cannot guarantee has been reloaded.
    seen, clean = set(), []
    for item in order:
        key = str(item)
        if key and key not in seen:
            seen.add(key)
            clean.append(key)
    try:
        os.makedirs(os.path.dirname(ORDER_FILE), exist_ok=True)
        with open(ORDER_FILE, "w") as fh:
            json.dump(clean, fh)
        return True
    except OSError:
        return False


def status():
    with _status_lock:
        now = time.time()
        if _status_cache["data"] and now - _status_cache["at"] < 8:
            return _status_cache["data"]
    data = {
        "uplink": have_uplink(),
        "obd": obd_state(),
        "recording": os.path.exists(RECORD_FLAG),
        "saved_clips": saved_count(),
        "storage": storage(),
        "relay": unit_active("mediamtx"),
        "streams": streams(),
        "cameras": cameras(),
        "cloud_cameras": cloud_cameras(),
        "order": tile_order(),
    }
    with _status_lock:
        _status_cache.update(at=time.time(), data=data)
    return data


# ------------------------------------------------------------------ pages ----

SHELL = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="GR86">
<meta name="theme-color" content="#0a0a0c">
<title>GR86 &middot; Node 5</title>
<style>
  :root {
    --bg:#0a0a0c; --panel:#15161a; --line:#2a2c33; --text:#ecedf0;
    --muted:#8b8f9a; --red:#c1121f; --amber:#e8a33d; --green:#3fb27f; --blue:#8ecae6;
    --safe-t:env(safe-area-inset-top); --safe-b:env(safe-area-inset-bottom);
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  /* Screensaver, ported from the main app's Screensaver.tsx and run faint so it
     sits behind the tiles without competing with them. */
  #bgrain, #bgfire {
    position:fixed; left:0; width:100%; pointer-events:none; z-index:0;
    opacity:.17;
  }
  #bgrain { top:0; height:100%; }
  #bgfire { bottom:0; height:120px; image-rendering:pixelated; opacity:.22; }
  #menu, #viewer { position:relative; z-index:1; }
  @media (prefers-reduced-motion:reduce) { #bgrain, #bgfire { display:none; } }
  html,body {
    margin:0; height:100%; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
    overscroll-behavior:none;
  }
  body { display:flex; flex-direction:column; }

  /* ---------- menu ---------- */
  #menu { flex:1; display:flex; flex-direction:column; min-height:0;
          padding:calc(var(--safe-t) + 18px) 18px calc(var(--safe-b) + 18px); gap:16px; }
  .head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .head h1 { margin:0; font-size:1.25rem; font-weight:700; letter-spacing:.16em; }
  .head h1 span { color:var(--red); }
  .bar { display:flex; flex-wrap:wrap; gap:7px; }
  .pill {
    font-size:.68rem; letter-spacing:.1em; font-weight:600; text-transform:uppercase;
    padding:4px 9px; border-radius:99px; border:1px solid var(--line);
    color:var(--muted); white-space:nowrap;
  }
  .pill.on  { color:var(--green); border-color:color-mix(in srgb,var(--green) 45%,transparent); }
  .pill.off { color:var(--muted); }
  .pill.hot { color:var(--amber); border-color:color-mix(in srgb,var(--amber) 45%,transparent); }

  .tiles {
    flex:1; min-height:0; display:grid; gap:12px; overflow-y:auto;
    grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
    align-content:start;
  }
  .tile {
    appearance:none; -webkit-appearance:none; text-align:left; font:inherit; color:inherit;
    background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:20px 18px; min-height:118px; cursor:pointer;
    display:flex; flex-direction:column; justify-content:space-between; gap:10px;
    transition:transform .08s ease, border-color .15s ease;
  }
  .tile:active { transform:scale(.985); }
  .tile:focus-visible { outline:3px solid var(--blue); outline-offset:3px; }
  .tile .t { font-size:1.18rem; font-weight:650; letter-spacing:.02em; }
  .tile .s { font-size:.82rem; color:var(--muted); line-height:1.35; }
  .tile .g { font-size:.66rem; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); font-weight:600; }
  .tile.danger { border-color:color-mix(in srgb,var(--red) 55%,transparent); }
  .tile.danger .t { color:var(--red); }
  .tile.live .g { color:var(--green); }
  .tile.cam { padding:0; overflow:hidden; gap:0; }
  .tile.cam .thumb {
    position:relative; width:100%; aspect-ratio:16/9; background:#000;
    border-bottom:1px solid var(--line); overflow:hidden;
  }
  .tile.cam .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .tile.cam .thumb .badge {
    position:absolute; top:8px; left:8px; font-size:.6rem; font-weight:700;
    letter-spacing:.14em; padding:3px 7px; border-radius:99px;
    background:#000a; color:var(--green); border:1px solid color-mix(in srgb,var(--green) 50%,transparent);
  }
  .tile.cam .thumb .dead {
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:var(--muted); font-size:.8rem; letter-spacing:.1em;
  }
  .tile.cam .body { padding:14px 16px; display:flex; flex-direction:column; gap:6px; }
  /* drag-to-reorder */
  .tile.dragging {
    position:fixed; z-index:50; pointer-events:none; opacity:.92;
    box-shadow:0 18px 40px rgba(0,0,0,.55); transform:scale(1.04);
    border-color:var(--blue);
  }
  .tile.ghost { opacity:.25; }
  body.reordering .tile { animation:wig .32s ease-in-out infinite alternate; }
  body.reordering .tile.dragging { animation:none; }
  @keyframes wig { from{transform:rotate(-.5deg)} to{transform:rotate(.5deg)} }
  @media (prefers-reduced-motion:reduce){ body.reordering .tile{animation:none} }
  #reorderbar {
    display:none; align-items:center; justify-content:space-between; gap:12px;
    background:var(--panel); border:1px solid var(--blue); border-radius:12px;
    padding:10px 14px; font-size:.85rem; color:var(--muted);
  }
  body.reordering #reorderbar { display:flex; }
  #reorderbar button {
    appearance:none; font:inherit; font-size:.8rem; font-weight:700; letter-spacing:.1em;
    background:var(--blue); color:#0a0a0c; border:0; border-radius:8px; padding:8px 14px;
    cursor:pointer;
  }
  .tile .state {
    align-self:flex-start; font-size:.62rem; font-weight:700; letter-spacing:.16em;
    padding:3px 9px; border-radius:99px; border:1px solid var(--line); color:var(--muted);
  }
  .tile.on .state { color:var(--green); border-color:color-mix(in srgb,var(--green) 50%,transparent); }

  /* ---------- viewer ---------- */
  #viewer { display:none; flex:1; flex-direction:column; min-height:0; }
  #viewer.show { display:flex; }
  body.viewing #menu { display:none; }
  #topbar {
    display:flex; align-items:center; gap:12px; flex:0 0 auto;
    padding:calc(var(--safe-t) + 8px) 14px 8px;
    background:var(--panel); border-bottom:1px solid var(--line);
  }
  #back {
    appearance:none; -webkit-appearance:none; font:inherit; cursor:pointer;
    background:transparent; color:var(--text); border:1px solid var(--line);
    border-radius:10px; padding:10px 16px; font-size:.95rem; font-weight:600;
    letter-spacing:.06em; white-space:nowrap;
  }
  #back:active { background:#20222a; }
  #back:focus-visible { outline:3px solid var(--blue); outline-offset:2px; }
  #vtitle { font-size:.95rem; font-weight:600; letter-spacing:.1em;
            text-transform:uppercase; color:var(--muted);
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #stage { flex:1; min-height:0; position:relative; background:#000; }
  #stage iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  #stage img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
  #hint { position:absolute; left:0; right:0; bottom:0; padding:10px 14px calc(var(--safe-b) + 10px);
          font-size:.78rem; color:var(--muted); background:linear-gradient(transparent,#000c);
          text-align:center; }
</style>
</head><body>

<canvas id="bgrain"></canvas>
<canvas id="bgfire"></canvas>

<div id="menu">
  <div class="head">
    <h1>GR86 <span>&middot;</span> NODE 5</h1>
  </div>
  <div class="bar" id="statusbar"></div>
  <div id="reorderbar"><span>Drag the tiles into the order you want.</span><button id="donereorder">DONE</button></div>
  <div class="tiles" id="tiles"></div>
</div>

<div id="viewer">
  <div id="topbar">
    <button id="back">&lsaquo; MENU</button>
    <div id="vtitle"></div>
  </div>
  <div id="stage"></div>
</div>

<script>
var HOST = location.hostname;
var CLOUD_HUD = %CLOUD_HUD%;
var CLOUD_HUD_DEMO = %CLOUD_HUD_DEMO%;
var tilesEl = document.getElementById('tiles');
var barEl = document.getElementById('statusbar');
var stage = document.getElementById('stage');
var viewer = document.getElementById('viewer');
var vtitle = document.getElementById('vtitle');
var snapTimer = null;

function el(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

/* ---- viewer ---- */
function closeView(push) {
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
  stage.innerHTML = '';
  viewer.classList.remove('show');
  document.body.classList.remove('viewing');
  if (push !== false && history.state && history.state.view) history.back();
}

function openView(title, build) {
  if (typeof stopThumbs === 'function') stopThumbs();
  vtitle.textContent = title;
  stage.innerHTML = '';
  build();
  viewer.classList.add('show');
  document.body.classList.add('viewing');
  history.pushState({ view: title }, '');
}

function openFrame(title, url) {
  openView(title, function () {
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; fullscreen');
    f.src = url;
    stage.appendChild(f);
  });
}

function openCamera(title, port) {
  openView(title, function () {
    var img = document.createElement('img');
    var base = 'http://' + HOST + ':' + port + '/snapshot?';
    function tick() { img.src = base + Date.now(); }
    img.onload = function () { snapTimer = setTimeout(tick, 80); };
    img.onerror = function () { snapTimer = setTimeout(tick, 600); };
    stage.appendChild(img);
    var hint = el('div', null, 'Live \\u00b7 tap MENU to go back');
    hint.id = 'hint';
    stage.appendChild(hint);
    tick();
  });
}

document.getElementById('back').onclick = function () { closeView(); };
window.addEventListener('popstate', function () { closeView(false); });

/* ---- menu ---- */
var savedOrder = [];
var reordering = false;

/* ---- tile construction ---- */
function tile(spec) {
  var b = el('button', 'tile' + (spec.cls ? ' ' + spec.cls : ''));
  b.dataset.id = spec.id;
  if (spec.thumb) {
    b.classList.add('cam');
    var th = el('div', 'thumb');
    if (spec.up === false) {
      th.appendChild(el('div', 'dead', 'NO SIGNAL'));
    } else {
      var img = document.createElement('img');
      // Cloud cameras refresh slowly on purpose: every frame is hotspot data spent
      // on a tile you are not looking at while driving.
      var every = spec.interval || 4000;
      function tick() {
        img.src = spec.thumb + (spec.thumb.indexOf('?') < 0 ? '?' : '&') + Date.now();
        menuThumbs.push(setTimeout(tick, every));
      }
      th.appendChild(img);
      th.appendChild(el('span', 'badge', 'LIVE'));
      tick();
    }
    b.appendChild(th);
    var body = el('div', 'body');
    body.appendChild(el('div', 'g', spec.group));
    body.appendChild(el('div', 't', spec.title));
    if (spec.sub) body.appendChild(el('div', 's', spec.sub));
    b.appendChild(body);
  } else {
    b.appendChild(el('div', 'g', spec.group));
    var w = el('div');
    w.appendChild(el('div', 't', spec.title));
    if (spec.sub) w.appendChild(el('div', 's', spec.sub));
    b.appendChild(w);
    if (spec.state) b.appendChild(el('div', 'state', spec.state));
  }
  b.onclick = function () { if (!reordering) spec.onClick(); };
  attachDrag(b);
  return b;
}

/* ---- long-press drag, iOS style ---- */
var press = null, drag = null;

function attachDrag(node) {
  node.addEventListener('pointerdown', function (e) {
    if (e.button && e.button !== 0) return;
    var startX = e.clientX, startY = e.clientY;
    press = setTimeout(function () {
      press = null;
      startDrag(node, startX, startY);
    }, 450);
    function cancel(ev) {
      if (press && (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10)) {
        clearTimeout(press); press = null;
      }
    }
    node.addEventListener('pointermove', cancel);
    node.addEventListener('pointerup', function up() {
      if (press) { clearTimeout(press); press = null; }
      node.removeEventListener('pointermove', cancel);
      node.removeEventListener('pointerup', up);
    });
  });
}

function startDrag(node, x, y) {
  if (navigator.vibrate) navigator.vibrate(12);
  reordering = true;
  document.body.classList.add('reordering');
  var r = node.getBoundingClientRect();
  var ghost = node.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.visibility = 'hidden';
  node.parentNode.insertBefore(ghost, node);
  node.classList.add('dragging');
  node.style.width = r.width + 'px';
  node.style.height = r.height + 'px';
  drag = { node: node, ghost: ghost, dx: x - r.left, dy: y - r.top };
  moveDrag(x, y);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

function moveDrag(x, y) {
  drag.node.style.left = (x - drag.dx) + 'px';
  drag.node.style.top = (y - drag.dy) + 'px';
}

function onDragMove(e) {
  if (!drag) return;
  e.preventDefault();
  moveDrag(e.clientX, e.clientY);
  var under = document.elementFromPoint(e.clientX, e.clientY);
  var target = under && under.closest ? under.closest('.tile') : null;
  if (!target || target === drag.node || target === drag.ghost) return;
  var tr = target.getBoundingClientRect();
  var after = (e.clientY - tr.top) > tr.height / 2;
  target.parentNode.insertBefore(drag.ghost, after ? target.nextSibling : target);
}

function onDragEnd() {
  if (!drag) return;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  var n = drag.node, g = drag.ghost;
  n.classList.remove('dragging');
  n.style.cssText = '';
  g.parentNode.insertBefore(n, g);
  g.parentNode.removeChild(g);
  drag = null;
  persistOrder();
  // Leave reorder mode by itself if it's left open — otherwise live updates
  // (status, thumbnails) stay paused and the page looks frozen.
  clearTimeout(window._reorderIdle);
  window._reorderIdle = setTimeout(function () {
    if (reordering && !drag) {
      reordering = false;
      document.body.classList.remove('reordering');
      refresh();
    }
  }, 20000);
}

function persistOrder() {
  var seen = {};
  savedOrder = Array.prototype.slice.call(tilesEl.children)
    .map(function (n) { return n.dataset.id; })
    .filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = 1;
      return true;
    });
  fetch('/api/order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(savedOrder)
  }).catch(function () {});
}

document.getElementById('donereorder').onclick = function () {
  reordering = false;
  document.body.classList.remove('reordering');
};

/* ---- the menu ---- */
var menuThumbs = [];
function stopThumbs() {
  menuThumbs.forEach(function (t) { clearTimeout(t); });
  menuThumbs = [];
}

function render(st) {
  stopThumbs();
  savedOrder = st.order || savedOrder;

  /* status pills */
  barEl.innerHTML = '';
  function pill(text, cls) { barEl.appendChild(el('span', 'pill ' + cls, text)); }
  pill(st.uplink ? 'online' : 'offline \u00b7 buffering', st.uplink ? 'on' : 'off');
  var obdText = { connected: 'obd connected', 'no-reader': 'obd \u00b7 no reader',
                  stopped: 'obd stopped', running: 'obd running' }[st.obd] || 'obd unknown';
  pill(obdText, st.obd === 'connected' ? 'on' : (st.obd === 'no-reader' ? 'hot' : 'off'));
  // always show the state, like the other pills — a pill that vanishes when you
  // switch something off reads as 'did that work?' rather than 'it is off'.
  // amber when off, matching 'obd \u00b7 no reader': not recording is a state
  // worth noticing, not neutral background information.
  pill(st.recording ? 'recording on' : 'recording off', st.recording ? 'on' : 'hot');
  (st.streams || []).filter(function (x) { return x.live; }).forEach(function (x) {
    pill(x.name + ' streaming', 'on');   // green: streaming is a good state
  });
  if (st.storage) {
    var s3 = st.storage;
    // amber once the card is nearly full: pruning silently eats the oldest footage
    pill(s3.clips_gb + ' GB clips \u00b7 ' + s3.free_gb + ' GB free',
         s3.free_gb < 2 ? 'hot' : 'off');
  }
  var camsUp = (st.cameras || []).filter(function (c) { return c.up; }).length;
  pill(camsUp + (camsUp === 1 ? ' camera' : ' cameras'), camsUp ? 'on' : 'off');

  /* build every tile as a spec, then order them */
  var specs = [];
  var obdReady = st.obd === 'connected';
  specs.push({
    id: 'gauges', group: 'Engine', title: 'Car data',
    sub: !st.uplink ? 'No signal \u2014 the dashboard needs the car online'
                    : (obdReady ? 'Live from the OBD reader'
                                : 'Sample gauges \u2014 no reader plugged in yet'),
    cls: obdReady ? 'live' : null,
    onClick: function () {
      if (!st.uplink) { openFrame('Car data', '/offline'); return; }
      openFrame('Car data', obdReady ? CLOUD_HUD : CLOUD_HUD_DEMO);
    }
  });

  (st.cameras || []).forEach(function (c) {
    specs.push({
      id: 'cam:' + c.slug, group: 'Camera', title: c.label,
      thumb: 'http://' + HOST + ':' + c.port + '/snapshot', up: c.up,
      cls: c.up ? 'live' : null,
      onClick: function () { openCamera(c.label, c.port); }
    });
  });

  (st.cloud_cameras || []).forEach(function (c) {
    specs.push({
      id: 'cloud:' + c.slug, group: 'Home', title: c.label,
      thumb: '/thumb/' + c.slug, interval: 120000, up: c.status === 'online',
      cls: c.status === 'online' ? 'live' : null,
      onClick: function () { openCloudCam(c.label, c.slug); }
    });
  });

  specs.push({
    id: 'record', group: 'Camera', title: 'Cabin recording',
    sub: st.recording ? 'Recording the whole drive, one minute per file'
                      : 'Off \u2014 only motion clips. Tap to record continuously',
    cls: st.recording ? 'on' : null, state: st.recording ? 'ON' : 'OFF',
    onClick: function () {
      fetch('/record?on=' + (st.recording ? '0' : '1'), { method: 'POST' })
        .then(refresh).catch(refresh);
    }
  });

  specs.push({
    id: 'drive', group: 'Engine', title: 'Last drive',
    sub: st.obd === 'connected' ? 'Distance, duration and top speed'
                                : 'Nothing logged yet \u2014 needs the OBD reader',
    onClick: function () {
      openView('Last drive', function () {
        var box = el('div');
        box.style.cssText = 'position:absolute;inset:0;overflow:auto;padding:22px;color:var(--text)';
        box.innerHTML = '<div style="color:var(--muted)">Loading\u2026</div>';
        stage.appendChild(box);
        fetch('/api/drive').then(function (r) { return r.json(); }).then(function (d) {
          if (d.none) {
            box.innerHTML = '<div style="color:var(--muted);line-height:1.6">'
              + 'No drives logged yet.<br><br>This fills in once the OBD reader is plugged '
              + 'into the car and pairs \u2014 distance is worked out from the speed readings, '
              + 'so it needs no GPS.</div>';
            return;
          }
          function row(k, v) {
            return v == null ? '' :
              '<div style="display:flex;justify-content:space-between;gap:16px;padding:11px 0;'
              + 'border-bottom:1px solid var(--line)"><span style="color:var(--muted)">' + k
              + '</span><strong style="font-variant-numeric:tabular-nums">' + v + '</strong></div>';
          }
          var mins = null;
          if (d.started && d.ended) {
            mins = Math.round((new Date(d.ended) - new Date(d.started)) / 60000);
          }
          box.innerHTML =
            '<div style="font-size:.75rem;letter-spacing:.14em;color:var(--muted);'
            + 'text-transform:uppercase;margin-bottom:14px">Last drive</div>'
            + row('Distance', d.km + ' km')
            + row('Duration', mins == null ? null : mins + ' min')
            + row('Top speed', d.max_speed == null ? null : d.max_speed + ' km/h')
            + row('Peak RPM', d.max_rpm)
            + row('Max coolant', d.max_coolant == null ? null : d.max_coolant + ' \u00b0C')
            + row('Lowest battery', d.min_volts == null ? null : d.min_volts + ' V')
            + row('Samples', d.samples)
            + '<div style="color:var(--muted);font-size:.8rem;margin-top:16px">'
            + 'Distance is integrated from speed readings \u2014 no GPS needed.</div>';
        }).catch(function () { box.innerHTML = '<div style="color:var(--red)">Could not load.</div>'; });
      });
    }
  });

  specs.push({
    id: 'home', group: 'Home', title: 'What happened at home',
    sub: 'People, vehicles and animals seen by the house cameras',
    onClick: function () {
      openView('At home', function () {
        var box = el('div');
        box.style.cssText = 'position:absolute;inset:0;overflow:auto;padding:18px';
        box.innerHTML = '<div style="color:var(--muted)">Loading\u2026</div>';
        stage.appendChild(box);
        fetch('/api/events').then(function (r) { return r.json(); }).then(function (list) {
          if (!list.length) {
            box.innerHTML = '<div style="color:var(--muted)">Nothing notable in the last 12 hours.</div>';
            return;
          }
          var ICON = { person: 'P', vehicle: 'V', animal: 'A',
                       possible_weapon: '\u26A0', rule: '\u2699' };
          box.innerHTML = list.map(function (e) {
            var t = new Date(e.at);
            var mins = Math.round((Date.now() - t) / 60000);
            var ago = mins < 60 ? mins + ' min ago'
                    : (mins < 1440 ? Math.round(mins / 60) + ' h ago'
                                   : Math.round(mins / 1440) + ' d ago');
            return '<div style="display:flex;gap:12px;align-items:baseline;padding:11px 0;'
              + 'border-bottom:1px solid var(--line)">'
              + '<span style="font-size:1.1rem">' + (ICON[e.kind] || '\u2022') + '</span>'
              + '<div style="flex:1;min-width:0"><div><strong>' + e.kind.replace('_', ' ')
              + '</strong> \u00b7 ' + e.camera + '</div>'
              + (e.note ? '<div style="color:var(--muted);font-size:.8rem">' + e.note + '</div>' : '')
              + '</div><span style="color:var(--muted);font-size:.8rem;white-space:nowrap">'
              + ago + '</span></div>';
          }).join('');
        }).catch(function () { box.innerHTML = '<div style="color:var(--red)">Could not load.</div>'; });
      });
    }
  });

  specs.push({
    id: 'saveclip', group: 'Camera', title: 'Save last 2 min',
    sub: (st.saved_clips ? st.saved_clips + ' clip' + (st.saved_clips === 1 ? '' : 's') + ' kept safe. '
                         : '') + 'Tap after something happens \u2014 keeps it from being pruned',
    onClick: function (btn) {
      fetch('/save-clips', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          alert(d.saved > 0
            ? 'Saved ' + d.saved + ' clip' + (d.saved === 1 ? '' : 's') + '. They will not be deleted.'
            : (d.saved === 0 ? 'Nothing recorded in the last 2 minutes.' : 'Could not save.'));
          refresh();
        })
        .catch(function () { alert('Could not save.'); });
    }
  });

  var recPort = (st.cameras && st.cameras[0]) ? st.cameras[0].port : 8090;
  specs.push({
    id: 'recordings', group: 'Camera', title: 'Recordings',
    sub: 'Clips saved on board, newest first',
    onClick: function () { openFrame('Recordings', 'http://' + HOST + ':' + recPort + '/rec'); }
  });

  var STREAM_LABEL = { drone: 'Drone', rear: 'GR86 Rear' };
  var STREAM_HINT = {
    drone: 'Waiting for the drone to start streaming',
    rear: 'Waiting \u2014 nothing is sending video to this feed yet'
  };
  // Always shown, even when idle. Hiding them made tiles vanish and reappear,
  // which shuffles the layout you dragged into order — worse than the clutter.
  (st.streams || []).forEach(function (x) {
    var nice = STREAM_LABEL[x.name] || (x.name.charAt(0).toUpperCase() + x.name.slice(1));
    specs.push({
      id: 'stream:' + x.name, group: 'Relay', title: nice,
      sub: x.live ? 'Streaming now \u2014 tap to watch'
                  : (STREAM_HINT[x.name] || 'Nothing arriving on this feed yet'),
      cls: x.live ? 'live' : null,
      // a still pulled off the live stream, same as a camera tile
      thumb: x.live ? '/thumb-stream/' + x.name : null,
      slow: true, up: x.live,
      onClick: function () { openFrame(nice, 'http://' + HOST + ':%WEBRTC%/' + x.name); }
    });
  });

  specs.push({
    id: 'power', group: 'Power', title: 'Shut down',
    sub: 'Do this before you cut the power', cls: 'danger',
    onClick: function () { openFrame('Shut down', '/power'); }
  });

  /* apply the saved order; anything new lands at the end */
  var byId = {};
  specs.forEach(function (sp) { byId[sp.id] = sp; });
  var ordered = [];
  savedOrder.forEach(function (id) { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
  specs.forEach(function (sp) { if (byId[sp.id]) ordered.push(sp); });

  tilesEl.innerHTML = '';
  ordered.forEach(function (sp) { tilesEl.appendChild(tile(sp)); });
}

function openCloudCam(title, slug) {
  openView(title, function () {
    var img = document.createElement('img');
    var base = '/thumb/' + slug + '?full=1&';
    function tick() { img.src = base + Date.now(); snapTimer = setTimeout(tick, 3000); }
    img.onerror = function () { snapTimer = setTimeout(tick, 5000); };
    stage.appendChild(img);
    var hint = el('div', null, 'From the cloud \u00b7 updates every few seconds');
    hint.id = 'hint';
    stage.appendChild(hint);
    tick();
  });
}

function refresh() {
  // Rebuilding the tiles mid-drag tears the dragged node out of the DOM and
  // leaves a duplicate behind, so never re-render while reordering.
  if (reordering || drag) return;
  fetch('/api/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (st) {
      if (reordering || drag) return;
      if (!document.body.classList.contains('viewing')) render(st);
    })
    .catch(function () {});
}
refresh();
setInterval(refresh, 10000);

/* ---- faint screensaver background (same look as the main app) ---- */
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var CHARS = 'アカサタナハマヤラワ0123456789'.split('');

  /* glyph rain */
  var rc = document.getElementById('bgrain'), rx = rc.getContext('2d');
  var cols, drops, speeds, bright;
  function sizeRain() {
    rc.width = window.innerWidth; rc.height = window.innerHeight;
    cols = Math.ceil(rc.width / 18);
    drops = []; speeds = []; bright = {};
    for (var i = 0; i < cols; i++) {
      drops.push(Math.random() * (rc.height / 18));
      speeds.push(0.35 + Math.random() * 0.5);
    }
  }
  sizeRain();
  window.addEventListener('resize', sizeRain);
  var lastR = 0;
  function rain(t) {
    requestAnimationFrame(rain);
    if (t - lastR < 40) return;            // ~25fps, same cap as the app
    lastR = t;
    rx.fillStyle = 'rgba(4,0,3,0.13)'; rx.fillRect(0, 0, rc.width, rc.height);
    for (var i = 0; i < cols; i++) {
      var ch = CHARS[Math.floor(Math.random() * CHARS.length)];
      rx.fillStyle = bright[i]
        ? 'hsl(325,100%,' + (60 + Math.random() * 30) + '%)'
        : 'hsla(322,95%,' + (42 + Math.random() * 22) + '%,' + (0.45 + Math.random() * 0.55) + ')';
      rx.font = (13 + Math.floor(Math.random() * 4)) + 'px monospace';
      rx.fillText(ch, i * 18, drops[i] * 18);
      drops[i] += speeds[i];
      if (drops[i] * 18 > rc.height && Math.random() > 0.965) {
        drops[i] = 0;
        if (Math.random() > 0.75) { bright[i] = 1; } else { delete bright[i]; }
      }
    }
  }
  requestAnimationFrame(rain);

  /* magenta embers along the bottom */
  var fc = document.getElementById('bgfire'), fx = fc.getContext('2d');
  var W, H = 120, grid;
  function sizeFire() {
    W = Math.max(1, Math.floor(window.innerWidth / 2));
    fc.width = W; fc.height = H;
    grid = new Uint8Array(W * (H + 2));
  }
  sizeFire();
  window.addEventListener('resize', sizeFire);
  var pal = [];
  for (var i = 0; i < 256; i++) {
    if (i < 64) pal.push([i * 3, 0, Math.floor(i * 1.5)]);
    else if (i < 128) pal.push([192 + (i - 64), Math.floor((i - 64) * 0.3), 96 + (i - 64)]);
    else if (i < 192) pal.push([255, 20 + (i - 128), Math.min(255, 159 + (i - 128))]);
    else pal.push([255, Math.min(255, 84 + (i - 192) * 2), Math.min(255, 223 + Math.floor((i - 192) * 0.5))]);
  }
  var lastF = 0;
  function fire(t) {
    requestAnimationFrame(fire);
    if (t - lastF < 40) return;
    lastF = t;
    for (var x = 0; x < W; x++) grid[(H + 1) * W + x] = Math.random() > 0.3 ? 255 : Math.floor(Math.random() * 200);
    for (var y = 0; y < H; y++) {
      for (var x2 = 0; x2 < W; x2++) {
        var sum = grid[(y + 1) * W + ((x2 - 1 + W) % W)] + grid[(y + 1) * W + x2]
                + grid[(y + 1) * W + ((x2 + 1) % W)] + grid[(y + 2) * W + x2];
        grid[y * W + x2] = Math.max(0, Math.floor(sum / 4) - (Math.random() > 0.5 ? 1 : 0));
      }
    }
    var img = fx.createImageData(W, H);
    for (var k = 0; k < W * H; k++) {
      var c = pal[grid[k]];
      img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1];
      img.data[k * 4 + 2] = c[2]; img.data[k * 4 + 3] = grid[k];
    }
    fx.putImageData(img, 0, 0);
  }
  requestAnimationFrame(fire);
})();
</script>
</body></html>"""

OFFLINE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gauges offline</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0c;color:#ecedf0;
    font-family:-apple-system,system-ui,sans-serif;display:flex;
    align-items:center;justify-content:center;text-align:center}
  .b{max-width:440px;padding:2rem}
  h1{font-size:1.3rem;letter-spacing:.12em;margin:0 0 .8em;color:#c1121f}
  p{opacity:.65;line-height:1.55;margin:0 0 .8em;font-size:.95rem}
</style></head>
<body><div class="b">
  <h1>GAUGES NEED SIGNAL</h1>
  <p>The live dashboard is served from the cloud, and the car has no uplink
     right now.</p>
  <p>Nothing is being lost &mdash; the OBD reader keeps logging to the Pi and
     everything uploads by itself once you're back on home Wi-Fi.</p>
</div></body></html>"""

POWER_PAGE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GR86 &middot; Power</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0c;color:#ecedf0;
    font-family:-apple-system,system-ui,sans-serif;display:flex;
    align-items:center;justify-content:center;text-align:center}
  .b{max-width:460px;padding:2rem;display:flex;flex-direction:column;gap:1.1rem}
  h1{font-size:1.4rem;letter-spacing:.1em;margin:0;font-weight:650}
  p{opacity:.65;line-height:1.5;margin:0;font-size:.95rem}
  button{font:inherit;font-size:1.35rem;font-weight:650;letter-spacing:.08em;
    padding:1.4rem 1rem;border-radius:14px;border:1px solid #c1121f;
    background:#c1121f;color:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent}
  button:active{transform:scale(.985)}
  button:disabled{opacity:.45}
  button:focus-visible{outline:3px solid #fff;outline-offset:3px}
  /* full-screen result state — impossible to miss inside a frame */
  #done{position:fixed;inset:0;display:none;flex-direction:column;gap:1rem;
    align-items:center;justify-content:center;padding:2rem;background:#0a0a0c}
  #done.show{display:flex}
  #done .big{font-size:1.6rem;font-weight:700;letter-spacing:.12em}
  #done .sub{opacity:.7;font-size:.95rem;max-width:22em;line-height:1.5}
  .spin{width:34px;height:34px;border-radius:50%;border:3px solid #2a2c33;
    border-top-color:#c1121f;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation:none}}
  .off .big{color:#3fb27f}
</style></head>
<body>
<div class="b" id="ask">
  <h1>SHUT DOWN NODE 5</h1>
  <p>Do this before you cut the power. The card takes real writes &mdash; pulling
     12&nbsp;V mid-write can corrupt it.</p>
  <button id="go">SHUT DOWN</button>
  <p><strong>It can only be switched back on at the car</strong> &mdash; there is no
     screen and no remote power-on.</p>
</div>

<div id="done">
  <div class="spin" id="spin"></div>
  <div class="big" id="bigtext">SHUTTING DOWN&hellip;</div>
  <div class="sub" id="subtext">Waiting for Node 5 to stop responding.</div>
</div>

<script>
var go = document.getElementById('go');
var ask = document.getElementById('ask');
var done = document.getElementById('done');
var big = document.getElementById('bigtext');
var sub = document.getElementById('subtext');
var spin = document.getElementById('spin');

function confirmedOff() {
  done.className = 'show off';
  spin.style.display = 'none';
  big.textContent = 'NODE 5 IS OFF';
  sub.textContent = 'It has stopped responding. Safe to cut the power now. ' +
                    'To bring it back, power it off and on at the car.';
}

// Poll our own health endpoint: when it stops answering, the node really is down.
function watch(tries) {
  if (tries > 40) {           // ~2 min with no confirmation
    sub.textContent = 'Still responding. If nothing happens, the shutdown may have ' +
                      'been refused — check the Pi.';
    return;
  }
  fetch('/healthz', { cache: 'no-store' })
    .then(function () { setTimeout(function () { watch(tries + 1); }, 3000); })
    .catch(confirmedOff);     // unreachable = powered down
}

go.onclick = function () {
  if (!confirm('Shut down Node 5 now? It can only be switched back on at the car.')) return;
  go.disabled = true;
  ask.style.display = 'none';
  done.className = 'show';
  fetch('/power', { method: 'POST' }).catch(function () {});
  setTimeout(function () { watch(0); }, 2000);
};
</script>
</body></html>"""


def shell_html():
    return (SHELL
            .replace("%CLOUD_HUD%", json.dumps(CLOUD_HUD))
            .replace("%CLOUD_HUD_DEMO%", json.dumps(CLOUD_HUD_DEMO))
            .replace("%WEBRTC%", str(DRONE_WEBRTC_PORT))
            .replace("%DRONEPATH%", DRONE_PATH))


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, body, ctype="text/html; charset=utf-8", code=200):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in ("/", "/index.html", "/hud"):
            self._send(shell_html())
        elif path == "/offline":
            self._send(OFFLINE)
        elif path == "/power":
            self._send(POWER_PAGE)
        elif path == "/api/status":
            self._send(json.dumps(status()), "application/json")
        elif path.startswith("/thumb-stream/"):
            data = stream_thumb(path[len("/thumb-stream/"):])
            if data:
                self._send(data, "image/jpeg")
            else:
                self._send("no frame", "text/plain", 404)
        elif path.startswith("/thumb/"):
            data = cloud_thumb(path[len("/thumb/"):], full="full=1" in self.path)
            if data:
                self._send(data, "image/jpeg")
            else:
                self._send("no frame", "text/plain", 404)
        elif path == "/api/events":
            self._send(json.dumps(home_events()), "application/json")
        elif path == "/api/drive":
            self._send(json.dumps(drive_summary() or {"none": True}), "application/json")
        elif path == "/api/order":
            self._send(json.dumps(tile_order()), "application/json")
        elif path == "/healthz":
            self._send("ok", "text/plain")
        else:
            self._send("not found", "text/plain", 404)

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/order":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                order = json.loads(self.rfile.read(length).decode())
            except (ValueError, OSError):
                order = None
            ok = isinstance(order, list) and save_tile_order(order)
            self._send(json.dumps({"saved": bool(ok)}), "application/json")
            return
        if path == "/save-clips":
            n = save_clips(2)
            self._send(json.dumps({"saved": n, "total": saved_count()}), "application/json")
            return
        if path == "/record":
            want_on = "on=1" in self.path
            # the flag lives in vigil's directory, so go through sudo (peta has NOPASSWD)
            cmd = (["sudo", "-n", "touch", RECORD_FLAG] if want_on
                   else ["sudo", "-n", "rm", "-f", RECORD_FLAG])
            try:
                subprocess.run(cmd, check=False, timeout=8)
            except (OSError, subprocess.SubprocessError):
                pass
            with _status_lock:          # force the next /api/status to re-read
                _status_cache["at"] = 0.0
            self._send(json.dumps({"recording": os.path.exists(RECORD_FLAG)}),
                       "application/json")
            return
        if path != "/power":
            self._send("not found", "text/plain", 404)
            return
        dry = "dry=1" in self.path
        cmd = ["sudo", "-n", "systemctl", "poweroff"]
        if dry:
            self._send("dry-run: would run " + " ".join(cmd), "text/plain")
            return
        self._send("shutting down", "text/plain")

        def go():
            time.sleep(1.5)  # let the response reach the browser first
            subprocess.run(cmd, check=False)

        threading.Thread(target=go, daemon=True).start()

    def log_message(self, *_):  # quiet; journald captures stderr anyway
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"[gr86-hud] command centre on :{PORT} (cloud gauges -> {CLOUD_HUD})")
        httpd.serve_forever()
