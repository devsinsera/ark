#!/bin/bash
# habitat-launch.sh — open Claude Code in the HABITAT USB app folder with
# permissions skipped, to continue building the Habitat app. Used by the tty2
# console, the tmux background session, and ttyd. First run: sign in once with
# `claude login` (auth is per-user, persists), then it picks up the Habitat work.
APPDIR=$(sudo /usr/local/bin/habitat-mount.sh 2>/dev/null)
case "$APPDIR" in
  ""|NO_USB|MOUNT_FAIL)
    echo "⚠  HABITAT USB not found. Insert the Habitat drive, then run: /usr/local/bin/habitat-launch.sh"
    APPDIR="$HOME" ;;
esac
cd "$APPDIR" || cd "$HOME"
clear
echo "──────────────────────────────────────────────"
echo "  Claude Code · HABITAT"
echo "  dir: $APPDIR"
ls -1 Habitat* *.md 2>/dev/null | sed 's/^/  spec: /' | sort -u
echo "  (--dangerously-skip-permissions)"
echo "  First time? run:  claude login   (then: continue the Habitat app)"
echo "──────────────────────────────────────────────"
while true; do
  claude --dangerously-skip-permissions
  echo ""
  echo "[habitat] claude exited — Enter to relaunch, Ctrl-C for a shell."
  read -r _ || exec bash
done
