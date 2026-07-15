#!/usr/bin/env python3
"""Vigil — headless security camera (Pi Zero 2 W + Logitech C920).

No video effects, no display, no frills — pure surveillance, running flat-out:
  • Capture the C920 at the best rate the Zero 2 W sustains.
  • Feed every frame to the LAN MJPEG server (full-rate local view).
  • Lightweight frame-diff MOTION detection → posts a motion event + bumps the
    upload rate briefly so the remote view catches the action.
  • Upload JPEG snapshots to the PRIVATE vigil-frames bucket (owner-RLS) at a
    throttled rate for the sinsera.co remote view.
  • Heartbeat so the camera shows ONLINE on sinsera.co/mirror... /vigil.

All cloud calls are best-effort and run off the capture thread — a network blip
never stalls the camera. Tunables come from /opt/vigil/.env.
"""
from __future__ import annotations

import os
import time
import queue
import threading
import datetime
import tempfile
import shutil
import subprocess

import cv2
import numpy as np

from vigil_mjpeg import LATEST, serve as serve_mjpeg
from vigil_auth import VigilCloud

# ── Tunables (env, with sane Zero-2-W defaults) ──
W            = int(os.environ.get("CAM_WIDTH", "640"))
H            = int(os.environ.get("CAM_HEIGHT", "480"))
CAM_FPS      = int(os.environ.get("CAM_FPS", "15"))          # capture/LAN rate
CAM_DEVICE   = os.environ.get("CAM_DEVICE", "").strip()  # explicit device PATH (e.g. a stable /dev/v4l/by-path/… symlink) — wins over CAM_INDEX so USB re-enumeration on reboot can't shuffle which physical camera a service gets
CAM_INDEX    = int(os.environ.get("CAM_INDEX") or (int(os.environ.get("CAM_SLOT", "0")) * 2))  # dual-cam uses CAM_SLOT 0/1 → /dev/video0,2
CAM_V4L2     = os.environ.get("CAM_V4L2", "").strip()  # per-cam v4l2 controls "k=v,k=v" (WB/exposure/contrast tuning)
CAM_FOURCC   = os.environ.get("CAM_FOURCC", "").strip()  # e.g. "MJPG" — needed for 720p+ over USB2
SHARPEN      = float(os.environ.get("CAM_SHARPEN", "0"))  # unsharp-mask amount (0=off, ~0.6 crisps a soft lens)
# Rotation is LIVE-updatable from the app (kiosk_config __cam_rotation__ → poll_rotation);
# CAM_ROTATE is just the boot default. Held in a dict so a background poll can change it.
ROT          = {"deg": int(os.environ.get("CAM_ROTATE", "0")) % 360}  # 0/90/180/270 — for upside-down / sideways mounts
JPEG_Q       = int(os.environ.get("JPEG_QUALITY", "75"))
CLOUD_FPS    = float(os.environ.get("CLOUD_FPS", "2"))        # remote snapshot rate (idle)
CLOUD_FPS_HOT= float(os.environ.get("CLOUD_FPS_MOTION", "4")) # remote rate while motion
MJPEG_PORT   = int(os.environ.get("MJPEG_PORT", "8090"))
MOTION_THRESH= float(os.environ.get("MOTION_THRESHOLD", "5.0"))   # mean abs diff
MOTION_AREA  = float(os.environ.get("MOTION_MIN_AREA", "0.012"))  # frac of frame changed
MOTION_COOLDOWN = float(os.environ.get("MOTION_COOLDOWN_S", "8")) # min secs between events
HEARTBEAT_S  = int(os.environ.get("HEARTBEAT_S", "30"))
RECORD_SECS  = int(os.environ.get("RECORD_SECS", "8"))            # clip length
RECORD_ON_MOTION = os.environ.get("RECORD_ON_MOTION", "0") == "1" # auto-record motion clips
RECORD_DIR   = os.environ.get("RECORD_DIR", "/opt/vigil/recordings")
RECORD_MAX_GB = float(os.environ.get("RECORD_MAX_GB", "50"))       # local retention cap; oldest clips pruned over this

