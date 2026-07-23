#!/usr/bin/env python3
"""Vigil hotplug supervisor — auto-detect USB cameras on this node.

Plug a camera into the node -> a Vigil feed appears automatically, labelled by
the camera's MODEL, streaming on its own LAN port + uploading to the cloud.
Unplug it -> its daemon stops and the camera is marked OFFLINE (until replugged).

Each physical camera gets a STABLE slug + port (keyed by its /dev/v4l/by-id
identity, persisted) so moving it between USB ports keeps the same feed.

Runs one vigil_cam.py per camera. Reads /opt/vigil/.env for cloud creds/tunables;
per-camera overrides (device/slug/label/port + optional res/detect) always win.
"""
import os, re, glob, json, time, signal, socket, hashlib, subprocess, threading, urllib.request

BYID_GLOB  = "/dev/v4l/by-id/usb-*-video-index0"   # by-id lists ONLY real USB cams (not the Pi codec/ISP nodes)
STATE_FILE = "/opt/vigil/hotplug.json"
VCAM       = "/opt/vigil/vigil_cam.py"
PORT_BASE, PORT_MAX = 8090, 8110
POLL       = 6

def load_env(path):
    e = {}
    try:
        for line in open(path):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1); e[k] = v.strip().strip('"').strip("'")
    except Exception: pass
    return e

ENV      = load_env("/opt/vigil/.env")
SUPA     = (ENV.get("SUPABASE_URL") or "").rstrip("/")
ANON     = ENV.get("SUPABASE_ANON_KEY") or ENV.get("SUPABASE_ANON")
NODE     = os.environ.get("VIGIL_NODE") or re.sub(r"^sinsera-", "", socket.gethostname()).replace("-", "")
LOCATION = os.environ.get("VIGIL_LOCATION", "")
CAM_W    = os.environ.get("VIGIL_CAM_WIDTH", "1920")
CAM_H    = os.environ.get("VIGIL_CAM_HEIGHT", "1080")
DETECT   = os.environ.get("VIGIL_DETECT", "1")            # DNN person detection default on; set 0 if the node saturates
JPEG_Q   = os.environ.get("VIGIL_JPEG_QUALITY", "88")

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect((ENV.get("LAN_PROBE", "192.168.4.1"), 80))
        ip = s.getsockname()[0]; s.close(); return ip
    except Exception:
        try: return socket.gethostbyname(socket.gethostname())
        except Exception: return None
IP = lan_ip()

_tok = {"jwt": None, "exp": 0.0}
def token():
    if _tok["jwt"] and time.time() < _tok["exp"]:
        return _tok["jwt"]
    try:
        r = urllib.request.urlopen(urllib.request.Request(
            SUPA + "/auth/v1/token?grant_type=password",
            data=json.dumps({"email": ENV["VIGIL_EMAIL"], "password": ENV["VIGIL_PASSWORD"]}).encode(),
            headers={"apikey": ANON, "Content-Type": "application/json"}), timeout=10)
        b = json.load(r); _tok["jwt"] = b["access_token"]; _tok["exp"] = time.time() + 3000
        return _tok["jwt"]
    except Exception as e:
        print("[hotplug] auth failed:", e, flush=True); return None

def patch_cam(slug, body):
    jwt = token()
    if not jwt: return
    try:
        urllib.request.urlopen(urllib.request.Request(
            SUPA + f"/rest/v1/vigil_cameras?slug=eq.{slug}",
            data=json.dumps(body).encode(), method="PATCH",
            headers={"apikey": ANON, "Authorization": "Bearer " + jwt,
                     "Content-Type": "application/json", "Prefer": "return=minimal"}), timeout=10)
    except Exception as e:
        print("[hotplug] patch", slug, "failed:", e, flush=True)

def model_of(byid):
    n = re.sub(r"^usb-", "", byid); n = re.sub(r"-video-index0$", "", n)
    n = n.replace("_", " ")
    n = re.sub(r"\s+(?:[A-Za-z]*\d{4,}[\w-]*|SR\d+[\w-]*)$", "", n)  # drop trailing serials
    words = n.split()
    h = len(words) // 2
    if h and words[:h] == words[h:2*h]:                            # de-dupe "CC HD webcam CC HD webcam"
        words = words[:h]
    n = re.sub(r"\s+", " ", " ".join(words)).strip()
    return (n or "USB Camera")[:48]

