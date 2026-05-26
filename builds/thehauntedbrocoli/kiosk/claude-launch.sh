#!/bin/bash
# Launcher wrapper for the ttyd-served Claude CLI.
#
# Prefers the project folder on the THUMB USB stick when it's plugged
# in (auto-mounted at /mnt/thumb by /etc/fstab). Falls back to the
# user's home dir if the USB isn't present.

USB_TARGET=/mnt/thumb/thehauntedbrocoli

if [ -d "$USB_TARGET" ]; then
  cd "$USB_TARGET"
elif [ -d /mnt/thumb ] && [ -n "$(ls -A /mnt/thumb 2>/dev/null)" ]; then
  # USB is mounted but doesn't have a thehauntedbrocoli/ folder — drop
  # into the mount point itself so the user can still see the disk.
  cd /mnt/thumb
else
  cd "$HOME"
fi

exec /usr/local/bin/claude "$@"
