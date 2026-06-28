#!/usr/bin/env python3
"""
Vigil Wall — Sinsera Node 3.

Renders the Eufy camera grid FULLSCREEN on the HDMI framebuffer (SDL kmsdrm,
no X, no browser) for a Pi Zero 2 W driving a 75" TV at 1080p.

Lightweight by design: it pulls JPEG *snapshots* from the eufy bridge
(/snap/<serial>) ~1.5 fps per tile and tiles them — not live video — so the
Zero 2 W stays smooth. /status (every 3s) drives the per-tile motion/live border.

The camera list is fetched LIVE from the bridge's /cams endpoint, so a newly
paired SPARE camera shows up automatically (and the grid auto-sizes) without
editing this file — re-pulled every 60s. If the bridge is unreachable at boot we
fall back to the core four so the wall is never blank. (The old .179 "Front Door
LAN" cam IS this Pi, so the bridge keeps it off /cams and out of this grid.)

Tune over SSH: env VIGIL_BRIDGE / VIGIL_TILE_FPS, or the constants below.
Log: /var/log/vigil-wall.log
"""
from __future__ import annotations
import os, io, time, math, threading
import pygame
import requests

BRIDGE       = os.environ.get("VIGIL_BRIDGE", "http://192.168.4.163:8091")
FPS_PER_TILE = float(os.environ.get("VIGIL_TILE_FPS", "1.5"))  # snapshot refresh/cam
CAMS_REFRESH = 60.0   # re-pull /cams this often so a freshly paired spare appears
RES          = (1920, 1080)
BG    = (8, 4, 6)
GOLD  = (212, 160, 23)
EMBER = (255, 69, 0)
INK   = (201, 168, 130)
DIM   = (122, 92, 74)

# Fallback ONLY — used when the bridge's /cams endpoint can't be reached at boot.
# Normally the list (core cameras + any spare) comes live from the bridge.
FALLBACK_CAMS = [
    ("T8160T1224041058", "BACK"),
    ("T8210P812335014E", "DOOR"),
    ("T8170T1025032AD7", "FRONT"),
    ("T8410P5025402107", "FRONT YARD"),
]


def fetch_cams():
    """[(serial, LABEL)] from the bridge /cams (auto-discovered: core + spare).
    Falls back to FALLBACK_CAMS when the bridge is unreachable so we never blank."""
    try:
        r = requests.get(f"{BRIDGE}/cams", timeout=6)
        if r.status_code == 200:
            cams = [(c["serial"], (c.get("label") or c["serial"]).upper())
                    for c in (r.json() or []) if c.get("serial")]
            if cams:
                return cams
    except Exception:
        pass
    return FALLBACK_CAMS


class Tile:
    def __init__(self, serial, label):
        self.serial = serial
        self.label = label
        self.surf = None
        self.last_ok = 0.0
        self.lock = threading.Lock()

    def grab(self):
        """One /snap attempt; cache the frame if one comes back. True on success."""
        try:
            r = requests.get(f"{BRIDGE}/snap/{self.serial}", timeout=7)
            if r.status_code == 200 and r.content:
                img = pygame.image.load(io.BytesIO(r.content)).convert()
                with self.lock:
                    self.surf = img
                    self.last_ok = time.time()
                return True
        except Exception:
            pass
        return False


class Wall:
    """Live, thread-safe ordered set of tiles. Tile objects are REUSED across a
    /cams refresh so each tile keeps its cached frame and the picture never blinks."""
    def __init__(self):
        self.lock = threading.Lock()
        self.tiles = []
        self.set_cams(fetch_cams())

    def set_cams(self, cams):
        with self.lock:
            keep = {t.serial: t for t in self.tiles}
            self.tiles = [keep.get(s) or Tile(s, l) for s, l in cams]

    def snapshot(self):
        with self.lock:
            return list(self.tiles)


def refresher(wall):
    while True:
        time.sleep(CAMS_REFRESH)
        wall.set_cams(fetch_cams())


def poll_status(state):
    while True:
        try:
            r = requests.get(f"{BRIDGE}/status", timeout=6)
            if r.status_code == 200:
                data = r.json() or {}
                if isinstance(data, dict):
                    state.clear()
                    state.update(data)
        except Exception:
            pass
        time.sleep(3)


