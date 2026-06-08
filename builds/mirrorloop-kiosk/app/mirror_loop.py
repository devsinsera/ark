#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║          MIRROR LOOP  —  Horror Installation  v6             ║
║          Raspberry Pi 5 | OpenCV · Pygame · ZINK Print + Shred          ║
╠══════════════════════════════════════════════════════════════╣
║  State machine experience:                                   ║
║    IDLE → DETECTION → MIRROR → DELAY →                      ║
║    GLITCH → BREAK → CAPTURE → RESET → IDLE                  ║
╠══════════════════════════════════════════════════════════════╣
║  Controls                                                    ║
║    SPACE / motion  — trigger from IDLE                       ║
║    ESC / Q         — hard quit at any phase                  ║
║    D               — dev: force-advance to next phase        ║
╚══════════════════════════════════════════════════════════════╝
"""
# mirrorloop-kiosk fix: defer annotation evaluation so type hints that name
# optional modules (e.g. `motion: MotionDetector`, only defined when
# motion_engine.py is present) don't NameError at import in the camera-only
# fallback build. Must be the first statement after the docstring.
from __future__ import annotations

# ── stdlib ──────────────────────────────────────────────────────
import sys
import time
import random
import datetime
from collections import deque
# dataclass/field moved to print_shred.py
from enum import Enum, auto
from typing import Optional

# ── third-party ─────────────────────────────────────────────────
import cv2
import numpy as np
# PIL imports moved to print_shred.py
import pygame

# print_shred.py lives alongside this file
try:
    from print_shred import PrintShredOrchestrator
    PRINT_SHRED_AVAILABLE = True
except ImportError:
    PRINT_SHRED_AVAILABLE = False
    print("[Warning] print_shred.py not found — CAPTURE phase will log only.")

# audio_engine.py lives alongside this file
try:
    from audio_engine import AudioEngine
    AUDIO_ENGINE_AVAILABLE = True
except ImportError:
    AUDIO_ENGINE_AVAILABLE = False
    print("[Warning] audio_engine.py not found — audio disabled.")

# motion_engine.py lives alongside this file
try:
    from motion_engine import MotionEngine, MotionSignal, detect_motion, trigger_experience
    MOTION_ENGINE_AVAILABLE = True
except ImportError:
    MOTION_ENGINE_AVAILABLE = False
    print("[Warning] motion_engine.py not found — using basic MotionDetector.")
    # Fallbacks for the camera-only build: detect_motion + trigger_experience
    # normally come from motion_engine. The built-in _FallbackMotionDetector.tick
    # returns a _FallbackResult with .is_trigger.
    def detect_motion(engine, frame, dt):
        return engine.tick(frame, dt)
    def trigger_experience(sm, result):
        if getattr(result, "is_trigger", False):
            sm.trigger()

# config_manager.py lives alongside this file
try:
    from config_manager import (
        load_config, save_session_log, sync_network,
        InstallationConfig, SessionLogger, NetworkSync,
        setup_logging, export_config,
    )
    CONFIG_MANAGER_AVAILABLE = True
except ImportError:
    CONFIG_MANAGER_AVAILABLE = False
    print("[Warning] config_manager.py not found — using hardcoded constants.")

# telemetry.py — posts heartbeats + sessions + phase events to the shared
# Supabase tables so this unit shows up live on sinsera.co/mirrorloop.
# Best-effort: any failure here NEVER blocks the render loop.
try:
    from telemetry import Telemetry
    TELEMETRY_AVAILABLE = True
except Exception as _tel_exc:  # ImportError or missing deps
    TELEMETRY_AVAILABLE = False
    print(f"[Warning] telemetry.py unavailable ({_tel_exc}) — running display-only.")


# ══════════════════════════════════════════════════════════════════
#  CONFIGURATION
#  All runtime config is loaded from config.yaml (or the path given
#  on the CLI with --config) via config_manager.py.
#  The CFG object is populated in run() and passed to subsystems.
#  Hardcoded constants below are FALLBACK DEFAULTS only — they are
#  overridden by any loaded config file.
# ══════════════════════════════════════════════════════════════════

# These constants are used only when config_manager.py is absent.
# When config_manager IS available they are replaced by cfg fields.
# NOTE (mirrorloop-kiosk / Pi Zero 2 W build): tuned DOWN from the Pi 5
# originals (was 640x480@30, 5.0s buffer) to fit a 512 MB Zero 2 W. pygame's
# SCALED flag upscales this small render surface to the TV's native resolution,
# so the 65" output still fills the screen. Tune over SSH if perf allows.
_DEFAULT_RESOLUTION      = (480, 360)
_DEFAULT_TARGET_FPS      = 18
_DEFAULT_CONTRAST_ALPHA  = 1.25
_DEFAULT_CONTRAST_BETA   = -15
_DEFAULT_VIGNETTE        = 0.65
_DEFAULT_BUFFER_S        = 3.0
_DEFAULT_THRESHOLD       = 25.0
_DEFAULT_CAPTURE_OFFSET  = 2.5

# ── Motion globals (mirrorloop-kiosk fix) ──────────────────────────
# run() references these module globals directly, but upstream only defined
# them via config_manager — so standalone (no config_manager, no motion_engine)
# the original NameError'd. Define them here as the camera-only fallback values
# used by _FallbackMotionDetector and the startup banner. PIR is OFF.
# open_camera() reads TARGET_FPS as a module global (run() also sets a local of
# the same name for itself). Only bites once a camera is actually present (the
# cap.set lines run), which is why it surfaced only after the C920 was plugged in.
TARGET_FPS           = _DEFAULT_TARGET_FPS
MOTION_THRESHOLD     = 6.0     # _FallbackMotionDetector: mean frame-diff trigger
MOTION_BLUR_K        = 21      # gaussian blur kernel (odd)
MOTION_HYSTERESIS    = 3
DETECTION_ZONE       = None
TRIGGER_COOLDOWN_S   = 8.0
IDLE_TIMEOUT_S       = 20.0
PIR_ENABLED          = False
PIR_GPIO_PIN         = 27
MOTION_DEBUG_OVERLAY = False

# Static phase tables — also overridden by cfg.phase_durations / cfg.phase_glitch
PHASE_DURATIONS = {
    "IDLE":None,"DETECTION":2.0,"MIRROR":8.0,"DELAY":7.0,
    "GLITCH":9.0,"BREAK":3.0,"CAPTURE":4.0,"RESET":2.5,
}
PHASE_GLITCH = {
    "IDLE":0.04,"DETECTION":0.10,"MIRROR":0.00,"DELAY":0.15,
    "GLITCH":0.75,"BREAK":0.00,"CAPTURE":0.05,"RESET":0.08,
}
PHASE_DELAY_S = {
    "IDLE":0.0,"DETECTION":0.0,"MIRROR":0.0,"DELAY":1.2,
    "GLITCH":0.8,"BREAK":0.0,"CAPTURE":2.0,"RESET":0.0,
}
PHASE_VIGNETTE = {
    "IDLE":1.4,"DETECTION":1.2,"MIRROR":0.8,"DELAY":1.0,
    "GLITCH":1.1,"BREAK":0.0,"CAPTURE":1.3,"RESET":1.5,
}
PHASE_CONTRAST = {
    "IDLE":(-0.10,-20),"DETECTION":(0.00,0),"MIRROR":(0.05,10),
    "DELAY":(0.00,-5),"GLITCH":(0.15,-10),"BREAK":(0.00,0),
    "CAPTURE":(0.20,-25),"RESET":(-0.15,-30),
}
IDLE_SHOW_TIMESTAMP = True
IDLE_SHOW_REC       = True
_P_FRAME_SKIP=0.08;_P_TEAR=0.12;_P_WARP=0.10;_P_FLICKER=0.06;_P_STUTTER=0.07
TEAR_MAX_BANDS=2;TEAR_MAX_HEIGHT=18;TEAR_MAX_SHIFT=28
WARP_AMPLITUDE=4.0;WARP_FREQUENCY=0.025;FLICKER_INVERT=0.25
STUTTER_MIN_MS=16;STUTTER_MAX_MS=55
CAPTURE_BUFFER_OFFSET_S = 2.5


# ══════════════════════════════════════════════════════════════════
#  PHASE ENUM
# ══════════════════════════════════════════════════════════════════

class Phase(Enum):
    IDLE      = auto()
    DETECTION = auto()
    MIRROR    = auto()
    DELAY     = auto()
    GLITCH    = auto()
    BREAK     = auto()
    CAPTURE   = auto()
    RESET     = auto()

# Ordered sequence for automatic progression
PHASE_SEQUENCE = [
    Phase.IDLE,
    Phase.DETECTION,
    Phase.MIRROR,
    Phase.DELAY,
    Phase.GLITCH,
    Phase.BREAK,
    Phase.CAPTURE,
    Phase.RESET,
]


# ══════════════════════════════════════════════════════════════════
#  RING BUFFER
# ══════════════════════════════════════════════════════════════════

class FrameBuffer:
    """Fixed-capacity ring buffer of (timestamp, rgb_frame) tuples."""

    def __init__(self, capacity: int) -> None:
        self._buf: deque = deque(maxlen=capacity)

    def push(self, frame: np.ndarray) -> None:
        self._buf.append((time.monotonic(), frame))

    def latest(self) -> Optional[np.ndarray]:
        return self._buf[-1][1] if self._buf else None

    def get_delayed(self, delay: float) -> Optional[np.ndarray]:
        if not self._buf:
            return None
        target = time.monotonic() - delay
        for ts, frame in reversed(self._buf):
            if ts <= target:
                return frame
        return self._buf[0][1]

    def __len__(self) -> int:
        return len(self._buf)

    @property
    def capacity(self) -> int:
        return self._buf.maxlen  # type: ignore[return-value]


# ══════════════════════════════════════════════════════════════════
#  MOTION DETECTOR — replaced by MotionEngine from motion_engine.py
#  This stub is used only when motion_engine.py is absent.
# ══════════════════════════════════════════════════════════════════

class _FallbackMotionDetector:
    """
    Minimal frame-diff detector used when motion_engine.py is missing.
    Lacks hysteresis, ROI, PIR, idle timeout, and MOG2.
    """

    def __init__(self, threshold: float, blur_k: int) -> None:
        self._threshold = threshold
        self._blur_k    = blur_k | 1
        self._prev_grey = None

    def tick(self, frame_rgb: np.ndarray, dt: float):
        """Returns a minimal duck-typed result compatible with MotionSignal."""
        grey = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
        grey = cv2.GaussianBlur(grey, (self._blur_k, self._blur_k), 0)
        if self._prev_grey is None:
            self._prev_grey = grey
            return _FallbackResult(False)
        diff = cv2.absdiff(grey, self._prev_grey)
        self._prev_grey = grey
        fired = float(diff.mean()) > self._threshold
        return _FallbackResult(fired)

    def notify_activity(self): pass
    def reset(self): self._prev_grey = None
    def start(self): pass
    def stop(self): pass
    def draw_debug(self, frame, result): return frame


class _FallbackResult:
    """Duck-type TickResult for the fallback detector."""
    def __init__(self, trigger: bool):
        self.is_trigger = trigger

    @property
    def signal(self):
        # Return a value that compares equal to MotionSignal.TRIGGER
        return _TriggerSentinel() if self.is_trigger else _NoneSentinel()


class _TriggerSentinel:
    def __eq__(self, other): return str(other).endswith("TRIGGER")
    def __str__(self): return "TRIGGER"

class _NoneSentinel:
    def __eq__(self, other): return not str(other).endswith("TRIGGER")
    def __str__(self): return "NONE"


# ══════════════════════════════════════════════════════════════════
#  GLITCH ENGINE
# ══════════════════════════════════════════════════════════════════

def _effect_frame_skip(frame, prev):
    return prev if prev is not None else frame

def _effect_tear(frame, n, max_h, max_s):
    out = frame.copy()
    h   = frame.shape[0]
    for _ in range(n):
        y  = random.randint(0, h - 1)
        bh = random.randint(2, max_h)
        s  = random.randint(-max_s, max_s)
        out[y:min(y + bh, h)] = np.roll(out[y:min(y + bh, h)], s, axis=1)
    return out

def _effect_warp(frame, map_x, map_y, amp, freq):
    h, w  = frame.shape[:2]
    phase = random.uniform(0.0, 2.0 * np.pi)
    rows  = np.arange(h, dtype=np.float32)
    shift = amp * np.sin(freq * rows + phase)
    map_x[:] = map_y + shift[:, np.newaxis]
    np.clip(map_x, 0, w - 1, out=map_x)
    return cv2.remap(frame, map_x, map_y,
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

def _effect_flicker(frame, invert_chance):
    if random.random() < invert_chance:
        return cv2.bitwise_not(frame)
    return cv2.convertScaleAbs(frame, alpha=random.uniform(1.3, 2.0))

def _effect_stutter(min_ms, max_ms):
    time.sleep(random.randint(min_ms, max_ms) / 1000.0)


class GlitchEngine:
    """
    Probability-gated visual distortion engine.
    intensity is set per-frame by the state machine.
    """

    def __init__(self, width: int, height: int) -> None:
        self.intensity   = 0.0
        self._prev_frame = None
        cols             = np.arange(width,  dtype=np.float32)
        self._map_y      = np.tile(cols, (height, 1))
        self._map_x      = self._map_y.copy()

    def _fires(self, p: float) -> bool:
        return random.random() < p * self.intensity

    def apply(self, frame: np.ndarray) -> np.ndarray:
        if self.intensity <= 0.0:
            return frame

        out = frame
        if self._fires(_P_FRAME_SKIP):
            out = _effect_frame_skip(out, self._prev_frame)
            self._prev_frame = frame
            return out
        if self._fires(_P_TEAR):
            out = _effect_tear(out, random.randint(1, TEAR_MAX_BANDS),
                               TEAR_MAX_HEIGHT, TEAR_MAX_SHIFT)
        if self._fires(_P_WARP):
            out = _effect_warp(out, self._map_x, self._map_y,
                               WARP_AMPLITUDE, WARP_FREQUENCY)
        if self._fires(_P_FLICKER):
            out = _effect_flicker(out, FLICKER_INVERT)
        if self._fires(_P_STUTTER):
            _effect_stutter(STUTTER_MIN_MS, STUTTER_MAX_MS)
        self._prev_frame = frame
        return out


# ══════════════════════════════════════════════════════════════════
#  AUDIO  —  thin adapter so StateMachine speaks one interface
#  regardless of whether audio_engine.py is present.
# ══════════════════════════════════════════════════════════════════

class _NullAudio:
    """No-op stub used when audio_engine.py is unavailable."""
    def load_audio(self): pass
    def play_phase_audio(self, phase): pass
    def update(self, dt): pass
    def stop_audio(self): pass
    def set_master_volume(self, v): pass



# ══════════════════════════════════════════════════════════════════
#  STATE MACHINE
# ══════════════════════════════════════════════════════════════════

class StateMachine:
    """
    Drives the eight-phase experience loop.

    Public interface
    ────────────────
    sm.update(frame, dt)  — call once per tick; returns display_frame
    sm.trigger()          — external trigger (motion / key)
    sm.force_next()       — dev shortcut: jump to next phase
    sm.phase              — current Phase enum value

    Transition rules
    ────────────────
    IDLE      → DETECTION  on trigger() or motion
    DETECTION → MIRROR     after PHASE_DURATIONS["DETECTION"]
    MIRROR    → DELAY      after duration
    DELAY     → GLITCH     after duration
    GLITCH    → BREAK      after duration
    BREAK     → CAPTURE    after duration  (print fires on entry)
    CAPTURE   → RESET      after duration
    RESET     → IDLE       after duration
    """

    def __init__(
        self,
        buf:    FrameBuffer,
        glitch: GlitchEngine,
        audio,   # AudioEngine or _NullAudio
        motion: MotionDetector,
        width:  int,
        height: int,
    ) -> None:
        self._buf    = buf
        self._glitch = glitch
        self._audio  = audio
        self._motion = motion
        self._W      = width
        self._H      = height


        # Print + shred orchestrator (None if print_shred.py not present)
        self._orchestrator = PrintShredOrchestrator() if PRINT_SHRED_AVAILABLE else None

        # Fonts for IDLE overlay (loaded lazily)
        self._font_small = None
        self._font_rec   = None

        # Break phase: solid black surface
        self._black = np.zeros((height, width, 3), dtype=np.uint8)

        # Capture phase: freeze on entry
        self._frozen_frame: Optional[np.ndarray] = None

        # Cross-fade state
        self._fade_alpha    = 1.0   # 1.0 = fully opaque new frame
        self._fade_duration = 0.35  # seconds for each transition blend

        self._phase         = Phase.IDLE
        self._phase_entered = time.monotonic()
        self._triggered     = False

        self._enter_phase(Phase.IDLE)

    # ── Public ────────────────────────────────────────────────────

    @property
    def phase(self) -> Phase:
        return self._phase

    def trigger(self) -> None:
        """Signal an external event (key press, PIR, etc.)."""
        if self._phase is Phase.IDLE:
            self._triggered = True

    def force_next(self) -> None:
        """Dev shortcut — advance to the next phase immediately."""
        idx = PHASE_SEQUENCE.index(self._phase)
        nxt = PHASE_SEQUENCE[(idx + 1) % len(PHASE_SEQUENCE)]
        self._enter_phase(nxt)

    def update(self, raw_frame: np.ndarray, dt: float) -> np.ndarray:
        """
        Main tick.  Accepts raw processed RGB frame, returns the
        frame to display (with phase-specific rendering applied).

        dt : seconds since last tick
        """
        self._buf.push(raw_frame)

        # NOTE: Motion detection runs externally via detect_motion() /
        # trigger_experience() in run() before sm.update() is called.
        # trigger() sets self._triggered; we consume it here.

        # Consume trigger
        if self._triggered:
            self._triggered = False
            if self._phase is Phase.IDLE:
                self._enter_phase(Phase.DETECTION)

        # Advance cross-fade
        self._fade_alpha = min(1.0, self._fade_alpha + dt / self._fade_duration)

        # Check timed transition
        self._check_timeout()

        # Render current phase
        display = self._render(raw_frame)

        return display

    # ── Phase entry ───────────────────────────────────────────────

    def _enter_phase(self, phase: Phase) -> None:
        prev          = self._phase
        self._phase   = phase
        self._phase_entered = time.monotonic()
        self._fade_alpha    = 0.0   # start cross-fade

        name = phase.name
        print(f"[SM] {prev.name:10s} → {name}", flush=True)

        # mirrorloop-kiosk: forward phase transitions to Supabase telemetry
        # (set by run() if telemetry came up). Best-effort, never raises.
        _tel = getattr(self, "_telemetry", None)
        if _tel is not None:
            try:
                _tel.on_phase(name)
            except Exception as _e:
                print(f"[telemetry] on_phase error: {_e}", flush=True)

        # Set glitch intensity for this phase
        self._glitch.intensity = PHASE_GLITCH.get(name, 0.0)

        # Delegate ALL audio transitions to the AudioEngine.
        # Phase-to-sound mapping lives in audio_engine.py → PHASE_CONFIG.
        self._audio.play_phase_audio(name)

        # Phase-specific non-audio entry actions
        if phase is Phase.DETECTION:
            self._motion.reset()            # clear MOG2 + hysteresis
            self._motion.notify_activity()  # reset idle timer — experience starting

        elif phase is Phase.CAPTURE:
            # Freeze a frame from the past for display during this phase
            self._frozen_frame = self._buf.get_delayed(CAPTURE_BUFFER_OFFSET_S)
            # Delegate full print+shred cycle to the orchestrator
            if self._orchestrator:
                self._orchestrator.run_cycle(self._buf)
            else:
                print("[SM] CAPTURE — print_shred module not loaded.", flush=True)

        elif phase is Phase.IDLE:
            self._frozen_frame = None
            self._motion.reset()    # clears MOG2 model + hysteresis counter

    # ── Timeout transitions ───────────────────────────────────────

    def _check_timeout(self) -> None:
        name     = self._phase.name
        duration = PHASE_DURATIONS.get(name)
        if duration is None:
            return   # IDLE — no automatic timeout

        elapsed = time.monotonic() - self._phase_entered
        if elapsed >= duration:
            idx = PHASE_SEQUENCE.index(self._phase)
            nxt = PHASE_SEQUENCE[(idx + 1) % len(PHASE_SEQUENCE)]
            self._enter_phase(nxt)

    # ── Phase rendering ───────────────────────────────────────────

    def _render(self, raw_frame: np.ndarray) -> np.ndarray:
        phase = self._phase
        name  = phase.name

        # Select source frame based on phase delay
        delay = PHASE_DELAY_S.get(name, 0.0)
        if delay > 0.0:
            src = self._buf.get_delayed(delay) or raw_frame
        else:
            src = raw_frame

        # BREAK: pure black
        if phase is Phase.BREAK:
            return self._black

        # CAPTURE: frozen frame
        if phase is Phase.CAPTURE:
            src = self._frozen_frame if self._frozen_frame is not None else src

        # Apply phase contrast
        a_d, b_d = PHASE_CONTRAST.get(name, (0.0, 0))
        if a_d != 0.0 or b_d != 0:
            src = cv2.convertScaleAbs(
                src,
                alpha = float(np.clip(1.0 + a_d, 0.1, 4.0)),
                beta  = int(b_d),
            )

        # Apply glitch
        src = self._glitch.apply(src)

        # IDLE overlay: security-cam HUD
        if phase is Phase.IDLE:
            src = self._draw_idle_overlay(src.copy())

        # DETECTION overlay: brief flash border
        if phase is Phase.DETECTION:
            src = self._draw_detection_overlay(src.copy())

        # Blend cross-fade: lerp from black
        if self._fade_alpha < 1.0:
            src = cv2.addWeighted(
                src,         self._fade_alpha,
                self._black, 1.0 - self._fade_alpha,
                0,
            ).astype(np.uint8)

        return src

    # ── Overlay helpers ───────────────────────────────────────────

    def _draw_idle_overlay(self, frame: np.ndarray) -> np.ndarray:
        """
        Security-camera aesthetic: timestamp top-left, REC dot top-right,
        thin corner brackets.
        """
        h, w = frame.shape[:2]

        # Corner brackets
        blen, bthk = 18, 2
        col = (180, 200, 180)
        pts = [
            # top-left
            ((0, blen), (0, 0), (blen, 0)),
            # top-right
            ((w - blen, 0), (w, 0), (w, blen)),
            # bottom-left
            ((0, h - blen), (0, h), (blen, h)),
            # bottom-right
            ((w - blen, h), (w, h), (w, h - blen)),
        ]
        for (p1, p2, p3) in pts:
            cv2.line(frame, p1, p2, col, bthk)
            cv2.line(frame, p2, p3, col, bthk)

        # Timestamp
        if IDLE_SHOW_TIMESTAMP:
            ts  = datetime.datetime.now().strftime("%Y-%m-%d  %H:%M:%S")
            cv2.putText(frame, ts, (10, h - 12),
                        cv2.FONT_HERSHEY_PLAIN, 0.95, (160, 200, 160), 1,
                        cv2.LINE_AA)

        # REC indicator
        if IDLE_SHOW_REC:
            pulse = (time.monotonic() % 2.0) < 1.0   # 1 Hz blink
            if pulse:
                cv2.circle(frame, (w - 22, 16), 5, (0, 60, 0), -1)
            cv2.putText(frame, "REC", (w - 50, 20),
                        cv2.FONT_HERSHEY_PLAIN, 0.85, (0, 140, 0), 1,
                        cv2.LINE_AA)

        return frame

    def _draw_detection_overlay(self, frame: np.ndarray) -> np.ndarray:
        """Thin red border pulse — system has noticed the subject."""
        h, w = frame.shape[:2]
        t    = time.monotonic() - self._phase_entered
        # Fade in quickly, hold, fade out
        alpha = min(1.0, t / 0.2) * max(0.0, 1.0 - (t - 0.8) / 0.8)
        alpha = float(np.clip(alpha, 0.0, 1.0))
        if alpha > 0.0:
            overlay = frame.copy()
            thickness = 5
            cv2.rectangle(overlay, (0, 0), (w - 1, h - 1), (180, 0, 0), thickness)
            frame = cv2.addWeighted(frame, 1.0 - alpha * 0.6,
                                    overlay, alpha * 0.6, 0).astype(np.uint8)
        return frame


# ══════════════════════════════════════════════════════════════════
#  VIGNETTE + CINEMATIC FILTER
# ══════════════════════════════════════════════════════════════════

def build_vignette(w, h, strength):
    cx, cy = w / 2.0, h / 2.0
    Y, X   = np.ogrid[:h, :w]
    dist   = np.sqrt(((X - cx) / cx) ** 2 + ((Y - cy) / cy) ** 2)
    mask   = np.cos(np.clip(dist, 0.0, 1.0) * np.pi / 2.0) ** 1.5
    return (1.0 - strength * (1.0 - mask)).astype(np.float32)


def cinematic_filter(frame, vignette, alpha, beta):
    frame = cv2.flip(frame, 1)
    frame = cv2.convertScaleAbs(frame, alpha=alpha, beta=beta)
    frame = np.clip(frame.astype(np.float32) * vignette[:, :, np.newaxis],
                    0, 255).astype(np.uint8)
    return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)


# ══════════════════════════════════════════════════════════════════
#  HARDWARE INIT
# ══════════════════════════════════════════════════════════════════

def open_camera(index, w, h):
    # Non-fatal: returns None if the camera isn't present (e.g. C920 unplugged)
    # so the renderer can show a standby screen and keep retrying instead of
    # exiting (which would drop the framebuffer back to the boot console).
    try:
        cap = cv2.VideoCapture(index)
    except Exception:
        return None
    if not cap or not cap.isOpened():
        try: cap.release()
        except Exception: pass
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  w)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
    cap.set(cv2.CAP_PROP_FPS,          TARGET_FPS)
    cap.set(cv2.CAP_PROP_BUFFERSIZE,   1)
    return cap


_standby_font = None
def draw_standby(screen, w, h, msg: str) -> None:
    """Fullscreen 'waiting for camera' screen so the TV never shows the console
    when the C920 is absent. pygame keeps owning the framebuffer."""
    global _standby_font
    if _standby_font is None:
        pygame.font.init()
        _standby_font = pygame.font.Font(None, max(18, h // 12))
    screen.fill((6, 0, 8))
    t1 = _standby_font.render("MIRROR LOOP", True, (140, 20, 30))
    t2 = pygame.font.Font(None, max(12, h // 24)).render(msg, True, (120, 120, 120))
    screen.blit(t1, t1.get_rect(center=(w // 2, h // 2 - h // 12)))
    screen.blit(t2, t2.get_rect(center=(w // 2, h // 2 + h // 14)))
    pygame.display.flip()


def init_display(w, h):
    pygame.init()
    pygame.mouse.set_visible(False)
    screen = pygame.display.set_mode(
        (w, h), pygame.FULLSCREEN | pygame.NOFRAME | pygame.SCALED
    )
    pygame.display.set_caption("Mirror Loop")
    return screen


# ══════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ══════════════════════════════════════════════════════════════════

def run(cfg: "InstallationConfig" = None) -> None:  # type: ignore[assignment]
    """
    Main entry point.  Accepts a pre-loaded InstallationConfig; if none
    is provided (e.g. called without config_manager), falls back to
    the module-level constants defined above.
    """
    # ── Apply config to module-level tables ──────────────────────
    global PHASE_DURATIONS, PHASE_GLITCH, CAPTURE_BUFFER_OFFSET_S
    if cfg is not None:
        PHASE_DURATIONS         = cfg.phase_durations
        PHASE_GLITCH            = cfg.phase_glitch
        CAPTURE_BUFFER_OFFSET_S = cfg.capture_offset_s

    # Convenience aliases from cfg (or module defaults)
    RESOLUTION      = cfg.resolution       if cfg else _DEFAULT_RESOLUTION
    TARGET_FPS      = cfg.target_fps       if cfg else _DEFAULT_TARGET_FPS
    CAMERA_INDEX    = cfg.camera_index     if cfg else 0
    CONTRAST_ALPHA  = cfg.contrast_alpha   if cfg else _DEFAULT_CONTRAST_ALPHA
    CONTRAST_BETA   = cfg.contrast_beta    if cfg else _DEFAULT_CONTRAST_BETA
    VIGNETTE_STR    = cfg.vignette_strength if cfg else _DEFAULT_VIGNETTE
    BUFFER_SECONDS  = cfg.buffer_seconds   if cfg else _DEFAULT_BUFFER_S

    W, H = RESOLUTION

    # ── One-time setup ────────────────────────────────────────────
    vignette = build_vignette(W, H, VIGNETTE_STR)
    buf      = FrameBuffer(int(BUFFER_SECONDS * TARGET_FPS) + 10)
    glitch   = GlitchEngine(W, H)
    audio    = AudioEngine() if AUDIO_ENGINE_AVAILABLE else _NullAudio()
    audio.load_audio()
    if cfg and hasattr(audio, 'set_master_volume'):
        audio.set_master_volume(cfg.master_volume if cfg else 0.85)
    # Build MotionEngine — uses motion_engine.py if available,
    # otherwise falls back to the thin _FallbackMotionDetector shim.
    if MOTION_ENGINE_AVAILABLE:
        motion = MotionEngine(
            threshold          = MOTION_THRESHOLD,
            hysteresis         = MOTION_HYSTERESIS,
            blur_k             = MOTION_BLUR_K,
            zone               = DETECTION_ZONE,
            trigger_cooldown_s = TRIGGER_COOLDOWN_S,
            idle_timeout_s     = IDLE_TIMEOUT_S,
            pir_enabled        = PIR_ENABLED,
            pir_pin            = PIR_GPIO_PIN,
            debug_overlay      = MOTION_DEBUG_OVERLAY,
            # idle_callback wired in below after sm is created
        )
    else:
        motion = _FallbackMotionDetector(MOTION_THRESHOLD, MOTION_BLUR_K)
    # Claim the display FIRST so the framebuffer is ours immediately (no console
    # flash), then acquire the camera non-fatally (standby + retry if absent).
    screen   = init_display(W, H)
    clock    = pygame.time.Clock()
    surface  = pygame.Surface((W, H))
    cap      = open_camera(CAMERA_INDEX, W, H)
    _last_cam_try = time.monotonic()

    sm = StateMachine(buf, glitch, audio, motion, W, H)

    # ── Supabase telemetry (mirrorloop-kiosk) ─────────────────────
    # Posts heartbeats + sessions + phase events so the unit appears on
    # sinsera.co/mirrorloop. Wired into the state machine via sm._telemetry
    # (consumed in StateMachine._enter_phase). Best-effort — a failure here
    # leaves the display running normally.
    telemetry = None
    if TELEMETRY_AVAILABLE:
        try:
            telemetry = Telemetry()
            telemetry.start(lambda: sm.phase.name)
            sm._telemetry = telemetry
            print("[telemetry] online — posting to sinsera.co/mirrorloop", flush=True)
        except Exception as exc:
            telemetry = None
            print(f"[telemetry] disabled: {exc}", flush=True)

    # ── Session logger ────────────────────────────────────────────
    session_logger = SessionLogger(cfg) if (CONFIG_MANAGER_AVAILABLE and cfg) else None
    if session_logger:
        # Wire session_id into the state machine so print receipts carry it
        sm._session_logger = session_logger

    # ── Network sync ──────────────────────────────────────────────
    net_sync = None
    if CONFIG_MANAGER_AVAILABLE and cfg and cfg.network_sync_enabled:
        net_sync = sync_network(cfg, start_callback=lambda: sm.trigger())

    # Wire idle callback AFTER sm exists, then start motion engine threads
    if MOTION_ENGINE_AVAILABLE:
        motion._idle_cb = lambda: sm.force_idle()
        motion.start()
    else:
        motion.start()

    print(
        f"\n[Mirror Loop v7]\n"
        f"  Resolution : {W}×{H}  @{TARGET_FPS}fps\n"
        f"  Buffer     : {BUFFER_SECONDS}s\n"
        f"  Motion     : {'MotionEngine' if MOTION_ENGINE_AVAILABLE else 'basic'}"
            f"  (threshold={MOTION_THRESHOLD}  hyst={MOTION_HYSTERESIS}  "
            f"pir={'on' if PIR_ENABLED else 'off'})\n"
        f"  Idle reset : {IDLE_TIMEOUT_S}s\n"
        f"  Printer    : {'ZINK via CUPS' if PRINT_SHRED_AVAILABLE else 'fallback PNG'}\n"
        f"  Audio      : {'AudioEngine' if AUDIO_ENGINE_AVAILABLE else 'disabled'}\n"
        f"  SPACE      : manual trigger from IDLE\n"
        f"  D          : dev — force next phase\n"
        f"  ESC / Q    : quit\n"
    )

    prev_time = time.monotonic()

    try:
        while True:
            now = time.monotonic()
            dt  = now - prev_time
            prev_time = now

            # ── Events ───────────────────────────────────────────
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
                if event.type == pygame.KEYDOWN:
                    if event.key in (pygame.K_ESCAPE, pygame.K_q):
                        return
                    if event.key == pygame.K_SPACE:
                        sm.trigger()
                    if event.key == pygame.K_d:
                        sm.force_next()

            # ── Camera (re)acquire + standby ─────────────────────
            # No camera yet (e.g. C920 unplugged): show standby + retry every 3s.
            if cap is None:
                if now - _last_cam_try > 3.0:
                    cap = open_camera(CAMERA_INDEX, W, H)
                    _last_cam_try = now
                draw_standby(screen, W, H, "waiting for camera…")
                clock.tick(TARGET_FPS)
                continue

            # ── Capture ──────────────────────────────────────────
            ret, raw = cap.read()
            if not ret:
                # Camera dropped mid-run — release and fall back to standby.
                print("[Warning] Frame grab failed — camera dropped, retrying", flush=True)
                try: cap.release()
                except Exception: pass
                cap = None
                continue

            # The camera may ignore the requested size (e.g. C920 hands back
            # 640x360 when we asked for 480x360). Force every frame to the
            # configured W×H so the vignette/effects arrays always broadcast.
            if raw.shape[1] != W or raw.shape[0] != H:
                raw = cv2.resize(raw, (W, H))

            # Base cinematic filter (mirror + vignette + base contrast)
            processed = cinematic_filter(
                raw, vignette, CONTRAST_ALPHA, CONTRAST_BETA
            )

            # ── Motion detection ─────────────────────────────────
            # detect_motion() calls engine.tick() which handles:
            #   • MOG2 / frame-diff scoring
            #   • PIR fusion
            #   • Hysteresis counting
            #   • Idle timeout checking
            mot_result = detect_motion(motion, processed, dt)
            trigger_experience(sm, mot_result)   # calls sm.trigger() on TRIGGER

            # ── Network sync timeout check (follower units) ───────
            if net_sync:
                net_sync.check_timeout()

            # ── State machine tick ────────────────────────────────
            display = sm.update(processed, dt)

            # ── Audio envelope update (very cheap — no decoding here)
            audio.update(dt)

            # ── Motion debug overlay (dev only) ───────────────────
            if MOTION_DEBUG_OVERLAY and MOTION_ENGINE_AVAILABLE:
                display = motion.draw_debug(display.copy(), mot_result)

            # ── Render ───────────────────────────────────────────
            pygame.surfarray.blit_array(surface, display.swapaxes(0, 1))
            screen.blit(surface, (0, 0))
            pygame.display.flip()

            clock.tick(TARGET_FPS)

    finally:
        if telemetry is not None:
            try: telemetry.stop()
            except Exception: pass
        audio.stop_audio()
        motion.stop()
        if cap is not None:
            try: cap.release()
            except Exception: pass
        if sm._orchestrator:
            sm._orchestrator.cleanup()
        if net_sync:
            net_sync.stop()
        if session_logger:
            save_session_log(session_logger)
        pygame.quit()
        print("[Mirror Loop] Exited cleanly.")


# ══════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Mirror Loop — DarkHaus Installation")
    parser.add_argument(
        "--config", "-c", metavar="PATH",
        help="Config file (.yaml or .json). Defaults to ./config.yaml",
    )
    parser.add_argument(
        "--export-defaults", metavar="PATH",
        help="Export built-in default config to PATH and exit",
    )
    parser.add_argument(
        "--unit-id", metavar="ID",
        help="Override unit_id from config (e.g. --unit-id unit-B)",
    )
    parser.add_argument(
        "--dev", action="store_true",
        help="Force dev_mode=true (short phases, verbose logging)",
    )
    args = parser.parse_args()

    # Export defaults and exit
    if args.export_defaults:
        if CONFIG_MANAGER_AVAILABLE:
            from config_manager import InstallationConfig, export_config
            export_config(InstallationConfig(), args.export_defaults)
        else:
            print("[Error] config_manager.py not found", file=sys.stderr)
        sys.exit(0)

    # Load config
    cfg = None
    if CONFIG_MANAGER_AVAILABLE:
        overrides = {}
        if args.unit_id:
            overrides["unit_id"] = args.unit_id
        if args.dev:
            overrides["dev_mode"] = True
        cfg = load_config(args.config, overrides=overrides)
        setup_logging(cfg)
    else:
        import logging
        logging.basicConfig(level=logging.INFO,
                            format="%(asctime)s  %(levelname)-8s  %(message)s")

    try:
        run(cfg)
    except (RuntimeError, ValueError) as exc:
        print(f"[Error] {exc}", file=sys.stderr)
        sys.exit(1)
