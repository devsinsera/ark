#!/bin/bash
# ragnar — start/stop/status the Ragnar service on this Pi.
#
# Thin wrapper around systemd's `ragnar.service` (writeen by the
# jacktheflipper install). Replaces an older PID-file based wrapper
# that gave false negatives whenever the python process forked.
#
# Usage:
#   ragnar {start|stop|restart|status|log|url|enable|disable}

set -e

PORT="${RAGNAR_PORT:-8091}"
UNIT=ragnar.service

is_listening() {
  ss -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print "yes"; exit}'
}

primary_ip() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{print $4}' | cut -d/ -f1 | head -1
}

case "${1:-status}" in
  start)
    sudo systemctl start "$UNIT"
    sleep 2
    if [ "$(is_listening)" = "yes" ]; then
      IP=$(primary_ip)
      echo "ragnar started"
      [ -n "$IP" ] && echo "dashboard: http://$IP:$PORT"
    else
      echo "ragnar starting (port not bound yet — Ragnar takes ~30s on first load)"
      echo "check again: ragnar status"
    fi
    ;;
  stop)
    sudo systemctl stop "$UNIT"
    echo "ragnar stopped"
    ;;
  restart)
    sudo systemctl restart "$UNIT"
    echo "ragnar restarted"
    ;;
  status)
    ACTIVE=$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)
    ENABLED=$(systemctl is-enabled "$UNIT" 2>/dev/null || echo unknown)
    LISTENING=$(is_listening)
    LISTENING=${LISTENING:-no}
    PID=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null)
    IP=$(primary_ip)
    echo "active     $ACTIVE"
    echo "enabled    $ENABLED"
    echo "listening  $LISTENING  (port $PORT)"
    [ -n "$PID" ] && [ "$PID" != "0" ] && echo "pid        $PID"
    if [ "$LISTENING" = "yes" ] && [ -n "$IP" ]; then
      echo "dashboard  http://$IP:$PORT"
    fi
    ;;
  url)
    IP=$(primary_ip)
    [ -n "$IP" ] && echo "http://$IP:$PORT" || echo ""
    ;;
  log|tail)
    sudo journalctl -u "$UNIT" -n 80 --no-pager
    ;;
  enable)
    sudo systemctl enable "$UNIT"
    echo "ragnar will auto-start on boot"
    ;;
  disable)
    sudo systemctl disable "$UNIT"
    echo "ragnar will NOT auto-start on boot"
    ;;
  *)
    echo "Usage: ragnar {start|stop|restart|status|log|url|enable|disable}"
    exit 1
    ;;
esac
