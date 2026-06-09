#!/bin/bash
# Vigil launcher — headless security camera (NO display, NO X, NO SDL).
# Run by the vigil.service systemd unit (Restart=always). Logs to
# /var/log/vigil.log. Env (SUPABASE_*, VIGIL_*, tunables) is read by
# vigil_auth.py via python-dotenv from /opt/vigil/.env.
export PYGAME_HIDE_SUPPORT_PROMPT=1
export OPENCV_LOG_LEVEL=ERROR
cd /opt/vigil || exit 1
exec python3 /opt/vigil/vigil_cam.py
