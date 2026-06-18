#!/usr/bin/env python3
"""Mirror Loop — best-effort low-fps frame stream to Supabase Storage.

The on-screen renderer (mirror_loop.py) hands us each finished RGB frame via
offer(); a background thread throttles to STREAM_FPS, JPEG-encodes the latest
one and uploads it to the public `mirror-frames` bucket as
`<UNIT_SLUG>/latest.jpg` (upsert). sinsera.co/mirrorloop then shows that image,
refreshing it ~1–2x/sec — a "good enough for now" live view when the HDMI-out to
the TV isn't usable.

Design rules (same as telemetry.py):
  * Best-effort — never block or crash the render loop. offer() just stores the
    latest frame; all encoding + network happens on our own daemon thread.
  * No service-role key on the device. Uploads with the anon key into a bucket
    whose RLS allows anon insert/update (see migration 0049_mirror_frames.sql).
  * Off unless STREAM_TO_CLOUD=1 in the env.
"""
from __future__ import annotations

import logging
import os
import threading
import time

log = logging.getLogger("mirror-loop.stream")

try:
    import cv2
    import requests
except Exception:  # pragma: no cover
    cv2 = None
    requests = None


class FrameStreamer:
    def __init__(self) -> None:
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.anon = os.environ.get("SUPABASE_ANON_KEY", "")
        self.slug = os.environ.get("UNIT_SLUG", "test-zero2w")
        self.fps = float(os.environ.get("STREAM_FPS", "1.5"))
        self.quality = int(os.environ.get("STREAM_JPEG_QUALITY", "70"))
        self.enabled = (
            os.environ.get("STREAM_TO_CLOUD", "0") == "1"
            and bool(self.url and self.anon)
            and cv2 is not None and requests is not None
        )
        self._latest = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._t = None
        if self.enabled:
            self._t = threading.Thread(target=self._run, daemon=True)
            self._t.start()
            log.info("frame streamer ON → %s mirror-frames/%s/latest.jpg @ %.1f fps", self.url, self.slug, self.fps)
            print(f"[stream] ON → mirror-frames/{self.slug}/latest.jpg @ {self.fps:.1f} fps", flush=True)

    def offer(self, rgb_frame) -> None:
        """Called from the render loop every frame — cheap (just stores latest)."""
        if not self.enabled:
            return
        with self._lock:
            self._latest = rgb_frame

    def _run(self) -> None:
        endpoint = f"{self.url}/storage/v1/object/mirror-frames/{self.slug}/latest.jpg"
        headers = {
            "apikey": self.anon,
            "Authorization": f"Bearer {self.anon}",
            "Content-Type": "image/jpeg",
            "x-upsert": "true",
            "Cache-Control": "no-cache, max-age=0",
        }
        interval = 1.0 / max(0.2, self.fps)
        warned = False
        while not self._stop.is_set():
            t0 = time.time()
            with self._lock:
                frame = self._latest
            if frame is not None:
                try:
                    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
                    if ok:
                        r = requests.post(endpoint, headers=headers, data=buf.tobytes(), timeout=8)
                        if r.status_code >= 400 and not warned:
                            warned = True
                            print(f"[stream] upload HTTP {r.status_code}: {r.text[:140]} "
                                  f"(has the mirror-frames bucket + policies been created?)", flush=True)
                        elif r.status_code < 300:
                            warned = False
                except Exception as e:  # noqa: BLE001
                    log.debug("frame push failed: %s", e)
            self._stop.wait(max(0.0, interval - (time.time() - t0)))

    def stop(self) -> None:
        self._stop.set()
