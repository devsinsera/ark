#!/usr/bin/env python3
"""Mirror Loop — Supabase telemetry for the on-screen renderer.

Lifted from Modules/MirrorLoopPi/mirror_loop.py (the headless capture daemon)
and wrapped as a Telemetry class the Pygame renderer (mirror_loop.py) drives
via sm._telemetry. Posts unit heartbeats + sessions + per-phase events to the
shared Supabase tables (mirror_loop_units / _sessions / _events) so this unit
shows up live on sinsera.co/mirrorloop.

Design rules:
  * Best-effort — every network call is wrapped; failures log + continue.
    Telemetry must NEVER block or crash the render loop.
  * No service-role key on the device. Signs in as the owner with
    email/password to get a user JWT; refreshes ~5 min before expiry.
  * Reads config from the process env (the launcher sources /opt/mirror-loop/.env)
    or a local .env via python-dotenv.

If MIRROR_PASSWORD is blank (the image ships with a placeholder), Telemetry()
raises in __init__ — run() catches it and the unit runs display-only until the
password is filled in over SSH.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import random
import string
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

import requests

try:
    from dotenv import load_dotenv
    # Load /opt/mirror-loop/.env when present, else CWD .env.
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path if os.path.exists(_env_path) else None)
except Exception:
    pass

log = logging.getLogger("mirror-loop.telemetry")

SUPABASE_URL  = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON_KEY", "")
MIRROR_EMAIL  = os.environ.get("MIRROR_EMAIL", "")
MIRROR_PASS   = os.environ.get("MIRROR_PASSWORD", "")
UNIT_SLUG     = os.environ.get("UNIT_SLUG", "test-zero2w")
UNIT_LABEL    = os.environ.get("UNIT_LABEL", UNIT_SLUG.upper())
HEARTBEAT_S   = int(os.environ.get("HEARTBEAT_S", "30"))


# ───────────────────────── auth (sign-in + refresh) ─────────────────────────
class _Auth:
    def __init__(self) -> None:
        self.jwt: Optional[str] = None
        self.expires_at: float = 0.0
        self.refresh_token: Optional[str] = None
        self._lock = threading.Lock()
        self.sign_in()

    def sign_in(self) -> None:
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
            json={"email": MIRROR_EMAIL, "password": MIRROR_PASS},
            timeout=10,
        )
        r.raise_for_status()
        body = r.json()
        with self._lock:
            self.jwt = body["access_token"]
            self.refresh_token = body.get("refresh_token")
            self.expires_at = time.time() + max(60, body.get("expires_in", 3600) - 300)
        log.info("signed in as %s", MIRROR_EMAIL)

    def refresh(self) -> None:
        if not self.refresh_token:
            return self.sign_in()
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
            json={"refresh_token": self.refresh_token},
            timeout=10,
        )
        if r.status_code >= 400:
            log.warning("refresh failed (%s); re-signing in", r.status_code)
            return self.sign_in()
        body = r.json()
        with self._lock:
            self.jwt = body["access_token"]
            self.refresh_token = body.get("refresh_token", self.refresh_token)
            self.expires_at = time.time() + max(60, body.get("expires_in", 3600) - 300)

    def headers(self) -> Dict[str, str]:
        if time.time() >= self.expires_at:
            self.refresh()
        return {
            "apikey": SUPABASE_ANON,
            "Authorization": f"Bearer {self.jwt}",
            "Content-Type": "application/json",
        }


def _rest(auth: _Auth, method: str, path: str, *, json_body: Any = None,
          prefer: Optional[str] = None) -> requests.Response:
    h = auth.headers()
    if prefer:
        h["Prefer"] = prefer
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    return requests.request(method, url, headers=h, json=json_body, timeout=15)


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


# ───────────────────────── Telemetry wrapper ─────────────────────────
class Telemetry:
    """Drives Supabase telemetry from renderer phase transitions.

    Lifecycle:
        t = Telemetry()                  # signs in + ensures the unit row
        t.start(lambda: sm.phase.name)   # begins the heartbeat thread
        t.on_phase("DETECTION")          # called from sm._enter_phase
        ...
        t.stop()                         # marks the unit offline
    """

    def __init__(self) -> None:
        missing = [k for k, v in {
            "SUPABASE_URL": SUPABASE_URL, "SUPABASE_ANON_KEY": SUPABASE_ANON,
            "MIRROR_EMAIL": MIRROR_EMAIL, "MIRROR_PASSWORD": MIRROR_PASS,
        }.items() if not v]
        if missing:
            raise RuntimeError(f"missing env: {', '.join(missing)}")

        self._auth = _Auth()
        self._unit_id = self._ensure_unit()
        self._lock = threading.Lock()
        self._session_id: Optional[str] = None
        self._session_started: float = 0.0
        self._session_count = 0
        self._get_phase: Callable[[], str] = lambda: "IDLE"
        self._stop_evt = threading.Event()
        self._hb_thread: Optional[threading.Thread] = None

    # ── unit registration ──
    def _ensure_unit(self) -> str:
        r = _rest(self._auth, "GET", f"mirror_loop_units?slug=eq.{UNIT_SLUG}&select=id")
        r.raise_for_status()
        rows = r.json()
        if rows:
            log.info("unit %s exists (id=%s)", UNIT_SLUG, rows[0]["id"][:8])
            return rows[0]["id"]
        log.info("registering new unit %s", UNIT_SLUG)
        r = _rest(self._auth, "POST", "mirror_loop_units",
                  json_body={"slug": UNIT_SLUG, "label": UNIT_LABEL, "status": "online"},
                  prefer="return=representation")
        r.raise_for_status()
        return r.json()[0]["id"]

    # ── heartbeat thread ──
    def start(self, get_phase: Callable[[], str]) -> None:
        self._get_phase = get_phase
        self._hb_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._hb_thread.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop_evt.wait(HEARTBEAT_S):
            try:
                phase = self._get_phase()
            except Exception:
                phase = "IDLE"
            try:
                _rest(self._auth, "PATCH", f"mirror_loop_units?id=eq.{self._unit_id}",
                      json_body={"status": "online", "phase": phase,
                                 "last_seen_at": _now_iso(),
                                 "session_count": self._session_count})
            except Exception as e:
                log.warning("heartbeat failed: %s", e)

    # ── phase events / session lifecycle ──
    def on_phase(self, name: str) -> None:
        if name == "DETECTION":
            self._start_session()
            self._log_event(0.0, "trigger", "DETECTION")
            self._log_event(0.0, "phase_enter", "DETECTION")
        elif name == "RESET":
            self._log_event(self._t(), "phase_enter", "RESET")
            self._end_session("RESET")
        elif name == "IDLE":
            # Safety net: close any session left open.
            if self._session_id:
                self._end_session("IDLE")
        else:
            self._log_event(self._t(), "phase_enter", name)

    def _t(self) -> float:
        return time.time() - self._session_started if self._session_started else 0.0

    def _start_session(self) -> None:
        with self._lock:
            if self._session_id:  # already running
                return
            pub = "".join(random.choices("0123456789ABCDEF", k=4))
            payload = {
                "unit_id": self._unit_id, "public_id": pub,
                "external_uuid": str(uuid.uuid4()), "status": "STABLE",
                "phase": "DETECTION", "motion_source": "camera",
                "started_at": _now_iso(), "image_blurred": True,
            }
            try:
                r = _rest(self._auth, "POST", "mirror_loop_sessions",
                          json_body=payload, prefer="return=representation")
                if r.status_code >= 400:
                    log.error("start_session %s: %s", r.status_code, r.text[:200])
                    return
                row = r.json()[0]
                self._session_id = row["id"]
                self._session_started = time.time()
                log.info("session %s started", row.get("public_id", "?"))
            except Exception as e:
                log.warning("start_session failed: %s", e)

    def _log_event(self, t_offset: float, event_type: str, phase: str) -> None:
        sid = self._session_id
        if not sid:
            return
        try:
            _rest(self._auth, "POST", "mirror_loop_events",
                  json_body={"session_id": sid, "t_offset": round(t_offset, 2),
                             "event_type": event_type, "phase": phase, "note": None})
        except Exception as e:
            log.debug("log_event failed: %s", e)

    def _end_session(self, final_phase: str) -> None:
        with self._lock:
            sid = self._session_id
            if not sid:
                return
            duration = int(time.time() - self._session_started)
            self._session_id = None
            self._session_started = 0.0
            self._session_count += 1
        try:
            _rest(self._auth, "PATCH", f"mirror_loop_sessions?id=eq.{sid}",
                  json_body={"ended_at": _now_iso(), "duration_s": duration,
                             "phase": final_phase})
            log.info("session ended duration=%ds", duration)
        except Exception as e:
            log.warning("end_session failed: %s", e)

    # ── shutdown ──
    def stop(self) -> None:
        self._stop_evt.set()
        if self._session_id:
            self._end_session("RESET")
        try:
            _rest(self._auth, "PATCH", f"mirror_loop_units?id=eq.{self._unit_id}",
                  json_body={"status": "offline", "last_seen_at": _now_iso()})
        except Exception:
            pass
