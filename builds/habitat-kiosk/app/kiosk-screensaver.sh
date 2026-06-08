#!/bin/sh
# Sinsera kiosk screensaver — after 5 min idle, show the logo centred on black;
# clear instantly on activity. Passive X-idle poll (xprintidle); shows/hides a
# fullscreen feh window over the kiosk. No effect on the running browser.
LOGO="${KIOSK_LOGO:-/opt/kiosk/logo.png}"
IDLE_MS="${KIOSK_IDLE_MS:-300000}"   # 5 minutes
showing=0
FEH=""
while true; do
  idle=$(xprintidle 2>/dev/null || echo 0)
  if [ "$idle" -ge "$IDLE_MS" ] && [ "$showing" -eq 0 ]; then
    feh --fullscreen --hide-pointer --image-bg black --zoom 55 "$LOGO" >/dev/null 2>&1 &
    FEH=$!; showing=1
  elif [ "$idle" -lt "$IDLE_MS" ] && [ "$showing" -eq 1 ]; then
    [ -n "$FEH" ] && kill "$FEH" 2>/dev/null
    showing=0
  fi
  sleep 5
done
