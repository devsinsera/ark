#!/bin/bash
# ragnar — start/stop/status the vendored Ragnar on this Pi.
#
# The RaspyJack tree ships a vendored copy of PierreGode/Ragnar at
# /opt/raspyjack/vendor/ragnar/. Normally you'd launch it from the
# LCD HAT (Payload → Utilities → Ragnar) which calls the same shim
# this script does. This wrapper lets you drive it via SSH from Ark
# without needing the LCD UI.
#
# Usage:
#   ragnar {start|stop|status|log|url}

set -e

RAGNAR_ROOT=/opt/raspyjack/vendor/ragnar
SHIM="$RAGNAR_ROOT/raspyjack_headless.py"
PID_FILE=/dev/shm/raspyjack_ragnar.pid
LOG_DIR=/opt/raspyjack/loot/Ragnar
LOG="$LOG_DIR/ragnar.log"
PORT="${RAGNAR_PORT:-8091}"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

primary_ip() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{print $4}' | cut -d/ -f1 | head -1
}

cmd="${1:-status}"
case "$cmd" in
  start)
    if is_running; then
      echo "ragnar already running (pid $(cat "$PID_FILE"))"
      exit 0
    fi
    if [ ! -f "$SHIM" ]; then
      echo "ERROR: $SHIM not found. Is RaspyJack installed?"
      exit 1
    fi
    # Run the whole launch as root via sudo bash so log redirection,
    # cwd, env vars, and the python subprocess all happen with the
    # right permissions. Previous version did `sudo python ... >> LOG`
    # which opened LOG as the calling user (Permission denied on a
    # root-owned /opt/raspyjack/loot tree).
    sudo bash -c "
      mkdir -p '$LOG_DIR'
      cd '$RAGNAR_ROOT'
      PYTHONPATH='$RAGNAR_ROOT' PYTHONUNBUFFERED=1 \
        nohup python3 '$SHIM' --port '$PORT' >> '$LOG' 2>&1 &
      echo \$! > '$PID_FILE'
    "
    sleep 2
    if is_running; then
      echo "ragnar started (pid $(cat "$PID_FILE"), port $PORT)"
      IP=$(primary_ip)
      [ -n "$IP" ] && echo "dashboard: http://$IP:$PORT"
    else
      echo "ragnar failed to start. Check log:"
      sudo tail -20 "$LOG" 2>/dev/null
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      PID=$(cat "$PID_FILE")
      sudo kill "$PID" 2>/dev/null || true
      sleep 1
      sudo kill -9 "$PID" 2>/dev/null || true
      sudo rm -f "$PID_FILE"
      echo "ragnar stopped (was pid $PID)"
    else
      echo "ragnar not running"
      sudo rm -f "$PID_FILE" 2>/dev/null || true
    fi
    ;;
  status)
    if is_running; then
      PID=$(cat "$PID_FILE")
      LISTENING=$(ss -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print "yes"; exit}')
      LISTENING=${LISTENING:-no}
      IP=$(primary_ip)
      echo "running    pid=$PID  listening=$LISTENING  port=$PORT"
      [ "$LISTENING" = "yes" ] && [ -n "$IP" ] && echo "dashboard  http://$IP:$PORT"
    else
      echo "not running"
    fi
    ;;
  url)
    IP=$(primary_ip)
    [ -n "$IP" ] && echo "http://$IP:$PORT" || echo ""
    ;;
  log|tail)
    if [ -f "$LOG" ]; then
      tail -50 "$LOG"
    else
      echo "(no log file yet at $LOG)"
    fi
    ;;
  *)
    echo "Usage: ragnar {start|stop|status|log|url}"
    exit 1
    ;;
esac
