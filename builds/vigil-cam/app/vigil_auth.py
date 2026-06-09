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
                       json_body={"status": "online", "last_seen_at": _now_iso()})
        except Exception:
            pass
