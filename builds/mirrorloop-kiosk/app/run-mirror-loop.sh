#!/bin/bash
# Mirror Loop launcher — runs the Pygame renderer FULLSCREEN on the framebuffer
# via SDL's kmsdrm backend (NO X, NO Chromium). Invoked from the 'mirror' user's
# ~/.bash_profile on tty1 autologin, with a crash-restart loop.
#
# Env (SUPABASE_*, MIRROR_*) is read by telemetry.py via python-dotenv from
# /opt/mirror-loop/.env — we deliberately do NOT 'source' it here (values like
# UNIT_LABEL contain spaces and would break bash word-splitting).
#
# Tune perf over SSH: edit _DEFAULT_RESOLUTION / _DEFAULT_TARGET_FPS in
# mirror_loop.py, or the SDL vars below. Log: /var/log/mirror-loop.log

# HDMI out (kmsdrm) by default; MIRROR_HEADLESS=1 in .env → SDL dummy driver so
# the renderer runs off-screen (no display) and only streams to the cloud — for
# when nothing is plugged into HDMI. Read just that one key (don't source .env;
# its values can contain spaces).
MIRROR_HEADLESS=$(grep -E '^MIRROR_HEADLESS=' /opt/mirror-loop/.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '01')
if [ "$MIRROR_HEADLESS" = "1" ]; then
  export SDL_VIDEODRIVER=dummy
else
  export SDL_VIDEODRIVER=kmsdrm
fi
export SDL_AUDIODRIVER=dummy
export PYGAME_HIDE_SUPPORT_PROMPT=1

cd /opt/mirror-loop || exit 1
LOG=/var/log/mirror-loop.log

while true; do
  echo "[launcher] starting mirror_loop.py $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
  python3 /opt/mirror-loop/mirror_loop.py >> "$LOG" 2>&1
  rc=$?
  echo "[launcher] mirror_loop.py exited rc=$rc — restarting in 5s" >> "$LOG"
  sleep 5
done
