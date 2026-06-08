#!/bin/bash
# usb-claude-launch.sh — open Claude Code on whatever USB is inserted and build
# whatever .md spec is on it, auto-resuming on every relaunch. First run: sign in
# once with `claude login` (auth persists). Used by the tmux `claude` session + ttyd.
MP=$(sudo /usr/local/bin/usb-mount.sh 2>/dev/null)
case "$MP" in
  ""|NO_USB|MOUNT_FAIL)
    echo "⚠  No USB found. Insert a USB with a .md spec, then run: /usr/local/bin/usb-claude-launch.sh"
    MP="$HOME" ;;
esac
# app dir = a subfolder that contains a markdown spec, else the drive root
APPDIR="$MP"
for d in "$MP"/*/; do
  [ -d "$d" ] || continue
  if [ -f "${d}README.md" ] || ls "${d}"*.md >/dev/null 2>&1; then APPDIR="$d"; break; fi
done
cd "$APPDIR" 2>/dev/null || cd "$HOME"
clear
echo "──────────────────────────────────────────────"
echo "  Claude Code · USB build"
echo "  dir: $APPDIR"
ls -1 *.md 2>/dev/null | sed 's/^/  spec: /'
echo "  First time? run:  claude login"
echo "──────────────────────────────────────────────"
TASK="This folder is the USB drive inserted in this Pi. Read the spec markdown here (README.md, or any *.md you find) and build / continue exactly what it describes — work autonomously until it is functional, note decisions in the README, and do not stop at the welcome screen."
while true; do
  claude --dangerously-skip-permissions "$TASK"
  echo ""
  echo "[claude exited — relaunching in 3s, Ctrl-C for a shell]"
  read -t 3 -r _ && exec bash
done