# ── Object detection (MobileNet-SSD via OpenCV DNN) — optional, off the hot path ──
DETECT        = os.environ.get("DETECT", "0") == "1"                       # master toggle
DETECT_EVERY  = max(1, int(os.environ.get("DETECT_EVERY", "6")))          # run inference every Nth frame
DETECT_CONF   = float(os.environ.get("DETECT_CONF", "0.5"))               # min confidence to show a box
DETECT_MODELDIR = os.environ.get("DETECT_MODEL_DIR", "/opt/vigil/models")  # holds the .prototxt + .caffemodel
DETECT_ALERT  = {c.strip() for c in os.environ.get("DETECT_ALERT", "person").split(",") if c.strip()}   # classes that raise an event / trigger recording
DETECT_CLASSES = {c.strip() for c in os.environ.get("DETECT_CLASSES", "").split(",") if c.strip()}       # empty = draw every class
# Pascal-VOC 20-class labels the MobileNet-SSD model emits (index → name).
_VOC = ["background", "aeroplane", "bicycle", "bird", "boat", "bottle", "bus", "car", "cat",
        "chair", "cow", "diningtable", "dog", "horse", "motorbike", "person", "pottedplant",
        "sheep", "sofa", "train", "tvmonitor"]

class Detector:
    """Runs MobileNet-SSD inference on a background thread so the capture/stream
    loop never blocks. The loop hands it the newest frame; it caches boxes that
    the loop draws every frame. hit_alert is True while an alert-class is present."""
    def __init__(self):
        self.net = None
        self.lock = threading.Lock()
        self.boxes: list = []          # [(label, conf, x1, y1, x2, y2)]
        self.hit_alert = False
        self._frame = None
        self._new = threading.Event()
        if not DETECT:
            return
        proto = os.path.join(DETECT_MODELDIR, "MobileNetSSD_deploy.prototxt")
        model = os.path.join(DETECT_MODELDIR, "MobileNetSSD_deploy.caffemodel")
        try:
            self.net = cv2.dnn.readNetFromCaffe(proto, model)
            self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            threading.Thread(target=self._worker, daemon=True).start()
            print(f"[vigil] object detection ON (conf≥{DETECT_CONF}, alert={sorted(DETECT_ALERT)})", flush=True)
        except Exception as e:  # noqa: BLE001 — missing/corrupt model → run without detection
            self.net = None
            print(f"[vigil] object detection OFF — model load failed ({model}): {e}", flush=True)

    def submit(self, frame) -> None:
        if self.net is None:
            return
        self._frame = frame          # keep only the latest; worker drops stale frames
        self._new.set()

    def _worker(self) -> None:
        while True:
            self._new.wait(); self._new.clear()
            frame = self._frame
            if frame is None:
                continue
            try:
                h, w = frame.shape[:2]
                blob = cv2.dnn.blobFromImage(cv2.resize(frame, (300, 300)), 0.007843, (300, 300), 127.5)
                self.net.setInput(blob)
                det = self.net.forward()
                out, alert = [], False
                for i in range(det.shape[2]):
                    conf = float(det[0, 0, i, 2])
                    if conf < DETECT_CONF:
                        continue
                    idx = int(det[0, 0, i, 1])
                    label = _VOC[idx] if 0 <= idx < len(_VOC) else str(idx)
                    if DETECT_CLASSES and label not in DETECT_CLASSES:
                        continue
                    x1, y1 = int(det[0, 0, i, 3] * w), int(det[0, 0, i, 4] * h)
                    x2, y2 = int(det[0, 0, i, 5] * w), int(det[0, 0, i, 6] * h)
                    out.append((label, conf, x1, y1, x2, y2))
                    if label in DETECT_ALERT:
                        alert = True
                with self.lock:
                    self.boxes, self.hit_alert = out, alert
            except Exception as e:  # noqa: BLE001
                print(f"[vigil] detection error: {e}", flush=True)
            time.sleep(0.01)

    def draw(self, frame):
        with self.lock:
            boxes = list(self.boxes)
        for label, conf, x1, y1, x2, y2 in boxes:
            col = (0, 0, 230) if label in DETECT_ALERT else (0, 210, 90)   # red for alert class, green otherwise
            cv2.rectangle(frame, (x1, y1), (x2, y2), col, 2)
            cv2.putText(frame, f"{label} {int(conf * 100)}%", (x1 + 2, max(13, y1 - 5)),
                        cv2.FONT_HERSHEY_PLAIN, 1.1, col, 1, cv2.LINE_AA)
        return frame