def rotator(wall):
    # eufy battery cams can't all stream at once (HomeBase P2P ~2 max), so ROTATE:
    # warm one camera via /snap until a frame lands, grab a few fresh frames, then
    # move on. Each tile keeps its last still → all show an image, refreshed as the
    # cycle comes round. One camera warm at a time stays within the P2P limit.
    while True:
        tiles = wall.snapshot()
        if not tiles:
            time.sleep(1)
            continue
        for t in tiles:
            warmed = False
            for _ in range(8):          # cold /snap 503s until the stream produces a frame
                if t.grab():
                    warmed = True
                    break
                time.sleep(1)
            if warmed:
                for _ in range(4):       # a few fresh frames while it's hot
                    time.sleep(1)
                    t.grab()
            else:
                time.sleep(1)


def main():
    os.environ.setdefault("SDL_VIDEODRIVER", "kmsdrm")
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
    pygame.init()
    pygame.mouse.set_visible(False)
    screen = pygame.display.set_mode(RES, pygame.FULLSCREEN)
    W, H = screen.get_size()
    # diagnostic: confirm the real driver + the modeset size reached the framebuffer
    try:
        with open("/var/log/vigil-wall.log", "a") as _l:
            _l.write(f"[init] driver={pygame.display.get_driver()} size={W}x{H}\n")
    except Exception:
        pass

    # Use a real font FILE (fonts-dejavu-core) — SysFont needs fontconfig/fc-list,
    # which isn't installed on the lean image, so it silently degrades.
    def _font(sz, bold=False):
        p = ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold
             else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
        try:
            return pygame.font.Font(p, sz)
        except Exception:
            return pygame.font.Font(None, sz)
    font = _font(24, bold=True)
    small = _font(16)
    hdr_font = _font(20, bold=True)

    wall = Wall()
    threading.Thread(target=rotator, args=(wall,), daemon=True).start()
    threading.Thread(target=refresher, args=(wall,), daemon=True).start()
    status: dict = {}
    threading.Thread(target=poll_status, args=(status,), daemon=True).start()

    gap = 6
    clock = pygame.time.Clock()
    frame = 0
    while True:
        for e in pygame.event.get():
            if e.type == pygame.QUIT:
                return
            if e.type == pygame.KEYDOWN and e.key in (pygame.K_ESCAPE, pygame.K_q):
                return

        # Grid auto-sizes to the live camera count (4 → 2x2, 5/6 → 3x2, 9 → 3x3…).
        tiles = wall.snapshot()
        n = len(tiles)
        cols = max(1, math.ceil(math.sqrt(n))) if n else 1
        rows = max(1, math.ceil(n / cols)) if n else 1
        tw = (W - gap * (cols + 1)) // cols
        th = (H - gap * (rows + 1)) // rows

        screen.fill(BG)
        for i, t in enumerate(tiles):
            cx = gap + (i % cols) * (tw + gap)
            cy = gap + (i // cols) * (th + gap)
            rect = pygame.Rect(cx, cy, tw, th)
            with t.lock:
                surf, age = t.surf, time.time() - t.last_ok

            if surf:
                iw, ih = surf.get_size()
                scale = min(tw / iw, th / ih)
                dw, dh = int(iw * scale), int(ih * scale)
                screen.blit(pygame.transform.smoothscale(surf, (dw, dh)),
                            (cx + (tw - dw) // 2, cy + (th - dh) // 2))
            else:
                screen.fill((28, 28, 40), rect)   # visible grey-blue, not near-black
                screen.blit(small.render(f"{t.label} — connecting…", True, (170, 180, 210)),
                            (cx + 14, cy + th // 2 - 8))

            st = status.get(t.serial) or {}
            motion = bool(st.get("motion"))
            live = bool(st.get("live"))
            stale = age > 12
            border = (80, 30, 30) if stale else (EMBER if motion else (GOLD if live else DIM))
            pygame.draw.rect(screen, border, rect, 2)

            # label plate
            lab = font.render(t.label, True, INK)
            screen.blit(lab, (cx + 12, cy + th - 36))
            if motion:
                screen.blit(small.render("◢ MOTION", True, EMBER), (cx + tw - 118, cy + 12))

        loaded = sum(1 for t in tiles if t.surf is not None)
        pygame.draw.rect(screen, (150, 20, 20), (0, 0, W, 46))   # bright header strip (proves HDMI output)
        screen.blit(hdr_font.render(f"VIGIL · NODE 3 · {loaded}/{n} cameras live", True, (255, 224, 130)), (18, 12))

        pygame.display.flip()
        clock.tick(12)
        frame += 1
        if frame % 120 == 0:
            try:
                with open("/var/log/vigil-wall.log", "a") as _l:
                    _l.write(f"[hb] frame={frame} cams={loaded}/{n}\n")
            except Exception:
                pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        pygame.quit()
