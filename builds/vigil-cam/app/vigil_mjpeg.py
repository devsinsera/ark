#!/usr/bin/env python3
"""Vigil — LAN MJPEG server (full-rate local viewing).

A tiny threaded HTTP server that streams the latest JPEG frame as
multipart/x-mixed-replace to any client on the LAN — smooth full-rate video at
home (the Supabase snapshot path is the lower-rate REMOTE view). LAN-only: bind
to the local network; keep it behind your router/WireGuard. Optional MJPEG_TOKEN
gates the path (/stream/<token>) if you want a shared secret.

Endpoints:
  /            → minimal HTML player
  /stream      → multipart MJPEG (or /stream/<token> if MJPEG_TOKEN set)
  /snapshot    → single latest JPEG
"""
from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_TOKEN = os.environ.get("MJPEG_TOKEN", "").strip()


class _Latest:
    def __init__(self) -> None:
        self._buf: bytes = b""
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._seq = 0

    def set(self, jpeg: bytes) -> None:
        with self._cv:
            self._buf = jpeg; self._seq += 1; self._cv.notify_all()

    def wait_next(self, last_seq: int, timeout: float = 5.0):
        with self._cv:
            if self._seq == last_seq:
                self._cv.wait(timeout)
            return self._buf, self._seq


LATEST = _Latest()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet
        pass

    def _ok_token(self, path: str) -> bool:
        if not _TOKEN:
            return True
        return path.rstrip("/").endswith("/" + _TOKEN)

    def do_GET(self):  # noqa: N802
        p = self.path.split("?")[0]
        if p == "/" or p == "/index.html":
            # snapshot-refresh (works everywhere incl. WPE WebKit/cog, which won't render MJPEG-in-img). /stream stays for chromium.
            # Camera monitor + a discreet ☰ menu (deliberate 2-tap, so it can't be hit by accident like the old big button).
            html = (b"<html><body style='margin:0;background:#000;overflow:hidden;font-family:sans-serif'>"
                    b"<img id=v style='width:100%;height:100vh;object-fit:contain'>"
                    b"<div onclick=\"document.getElementById('m').style.display='flex'\" "
                    b"style='position:fixed;top:12px;right:12px;width:50px;height:50px;border-radius:50%;"
                    b"background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.35);color:#fff;"
                    b"font-size:27px;text-align:center;line-height:50px;z-index:8'>&#9776;</div>"
                    b"<div id=m style='display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9;"
                    b"flex-direction:column;align-items:center;justify-content:center;gap:20px'>"
                    b"<a href='https://sinsera.co/?kiosk=1' style='color:#fff;background:#c0392b;padding:16px 36px;"
                    b"border-radius:8px;text-decoration:none;font-size:20px'>Dashboard</a>"
                    b"<a href='/' style='color:#fff;background:#333;padding:16px 36px;border-radius:8px;"
                    b"text-decoration:none;font-size:20px'>Reload camera</a>"
                    b"<div onclick=\"document.getElementById('m').style.display='none'\" "
                    b"style='color:#999;padding:12px;font-size:18px'>&#10005; Close</div></div>"
                    b"<script>var v=document.getElementById('v');function u(){v.src='/snapshot?'+Date.now();}"
                    b"v.onload=function(){setTimeout(u,80)};v.onerror=function(){setTimeout(u,500)};u();</script>"
                    b"</body></html>")
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Content-Length", str(len(html))); self.end_headers(); self.wfile.write(html); return
        if p == "/snapshot":
            buf, _ = LATEST.wait_next(-1, 1.0)
            self.send_response(200); self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(buf))); self.end_headers(); self.wfile.write(buf); return
        if p.startswith("/stream") and self._ok_token(p):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-cache, private"); self.end_headers()
            seq = -1
            try:
                while True:
                    buf, seq = LATEST.wait_next(seq, 5.0)
                    if not buf:
                        continue
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(buf)).encode() + b"\r\n\r\n" + buf + b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                return
            return
        self.send_response(404); self.end_headers()


def serve(port: int) -> None:
    srv = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[mjpeg] LAN stream on :{port}/stream", flush=True)
