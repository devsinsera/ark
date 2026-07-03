#!/usr/bin/env python3
"""Vigil — Supabase auth + private-storage upload + REST helpers.

Security camera plumbing: signs in as the OWNER (email/password) to get a user
JWT, then uploads frames to the PRIVATE `vigil-frames` bucket under
<uid>/<slug>/latest.jpg (owner-RLS — nobody else can read it) and posts motion
events + heartbeats to vigil_events / vigil_cameras.

Mirrors mirrorloop telemetry.py's auth, but the bucket is private (signed-URL
only) and the upload path is namespaced by the owner uid so RLS scopes it.

If VIGIL_PASSWORD is blank the cloud side stays off (the LAN MJPEG still works);
the camera is useless-to-strangers by default.
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
import threading
import time
from typing import Any, Optional

def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _telemetry() -> dict:
    """Best-effort battery / charging / connection for the heartbeat."""
    out: dict = {}
    # connection type from the default-route interface
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                p = line.split()
                if len(p) > 1 and p[1] == "00000000":  # default route
                    ifc = p[0]
                    out["connection"] = ("wifi" if ifc.startswith("wl") else
                                         "cell" if ifc.startswith(("ww", "ppp", "wwan")) else "lan")
                    break
    except Exception:
        pass
    # battery (UPS HAT etc.) — null if none
    try:
        import glob
        for ps in glob.glob("/sys/class/power_supply/*"):
            try:
                with open(ps + "/capacity") as f:
                    out["battery"] = int(f.read().strip())
                with open(ps + "/status") as f:
                    out["charging"] = f.read().strip().lower() in ("charging", "full")
                break
            except Exception:
                continue
    except Exception:
        pass
    return out


def _netloc() -> dict:
    """Current LAN ip + this instance's MJPEG port, so the DB HD link stays
    correct across DHCP lease changes."""
    out: dict = {}
    try:
        out["mjpeg_port"] = int(os.environ.get("MJPEG_PORT", "8090"))
    except Exception:
        pass
    try:
        import socket
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.connect(("8.8.8.8", 80))   # no packets sent; picks the default-route src IP
        out["ip_address"] = sk.getsockname()[0]
        sk.close()
    except Exception:
        pass
    return out

import requests

try:
    from dotenv import load_dotenv
    _p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_p if os.path.exists(_p) else None)
except Exception:
    pass

log = logging.getLogger("vigil.auth")

SUPABASE_URL  = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON_KEY", "")
VIGIL_EMAIL   = os.environ.get("VIGIL_EMAIL", "")
VIGIL_PASS    = os.environ.get("VIGIL_PASSWORD", "")
CAMERA_SLUG   = os.environ.get("CAMERA_SLUG", "front-door")
CAMERA_LABEL  = os.environ.get("CAMERA_LABEL", CAMERA_SLUG.replace("-", " ").upper())


class VigilCloud:
    """Owner-authenticated Supabase client for one camera. Best-effort; never raises to the caller."""

    def __init__(self) -> None:
        self.enabled = bool(SUPABASE_URL and SUPABASE_ANON and VIGIL_EMAIL and VIGIL_PASS)
        self.uid: Optional[str] = None
        self.jwt: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.expires_at = 0.0
        self.camera_id: Optional[str] = None
        self._lock = threading.Lock()
        if self.enabled:
            try:
                self._sign_in()
                self._ensure_camera()
                log.info("vigil cloud up — owner %s, camera %s", VIGIL_EMAIL, CAMERA_SLUG)
                print(f"[cloud] signed in as {VIGIL_EMAIL}; camera={CAMERA_SLUG}", flush=True)
            except Exception as e:  # noqa: BLE001
                self.enabled = False
                print(f"[cloud] disabled: {e}", flush=True)
        else:
            print("[cloud] disabled (VIGIL_PASSWORD blank or env missing) — LAN MJPEG only", flush=True)

    # ── auth ──────────────────────────────────────────────────────────────
    def _sign_in(self) -> None:
        r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                          headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
                          json={"email": VIGIL_EMAIL, "password": VIGIL_PASS}, timeout=10)
        r.raise_for_status()
        b = r.json()
        with self._lock:
            self.jwt = b["access_token"]; self.refresh_token = b.get("refresh_token")
            self.uid = (b.get("user") or {}).get("id")
            self.expires_at = time.time() + max(60, b.get("expires_in", 3600) - 300)

    def _fresh(self) -> None:
        if time.time() < self.expires_at and self.jwt:
            return
        try:
            if self.refresh_token:
                r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
                                  headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
                                  json={"refresh_token": self.refresh_token}, timeout=10)
                if r.status_code < 400:
                    b = r.json()
                    with self._lock:
                        self.jwt = b["access_token"]; self.refresh_token = b.get("refresh_token", self.refresh_token)
                        self.expires_at = time.time() + max(60, b.get("expires_in", 3600) - 300)
                    return
            self._sign_in()
        except Exception as e:  # noqa: BLE001
            log.warning("token refresh failed: %s", e)

    def _h(self, extra: Optional[dict] = None) -> dict:
        h = {"apikey": SUPABASE_ANON, "Authorization": f"Bearer {self.jwt}"}
        if extra:
            h.update(extra)
        return h

    def _rest(self, method: str, path: str, *, json_body: Any = None, params: Optional[dict] = None):
        self._fresh()
        return requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}",
                                headers=self._h({"Content-Type": "application/json"}),
                                json=json_body, params=params, timeout=10)

    # ── camera row (find or create) ───────────────────────────────────────
    def _ensure_camera(self) -> None:
        r = self._rest("GET", "vigil_cameras", params={"slug": f"eq.{CAMERA_SLUG}", "select": "id"})
        if r.status_code < 300 and r.json():
            self.camera_id = r.json()[0]["id"]; return
        ins = self._rest("POST", "vigil_cameras",
                         json_body={"owner_id": self.uid, "slug": CAMERA_SLUG, "label": CAMERA_LABEL, "status": "online"})
        if ins.status_code < 300 and ins.json():
            self.camera_id = ins.json()[0]["id"] if isinstance(ins.json(), list) else None
        # If RLS/return shape differs, re-fetch.
        if not self.camera_id:
            r2 = self._rest("GET", "vigil_cameras", params={"slug": f"eq.{CAMERA_SLUG}", "select": "id"})
            if r2.status_code < 300 and r2.json():
                self.camera_id = r2.json()[0]["id"]

    # ── frame upload (private bucket, owner path) ─────────────────────────
    def upload_frame(self, jpeg_bytes: bytes) -> bool:
        if not self.enabled or not self.uid:
            return False
        self._fresh()
        path = f"{self.uid}/{CAMERA_SLUG}/latest.jpg"
        try:
            r = requests.post(f"{SUPABASE_URL}/storage/v1/object/vigil-frames/{path}",
                              headers=self._h({"Content-Type": "image/jpeg", "x-upsert": "true",
                                               "Cache-Control": "no-cache, max-age=0"}),
                              data=jpeg_bytes, timeout=8)
            return r.status_code < 300
        except Exception as e:  # noqa: BLE001
            log.debug("frame upload failed: %s", e); return False

    # ── events + heartbeat ────────────────────────────────────────────────
    def motion_event(self, note: str = "motion detected") -> None:
        if not self.enabled or not self.camera_id:
            return
        try:
            self._rest("POST", "vigil_events", json_body={"camera_id": self.camera_id, "owner_id": self.uid, "kind": "motion", "note": note})
        except Exception:
            pass

    def heartbeat(self) -> None:
        if not self.enabled or not self.camera_id:
            return
        try:
            self._rest("PATCH", f"vigil_cameras?id=eq.{self.camera_id}",
                       json_body={"status": "online", "last_seen_at": _now_iso(), **_telemetry(), **_netloc()})
        except Exception:
            pass

    # Module → Pi: did the dashboard request a clip? (cleared after recording.)
    def poll_record_request(self) -> bool:
        if not self.enabled or not self.camera_id:
            return False
        try:
            r = self._rest("GET", "vigil_cameras", params={"id": f"eq.{self.camera_id}", "select": "record_requested"})
            return bool(r.status_code < 300 and r.json() and r.json()[0].get("record_requested"))
        except Exception:
            return False

    # Dashboard → Pi: app-editable record-on-motion schedule (record_on_motion + rec_start/rec_end window).
    def poll_record_schedule(self):
        if not self.enabled or not self.camera_id:
            return None
        try:
            r = self._rest("GET", "vigil_cameras", params={"id": f"eq.{self.camera_id}", "select": "record_on_motion,rec_start,rec_end"})
            if r.status_code < 300 and r.json():
                row = r.json()[0]
                return {"on": bool(row.get("record_on_motion")), "start": row.get("rec_start"), "end": row.get("rec_end")}
        except Exception:
            pass
        return None

    # Dashboard → Pi: is this camera ARMED? (auto-record motion clips when true.)
    def poll_armed(self) -> bool:
        if not self.enabled or not self.camera_id:
            return False
        try:
            r = self._rest("GET", "vigil_cameras", params={"id": f"eq.{self.camera_id}", "select": "motion_armed"})
            return bool(r.status_code < 300 and r.json() and r.json()[0].get("motion_armed"))
        except Exception:
            return False

    def upload_recording(self, mp4_bytes: bytes, started_at: str, duration_s: float, kind: str = "motion") -> None:
        if not self.enabled or not self.uid:
            return
        self._fresh()
        name = started_at.replace(":", "").replace("-", "").replace(".", "")[:15]
        path = f"{self.uid}/{CAMERA_SLUG}/{name}.mp4"
        try:
            r = requests.post(f"{SUPABASE_URL}/storage/v1/object/vigil-recordings/{path}",
                              headers=self._h({"Content-Type": "video/mp4", "x-upsert": "true"}),
                              data=mp4_bytes, timeout=30)
            if r.status_code < 300:
                self._rest("POST", "vigil_recordings", json_body={"owner_id": self.uid, "camera_id": self.camera_id,
                           "path": path, "kind": kind, "started_at": started_at, "duration_s": round(duration_s, 1), "size_bytes": len(mp4_bytes)})
                # clear the request flag after a manual capture
                if kind == "manual":
                    self._rest("PATCH", f"vigil_cameras?id=eq.{self.camera_id}", json_body={"record_requested": False})
        except Exception as e:  # noqa: BLE001
            log.debug("recording upload failed: %s", e)