def _prune_recordings():
    """Keep the local recordings dir under RECORD_MAX_GB by deleting the oldest clips."""
    import time as _t
    limit = RECORD_MAX_GB * (1024 ** 3)
    while True:
        try:
            fs = sorted((os.path.join(RECORD_DIR, f) for f in os.listdir(RECORD_DIR) if f.endswith(".mp4")),
                        key=os.path.getmtime)
            total = sum(os.path.getsize(f) for f in fs)
            n = 0
            while total > limit and fs:
                total -= os.path.getsize(fs[0]); os.remove(fs.pop(0)); n += 1
            if n:
                print(f"[vigil] pruned {n} old recordings (cap {RECORD_MAX_GB}GB)", flush=True)
        except OSError:
            pass
        _t.sleep(3600)

# Optional "HH:MM-HH:MM" window (supports overnight, e.g. 22:00-06:00). When set,
# armed/auto motion-recording only fires inside it. Empty = any time.
def _parse_window(spec):
    try:
        a, b = spec.split("-"); ah, am = a.split(":"); bh, bm = b.split(":")
        return (int(ah) * 60 + int(am), int(bh) * 60 + int(bm))
    except Exception:
        return None
RECORD_WINDOW = _parse_window(os.environ.get("RECORD_WINDOW", ""))
def _in_window(now):
    if not RECORD_WINDOW:
        return True
    lt = time.localtime(now); m = lt.tm_hour * 60 + lt.tm_min
    s, e = RECORD_WINDOW
    return (s <= m < e) if s <= e else (m >= s or m < e)

def _in_sched(now, start, end):
    """True if the app-set record window (HH:MM[:SS] strings) contains 'now' (overnight-aware). No window = always."""
    def _tm(t):
        try: p = str(t).split(":"); return int(p[0]) * 60 + int(p[1])
        except Exception: return None
    if not start or not end:
        return True
    s = _tm(start); e = _tm(end)
    if s is None or e is None:
        return True
    lt = time.localtime(now); m = lt.tm_hour * 60 + lt.tm_min
    return (s <= m < e) if s <= e else (m >= s or m < e)

# ── Motion display: black framebuffer that flashes RED on motion ──
# No-ops until an HDMI screen is plugged in (then /dev/fb0 appears). Best-effort.
_ind = {"on": None}
def set_motion_display(on: bool) -> None:
    if _ind["on"] == on:
        return
    _ind["on"] = on
    import struct
    r, g, b = (220, 0, 0) if on else (0, 0, 0)
    for fb in ("fb0", "fb1"):   # fb0 = HDMI, fb1 = SPI LCD HAT (if attached)
        try:
            bpp = int(open(f"/sys/class/graphics/{fb}/bits_per_pixel").read())
            w, h = (int(x) for x in open(f"/sys/class/graphics/{fb}/virtual_size").read().split(","))
            px = struct.pack("<H", ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) if bpp == 16 \
                 else struct.pack("<I", (r << 16) | (g << 8) | b)
            with open(f"/dev/{fb}", "wb") as f:
                f.write(px * (w * h))
        except Exception:
            pass  # that framebuffer not present


def _apply_v4l2():
    """Apply per-camera v4l2 controls (CAM_V4L2 env, "k=v,k=v") after the device is open.
    OpenCV resets controls on open, so tuning (white balance / exposure / contrast) must be
    re-applied on every (re)connect. Best-effort; order matters (e.g. white_balance_automatic=0
    before white_balance_temperature). Needs v4l2-ctl."""
    if not CAM_V4L2:
        return
    import subprocess
    try:
        subprocess.run(["v4l2-ctl", "-d", f"/dev/video{CAM_INDEX}", "-c", CAM_V4L2],
                       check=False, capture_output=True, timeout=5)
        print(f"[vigil] applied v4l2 controls: {CAM_V4L2}", flush=True)
    except Exception as e:
        print(f"[vigil] v4l2 tune failed: {e}", flush=True)

def open_camera():
    cap = cv2.VideoCapture(CAM_DEVICE if CAM_DEVICE else CAM_INDEX)  # path (stable by-path) or numeric index
    if CAM_FOURCC:  # set the codec before the resolution (drivers gate high-res modes on MJPG)
        try: cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*CAM_FOURCC))
        except Exception: pass
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, H)
    cap.set(cv2.CAP_PROP_FPS, CAM_FPS)
    try: cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception: pass
    if not cap.isOpened():
        return None
    _apply_v4l2()
    return cap


