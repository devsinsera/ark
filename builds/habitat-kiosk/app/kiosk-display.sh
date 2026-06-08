#!/bin/sh
# kiosk-display.sh — auto-detect the connected screen, drive it at its EDID-native
# mode, and echo the optimal chromium UI scale. Looks up the monitor by EDID model
# name in display-profiles.conf, falling back to a resolution rule for unknowns.
# Prints the SCALE on stdout; logs the decision to /var/log/kiosk-display.log.
CONF="${KIOSK_PROFILES:-/opt/kiosk/display-profiles.conf}"
LOG=/var/log/kiosk-display.log

OUT=$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
[ -z "$OUT" ] && { echo 1; exit 0; }

# native (EDID-preferred) mode
xrandr --output "$OUT" --auto 2>/dev/null
sleep 1
RES=$(xrandr 2>/dev/null | awk '/\*/{print $1}' | head -1)
W=${RES%x*}

# EDID model name of the connected output
MODEL=""
for e in /sys/class/drm/card*-*/edid; do
  st="$(dirname "$e")/status"
  [ "$(cat "$st" 2>/dev/null)" = "connected" ] || continue
  [ -s "$e" ] || continue
  if command -v edid-decode >/dev/null 2>&1; then
    MODEL=$(edid-decode "$e" 2>/dev/null | grep -iE "Display Product Name|Monitor name" | head -1 | sed "s/.*: //; s/['\"]//g")
  fi
  [ -n "$MODEL" ] && break
done

SCALE=""; LABEL=""
# 1) model match from the optimized list
if [ -n "$MODEL" ] && [ -f "$CONF" ]; then
  while IFS='|' read -r m s l; do
    m=$(echo "$m" | sed 's/^ *//; s/ *$//'); s=$(echo "$s" | tr -d ' ')
    case "$m" in ''|\#*) continue;; esac
    if echo "$MODEL" | grep -qi "$m"; then SCALE="$s"; LABEL=$(echo "$l" | sed 's/^ *//'); break; fi
  done < "$CONF"
fi
# 2) resolution-based fallback
if [ -z "$SCALE" ]; then
  case "$RES" in
    3840x2160) SCALE=2;    LABEL="4K (res)";;
    3440x1440) SCALE=1.25; LABEL="ultrawide 1440 (res)";;
    2560x1440) SCALE=1.25; LABEL="QHD (res)";;
    1920x1080) SCALE=1;    LABEL="1080p (res)";;
    *) if [ "${W:-0}" -ge 3000 ]; then SCALE=2; elif [ "${W:-0}" -ge 2400 ]; then SCALE=1.5; else SCALE=1; fi; LABEL="width tier";;
  esac
fi

echo "$(date -u +%H:%M:%S) ${MODEL:-unknown} @ ${RES:-?} -> scale $SCALE ($LABEL)" >> "$LOG" 2>/dev/null
echo "$SCALE"
