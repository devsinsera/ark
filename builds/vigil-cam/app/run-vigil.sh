#!/bin/bash
# Vigil launcher — headless. One instance per camera; the systemd unit sets
# CAM_SLOT (0-based) + CAMERA_SLUG + MJPEG_PORT. We resolve CAM_SLOT to a STABLE
# capture device via /dev/v4l/by-path so Cam1/Cam2 never swap across reboots and
# metadata nodes are skipped. Env (SUPABASE_*/VIGIL_*/tunables) via python-dotenv.
export PYGAME_HIDE_SUPPORT_PROMPT=1
export OPENCV_LOG_LEVEL=ERROR
cd /opt/vigil || exit 1
set -a; [ -f /opt/vigil/.env ] && . /opt/vigil/.env; set +a
if [ -n "${CAM_SLOT:-}" ] && [ -z "${CAM_DEVICE:-}" ]; then
  mapfile -t CAPS < <(ls /dev/v4l/by-path/*-video-index0 2>/dev/null | sort)
  if [ "${#CAPS[@]}" -gt "$CAM_SLOT" ]; then
    export CAM_DEVICE="${CAPS[$CAM_SLOT]}"
  fi
  echo "[vigil] slot ${CAM_SLOT} -> ${CAM_DEVICE:-<none: falling back to CAM_INDEX>} (${#CAPS[@]} capture nodes present)"
fi
exec python3 /opt/vigil/vigil_cam.py