def main() -> None:
    print(f"[vigil] starting — {W}x{H}@{CAM_FPS} cloud~{CLOUD_FPS}fps motion@{MOTION_THRESH}", flush=True)
    threading.Thread(target=_prune_recordings, daemon=True).start()  # local storage retention
    serve_mjpeg(MJPEG_PORT)
    cloud = VigilCloud()

    # Background uploader: a 1-slot queue so we only ever push the freshest frame.
    upq: "queue.Queue[bytes]" = queue.Queue(maxsize=1)
    def uploader():
        while True:
            jpg = upq.get()
            try: cloud.upload_frame(jpg)
            except Exception as e: print(f"[vigil] upload_frame error: {e}", flush=True)
    threading.Thread(target=uploader, daemon=True).start()

    # Background heartbeat.
    def beat():
        while True:
            try: cloud.heartbeat()
            except Exception as e: print(f"[vigil] heartbeat error: {e}", flush=True)
            time.sleep(HEARTBEAT_S)
    threading.Thread(target=beat, daemon=True).start()

    # Background: poll the dashboard's "record" request (when cloud is on).
    record_req = threading.Event()
    def poll_req():
        while True:
            try:
                if cloud.poll_record_request():
                    record_req.set()
            except Exception as e:
                print(f"[vigil] poll_record_request error: {e}", flush=True)
            time.sleep(3)
    threading.Thread(target=poll_req, daemon=True).start()

    # Background: mirror this camera's ARMED state (dashboard toggle) so motion
    # auto-records only when the user has armed it (within RECORD_WINDOW if set).
    armed = threading.Event()
    def poll_armed():
        while True:
            try:
                armed.set() if cloud.poll_armed() else armed.clear()
            except Exception:
                pass
            time.sleep(5)
    threading.Thread(target=poll_armed, daemon=True).start()

    # Background: mirror the app-editable record-on-motion schedule.
    sched = {"on": False, "start": None, "end": None}
    def poll_sched():
        while True:
            try:
                s = cloud.poll_record_schedule()
                if s is not None:
                    sched.update(s)
            except Exception:
                pass
            time.sleep(5)
    threading.Thread(target=poll_sched, daemon=True).start()

    # Background: mirror the app-editable per-camera rotation (kiosk_config
    # __cam_rotation__). Lets the user rotate a camera live from the app.
    def poll_rot():
        while True:
            try:
                deg = cloud.poll_rotation()
                if deg is not None and deg != ROT["deg"]:
                    ROT["deg"] = deg
                    print(f"[vigil] rotation → {deg}°", flush=True)
            except Exception as e:
                print(f"[vigil] poll_rotation error: {e}", flush=True)
            time.sleep(8)
    threading.Thread(target=poll_rot, daemon=True).start()

    # OpenCV writes mp4v (MPEG-4 Part 2), which browsers' <video> CANNOT play — so
    # the app's Recordings player just showed nothing. Transcode to H.264 (yuv420p +
    # faststart) in place so every copy (SD, cloud, Node 3 archive) is browser-playable.
    # Falls back to the original file if ffmpeg is missing or fails.
    def _to_h264(path):
        if not shutil.which("ffmpeg"):
            return
        tmp = path + ".h264.mp4"
        try:
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
                 "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart", tmp],
                timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, path)      # in place → local + archive get H.264 too
            elif os.path.exists(tmp):
                os.remove(tmp)
        except Exception as e:
            print(f"[vigil] transcode failed: {e}", flush=True)
            try:
                if os.path.exists(tmp): os.remove(tmp)
            except Exception:
                pass

    # Background recording uploader (off the capture thread).
    def upload_rec(path, started, dur, kind):
        try:
            _to_h264(path)
            with open(path, "rb") as f:
                cloud.upload_recording(f.read(), started, dur, kind)
        except Exception:
            pass

    cap = None
    prev_gray = None
    last_cloud = 0.0
    last_motion_event = 0.0
    hot_until = 0.0
    last_cam_try = 0.0
    writer = None; rec_end = 0.0; rec_t0 = 0.0; rec_started = ""; rec_kind = "motion"; rec_path = ""
    detector = Detector()          # object detection (no-op unless DETECT=1 + model present)
    fc = 0                         # frame counter → paces inference cadence

    while True:
        now = time.time()
        if cap is None:
            if now - last_cam_try > 3.0:
                cap = open_camera(); last_cam_try = now
                if cap is None:
                    print("[vigil] waiting for camera…", flush=True)
            time.sleep(0.5); continue

        ok, frame = cap.read()
        if not ok or frame is None:   # ok can be True with a None frame on a flaky USB cam → guard before .shape
            print("[vigil] camera dropped — reopening", flush=True)
            try: cap.release()
            except Exception: pass
            cap = None; prev_gray = None; time.sleep(0.2); continue

        _deg = ROT["deg"]
        if _deg == 180:
            frame = cv2.rotate(frame, cv2.ROTATE_180)
        elif _deg == 90:
            frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        elif _deg == 270:
            frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
        if frame.shape[1] != W or frame.shape[0] != H:
            frame = cv2.resize(frame, (W, H))
        if SHARPEN > 0:  # unsharp mask — crisps a soft/fixed-focus lens
            frame = cv2.addWeighted(frame, 1.0 + SHARPEN, cv2.GaussianBlur(frame, (0, 0), 1.4), -SHARPEN, 0)

        # ── Motion: downscaled grayscale frame-diff ──
        small = cv2.resize(frame, (W // 4, H // 4))
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        motion = False
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray)
            mean = float(diff.mean())
            area = float((diff > 25).mean())
            if mean > MOTION_THRESH and area > MOTION_AREA:
                motion = True
        prev_gray = gray

        # ── Object detection: feed the newest frame at the inference cadence.
        # A persisted alert-class (e.g. a person) counts as motion → record + event. ──
        fc += 1
        det_alert = False
        if DETECT and detector.net is not None:
            if fc % DETECT_EVERY == 0:
                detector.submit(frame.copy())
            det_alert = detector.hit_alert
            if det_alert:
                motion = True
        set_motion_display(motion)   # black screen → red flash on motion (HDMI, if attached)

        # ── REC + MOTION indicators only (no timestamp/date watermark on the video) ──
        cv2.circle(frame, (W - 18, 16), 5, (0, 0, 200), -1)
        if motion:
            cv2.rectangle(frame, (1, 1), (W - 2, H - 2), (0, 0, 220), 3)
            cv2.putText(frame, "MOTION", (W - 96, 20), cv2.FONT_HERSHEY_PLAIN, 1.2, (0, 0, 220), 2, cv2.LINE_AA)
        if DETECT and detector.net is not None:
            detector.draw(frame)     # labelled bounding boxes over the live + recorded frame

        ok2, jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_Q])
        if ok2:
            data = jpg.tobytes()
            LATEST.set(data)  # LAN MJPEG — every frame

            if motion:
                hot_until = now + 5.0
                if now - last_motion_event > MOTION_COOLDOWN:
                    last_motion_event = now
                    reason = "person detected" if det_alert else "motion detected"
                    threading.Thread(target=cloud.motion_event, args=(reason,), daemon=True).start()
                    print(f"[vigil] {reason.upper()}", flush=True)

            rate = CLOUD_FPS_HOT if now < hot_until else CLOUD_FPS
            if now - last_cloud >= 1.0 / max(0.2, rate):
                last_cloud = now
                try: upq.put_nowait(data)
                except queue.Full: pass

            # ── Recording: manual (dashboard) or motion (armed / RECORD_ON_MOTION, within window) ──
            auto_rec = motion and ((RECORD_ON_MOTION and _in_window(now)) or armed.is_set()
                                    or (sched["on"] and _in_sched(now, sched["start"], sched["end"])))
            if writer is None and (record_req.is_set() or auto_rec):
                rec_kind = "manual" if record_req.is_set() else "motion"; record_req.clear()
                try:
                    os.makedirs(RECORD_DIR, exist_ok=True)
                    rec_started = datetime.datetime.now(datetime.timezone.utc).isoformat()
                    rec_path = os.path.join(RECORD_DIR, rec_started.replace(":", "").replace("-", "")[:15] + ".mp4")
                    writer = cv2.VideoWriter(rec_path, cv2.VideoWriter_fourcc(*"mp4v"), max(8, CAM_FPS), (W, H))
                    rec_t0 = now; rec_end = now + RECORD_SECS
                    print(f"[vigil] REC start ({rec_kind}) → {rec_path}", flush=True)
                except Exception as e:  # noqa: BLE001
                    writer = None; print(f"[vigil] REC start failed: {e}", flush=True)
            if writer is not None:
                writer.write(frame)
                if now >= rec_end:
                    try: writer.release()
                    except Exception: pass
                    dur = now - rec_t0; p, st, k = rec_path, rec_started, rec_kind
                    writer = None
                    threading.Thread(target=upload_rec, args=(p, st, dur, k), daemon=True).start()
                    print(f"[vigil] REC done ({k}, {dur:.1f}s)", flush=True)

        # Pace the capture loop to the target fps.
        dt = time.time() - now
        time.sleep(max(0.0, 1.0 / max(1, CAM_FPS) - dt))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
