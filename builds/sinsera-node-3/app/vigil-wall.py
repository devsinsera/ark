#!/usr/bin/env python3
"""
Vigil Wall — Sinsera Node 3.

Renders the Eufy camera grid FULLSCREEN on the HDMI framebuffer (SDL kmsdrm,
no X, no browser) for a Pi Zero 2 W driving a 75" TV at 1080p.

Lightweight by design: it pulls JPEG *snapshots* from the eufy bridge
(/snap/<serial>) ~1.5 fps per tile and tiles them — not live video — so the
Zero 2 W stays smooth. /status (every 3s) drives the per-tile motion/live border.

The four Eufy cams only (Back/Door/Front/Front Yard). The old .179 "Front Door
LAN" cam IS this Pi now, so it's deliberately out of the grid.

Tune over SSH: env VIGIL_BRIDGE / VIGIL_TILE_FPS, or the constants below.
Log: /var/log/vigil-wall.log
"""
from __future__ import annotations
import os, io, time, threading
import pygame
import requests

BRIDGE       = os.environ.get("VIGIL_BRIDGE", "http://192.168.4.163:8091")
FPS_PER_TILE = float(os.environ.get("VIGIL_TILE_FPS", "1.5"))  # snapshot refresh/cam
RES          = (1920, 1080)
BG    = (8, 4, 6)
GOLD  = (212, 160, 23)
EMBER = (255, 69, 0)
INK   = (201, 168, 130)
DIM   = (122, 92, 74)

# serial → label. The 2x2 grid order.
CAMERAS = [
    ("T8160T1224041058", "BACK"),
    ("T8210P812335014E", "DOOR"),
    ("T8170T1025032AD7", "FRONT"),
    ("T8410P5025402107", "FRONT YARD"),
]


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


def rotator(tiles):
    # eufy battery cams can't all stream at once (HomeBase P2P ~2 max), so ROTATE:
    # warm one camera via /snap until a frame lands, grab a few fresh frames, then
    # move on. Each tile keeps its last still → all 4 show an image, refreshed every
    # ~40s as the cycle comes round. One camera warm at a time stays within the limit.
    while True:
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

    # A persistent top header so a live-but-camera-less screen is unmistakably NOT blank.
    hdr_font = _font(20, bold=True)

    tiles = [Tile(s, l) for s, l in CAMERAS]
    threading.Thread(target=rotator, args=(tiles,), daemon=True).start()
    status: dict = {}
    threading.Thread(target=poll_status, args=(status,), daemon=True).start()

    cols, rows, gap = 2, 2, 6
    tw = (W - gap * (cols + 1)) // cols
    th = (H - gap * (rows + 1)) // rows
    clock = pygame.time.Clock()

    frame = 0
    while True:
        for e in pygame.event.get():
            if e.type == pygame.QUIT:
                return
            if e.type == pygame.KEYDOWN and e.key in (pygame.K_ESCAPE, pygame.K_q):
                return

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
        screen.blit(hdr_font.render(f"VIGIL · NODE 3 · {loaded}/4 cameras live", True, (255, 224, 130)), (18, 12))

        pygame.display.flip()
        clock.tick(12)
        frame += 1
        if frame % 120 == 0:
            try:
                with open("/var/log/vigil-wall.log", "a") as _l:
                    _l.write(f"[hb] frame={frame} cams={loaded}/4\n")
            except Exception:
                pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        pygame.quit()
