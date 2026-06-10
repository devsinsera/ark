#!/bin/bash
# usb-mount.sh — mount whatever USB is inserted (any label) + print its mountpoint.
# Run as root. Generic: the secondary nodes build off whatever USB is plugged in.
set -e
for dev in /dev/sda1 /dev/sd?1 /dev/sda; do
  [ -b "$dev" ] || continue
  mp=$(findmnt -n -o TARGET "$dev" 2>/dev/null)
  if [ -n "$mp" ]; then echo "$mp"; exit 0; fi
  lbl=$(lsblk -no LABEL "$dev" 2>/dev/null | tr ' ' '_'); mp="/media/${lbl:-usb}"
  mkdir -p "$mp"
  U=$(id -u peta 2>/dev/null || echo 1000); G=$(id -g peta 2>/dev/null || echo 1000)
  if mount -o "uid=$U,gid=$G,umask=0022" "$dev" "$mp" 2>/dev/null || mount "$dev" "$mp" 2>/dev/null; then
    echo "$mp"; exit 0
  fi
done
echo "NO_USB"; exit 1
