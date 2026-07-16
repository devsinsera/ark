#!/usr/bin/env python3
"""
GR86 local-first HUD server — Node 5.

SCAFFOLD (see the README "known gaps"): serves a lightweight local page so the
iPad/phone on the Pi's own AP (Sinsera-GR86) can see *something* with zero uplink.
The REAL gauge HUD is the Garage kiosk editor's output at
    sinsera.co/garage/<carUuid>/obd?hud=1
so when the Pi has an uplink this stub simply points the browser there. Offline,
it shows a placeholder "GR86 HUD" page with a clear TODO.

TODO (needs the physical Pi + iteration):
  * Bundle the real gauge HUD assets locally (built from the Garage kiosk editor)
    and serve them from /opt/gr86-hud/static so the gauges render fully offline.
  * Read live values straight from the OBD bridge (shared file / local socket /
    the store-and-forward buffer) instead of the cloud round trip.

No external deps — stdlib http.server only, so it runs before pip is warm.
"""
import http.server
import socketserver
import os
import socket

PORT = int(os.environ.get("HUD_PORT", "8080"))
# Filled by install.sh from the baked CAR_ID; the ?hud=1 cloud dashboard URL.
CAR_UUID = os.environ.get("GR86_CAR_UUID", "").strip()
CLOUD_HUD = (
    f"https://sinsera.co/garage/{CAR_UUID}/obd?hud=1"
    if CAR_UUID else "https://sinsera.co/garage"
)


def have_uplink(timeout=1.5):
    """Cheap reachability probe: can we open TCP 443 to the internet?"""
    try:
        socket.setdefaulttimeout(timeout)
        socket.create_connection(("1.1.1.1", 443)).close()
        return True
    except OSError:
        return False


PLACEHOLDER = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GR86 HUD</title>
<style>
  html,body{{margin:0;height:100%;background:#0a0a0c;color:#e8e8ea;
    font-family:system-ui,-apple-system,sans-serif;display:flex;
    align-items:center;justify-content:center;text-align:center}}
  .b{{max-width:560px;padding:2rem}}
  h1{{font-size:2.2rem;letter-spacing:.08em;margin:.2em 0;color:#c1121f}}
  p{{opacity:.7;line-height:1.5}}
  code{{color:#8ecae6}}
</style></head>
<body><div class="b">
  <h1>GR86 &middot; NODE 5</h1>
  <p>Local HUD server is up on the Pi AP.<br>
     No uplink right now &mdash; OBD is buffering locally and will flush to
     Node&nbsp;3 + Supabase when the car reaches home WiFi.</p>
  <p>When online this page redirects to the live gauge HUD:<br>
     <code>{cloud}</code></p>
</div></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/index.html", "/hud"):
            if CAR_UUID and have_uplink():
                self.send_response(302)
                self.send_header("Location", CLOUD_HUD)
                self.end_headers()
                return
            body = PLACEHOLDER.format(cloud=CLOUD_HUD).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):  # quiet; journald captures stderr anyway
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"[gr86-hud] serving on :{PORT} (cloud HUD -> {CLOUD_HUD})")
        httpd.serve_forever()
