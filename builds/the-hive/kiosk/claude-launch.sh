#!/bin/bash
# Launcher wrapper for the ttyd-served Claude CLI.
#
# Prefers The Comb folder on the STICK USB when it's plugged in
# (auto-mounted at /mnt/stick by /etc/fstab). Falls back to the user's
# home dir if the USB isn't present.

USB_TARGET=/mnt/stick/the-comb

if [ -d "$USB_TARGET" ]; then
  cd "$USB_TARGET"
elif [ -d /mnt/stick ] && [ -n "$(ls -A /mnt/stick 2>/dev/null)" ]; then
  # USB is mounted but doesn't have a the-comb/ folder — drop into the
  # mount point itself so the user can still see the disk.
  cd /mnt/stick
else
  cd "$HOME"
fi

exec /usr/local/bin/claude "$@"
