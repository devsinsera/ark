#!/bin/bash
# Vigil Wall launcher — Sinsera Node 3. Runs the Pygame renderer FULLSCREEN on
# the HDMI framebuffer via SDL's kmsdrm backend (NO X, NO browser). Invoked from
# the 'wall' user's ~/.bash_profile on tty1 autologin, with a crash-restart loop.
#
# Tune perf over SSH: edit RES / VIGIL_TILE_FPS in vigil-wall.py, or set
# VIGIL_BRIDGE / VIGIL_TILE_FPS in the environment. Log: /var/log/vigil-wall.log

export SDL_VIDEODRIVER=kmsdrm
export SDL_AUDIODRIVER=dummy
export PYGAME_HIDE_SUPPORT_PROMPT=1

cd /opt/vigil-wall || exit 1
LOG=/var/log/vigil-wall.log

while true; do
  echo "[launcher] starting vigil-wall.py $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
  python3 /opt/vigil-wall/vigil-wall.py >> "$LOG" 2>&1
  rc=$?
  echo "[launcher] vigil-wall.py exited rc=$rc — restarting in 5s" >> "$LOG"
  sleep 5
done