def slug_of(byid):
    return f"{NODE}-{hashlib.sha1(byid.encode()).hexdigest()[:6]}"

persist = {}
try: persist = json.load(open(STATE_FILE))
except Exception: persist = {}
def save():
    try: json.dump(persist, open(STATE_FILE, "w"))
    except Exception: pass

state = {}   # byid -> {proc, port, slug, label}

def port_for(byid):
    if byid in persist and "port" in persist[byid]:
        return persist[byid]["port"]
    used = {v.get("port") for v in persist.values()} | {s["port"] for s in state.values()}
    for p in range(PORT_BASE, PORT_MAX):
        if p not in used: return p
    return PORT_BASE

def start(byid, dev):
    slug, label, port = slug_of(byid), model_of(byid), port_for(byid)
    persist[byid] = {"slug": slug, "port": port, "label": label}; save()
    e = dict(os.environ); e.update(ENV)   # base: process env + .env creds/tunables
    e.update(CAM_DEVICE=dev, CAMERA_SLUG=slug, CAMERA_LABEL=label, MJPEG_PORT=str(port),
             CAM_WIDTH=CAM_W, CAM_HEIGHT=CAM_H, JPEG_QUALITY=JPEG_Q, DETECT=DETECT,
             PYGAME_HIDE_SUPPORT_PROMPT="1", OPENCV_LOG_LEVEL="ERROR")
    try:
        out = None
        try:
            os.makedirs("/var/log/vigil", exist_ok=True)
            out = open(f"/var/log/vigil/{slug}.log", "ab")
        except Exception:
            out = None   # fall back to inheriting the supervisor's stdout (systemd journal/log)
        proc = subprocess.Popen(["python3", VCAM], env=e, cwd="/opt/vigil",
                                stdout=out, stderr=(subprocess.STDOUT if out else None),
                                preexec_fn=os.setsid)
    except Exception as ex:
        print("[hotplug] start failed", slug, ex, flush=True); return
    state[byid] = {"proc": proc, "port": port, "slug": slug, "label": label, "sync": 0.0}
    print(f"[hotplug] START '{label}' slug={slug} port={port} dev={dev}", flush=True)

def sync_row(byid):
    # The daemon registers slug+label itself; we own the LAN addr + port + location.
    # Re-assert periodically (idempotent) so a register-vs-patch race self-heals.
    st = state.get(byid)
    if not st or (time.time() - st["sync"]) < 20:
        return
    # Supervisor is authoritative on presence + identity: device plugged in & daemon
    # running -> online, and the label always reflects the camera MODEL (the daemon only
    # sets label once at registration, so it can drift; re-assert it here).
    body = {"ip_address": IP, "mjpeg_port": st["port"], "connection": "lan", "status": "online", "label": st["label"]}
    if LOCATION: body["location"] = LOCATION
    patch_cam(st["slug"], body)
    st["sync"] = time.time()

def stop(byid):
    st = state.pop(byid, None)
    if not st: return
    print(f"[hotplug] STOP '{st['label']}' slug={st['slug']} (unplugged) -> offline", flush=True)
    try: os.killpg(os.getpgid(st["proc"].pid), signal.SIGTERM)
    except Exception: pass
    patch_cam(st["slug"], {"status": "offline"})

def reconcile():
    cur = {os.path.basename(p): p for p in sorted(glob.glob(BYID_GLOB))}
    for byid, path in cur.items():
        if byid not in state:
            start(byid, path)
        elif state[byid]["proc"].poll() is not None:      # daemon died -> relaunch
            print("[hotplug] daemon exited, relaunching", state[byid]["slug"], flush=True)
            del state[byid]; start(byid, path)
        else:
            sync_row(byid)                                 # keep LAN addr/port/location asserted
    for byid in list(state):
        if byid not in cur:
            stop(byid)

def shutdown(*_):
    for byid in list(state):
        try: os.killpg(os.getpgid(state[byid]["proc"].pid), signal.SIGTERM)
        except Exception: pass
    raise SystemExit(0)
signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

print(f"[hotplug] up: node={NODE} ip={IP} loc={LOCATION or '-'} res={CAM_W}x{CAM_H} detect={DETECT}", flush=True)
while True:
    try: reconcile()
    except Exception as e: print("[hotplug] reconcile err:", e, flush=True)
    time.sleep(POLL)
