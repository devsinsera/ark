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

import cv2
import numpy as np

from vigil_mjpeg import LATEST, serve as serve_mjpeg
from vigil_auth import VigilCloud

# ── Tunables (env, with sane Zero-2-W defaults) ──
W            = int(os.environ.get("CAM_WIDTH", "640"))
H            = int(os.environ.get("CAM_HEIGHT", "480"))
CAM_FPS      = int(os.environ.get("CAM_FPS", "15"))          # capture/LAN rate
CAM_INDEX    = int(os.environ.get("CAM_INDEX", "0"))
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

# ── Motion display: black framebuffer that flashes RED on motion ──
# No-ops until an HDMI screen is plugged in (then /dev/fb0 appears). Best-effort.
_ind = {"on": None}
def set_motion_display(on: bool) -> None:
    if _ind["on"] == on:
        return
    _ind["on"] = on
    try:
        import struct
        bpp = int(open("/sys/class/graphics/fb0/bits_per_pixel").read())
        w, h = (int(x) for x in open("/sys/class/graphics/fb0/virtual_size").read().split(","))
        r, g, b = (220, 0, 0) if on else (0, 0, 0)
        px = struct.pack("<H", ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) if bpp == 16 \
             else struct.pack("<I", (r << 16) | (g << 8) | b)
        with open("/dev/fb0", "wb") as f:
            f.write(px * (w * h))
    except Exception:
        pass  # no screen attached / no fb0 yet


def open_camera():
    cap = cv2.VideoCapture(CAM_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, H)
    cap.set(cv2.CAP_PROP_FPS, CAM_FPS)
    try: cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception: pass
    return cap if cap.isOpened() else None


def main() -> None:
    print(f"[vigil] starting — {W}x{H}@{CAM_FPS} cloud~{CLOUD_FPS}fps motion@{MOTION_THRESH}", flush=True)
    serve_mjpeg(MJPEG_PORT)
    cloud = VigilCloud()

    # Background uploader: a 1-slot queue so we only ever push the freshest frame.
    upq: "queue.Queue[bytes]" = queue.Queue(maxsize=1)
    def uploader():
        while True:
            jpg = upq.get()
            cloud.upload_frame(jpg)
    threading.Thread(target=uploader, daemon=True).start()

    # Background heartbeat.
    def beat():
        while True:
            cloud.heartbeat(); time.sleep(HEARTBEAT_S)
    threading.Thread(target=beat, daemon=True).start()

    # Background: poll the dashboard's "record" request (when cloud is on).
    record_req = threading.Event()
    def poll_req():
        while True:
            if cloud.poll_record_request():
                record_req.set()
            time.sleep(3)
    threading.Thread(target=poll_req, daemon=True).start()

    # Background recording uploader (off the capture thread).
    def upload_rec(path, started, dur, kind):
        try:
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

    while True:
        now = time.time()
        if cap is None:
            if now - last_cam_try > 3.0:
                cap = open_camera(); last_cam_try = now
                if cap is None:
                    print("[vigil] waiting for camera…", flush=True)
            time.sleep(0.5); continue

        ok, frame = cap.read()
        if not ok:
            print("[vigil] camera dropped — reopening", flush=True)
            try: cap.release()
            except Exception: pass
            cap = None; prev_gray = None; continue

        if frame.shape[1] != W or frame.shape[0] != H:
            frame = cv2.resize(frame, (W, H))

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
        set_motion_display(motion)   # black screen → red flash on motion (HDMI, if attached)

        # ── Stamp (timestamp + REC + MOTION) — security overlay, no effects ──
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, ts, (8, H - 10), cv2.FONT_HERSHEY_PLAIN, 1.1, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(frame, ts, (8, H - 10), cv2.FONT_HERSHEY_PLAIN, 1.1, (210, 210, 210), 1, cv2.LINE_AA)
        cv2.circle(frame, (W - 18, 16), 5, (0, 0, 200), -1)
        if motion:
            cv2.rectangle(frame, (1, 1), (W - 2, H - 2), (0, 0, 220), 3)
            cv2.putText(frame, "MOTION", (W - 96, 20), cv2.FONT_HERSHEY_PLAIN, 1.2, (0, 0, 220), 2, cv2.LINE_AA)

        ok2, jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_Q])
        if ok2:
            data = jpg.tobytes()
            LATEST.set(data)  # LAN MJPEG — every frame

            if motion:
                hot_until = now + 5.0
                if now - last_motion_event > MOTION_COOLDOWN:
                    last_motion_event = now
                    threading.Thread(target=cloud.motion_event, args=("motion detected",), daemon=True).start()
                    print(f"[vigil] MOTION @ {ts}", flush=True)

            rate = CLOUD_FPS_HOT if now < hot_until else CLOUD_FPS
            if now - last_cloud >= 1.0 / max(0.2, rate):
                last_cloud = now
                try: upq.put_nowait(data)
                except queue.Full: pass

            # ── Recording: manual (dashboard) or motion (if enabled) ──
            if writer is None and (record_req.is_set() or (RECORD_ON_MOTION and motion)):
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
