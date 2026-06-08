#!/bin/bash
# habitat-mount.sh — find + mount the HABITAT USB to /media/habitat, print the
# app dir. Run as root (launcher calls via sudo). Robust to label/path.
set -e
MP=/media/habitat
mkdir -p "$MP"
if ! mountpoint -q "$MP"; then
  DEV=""
  for L in HABITAT Habitat habitat; do
    [ -e "/dev/disk/by-label/$L" ] && DEV=$(readlink -f "/dev/disk/by-label/$L") && break
  done
  if [ -z "$DEV" ]; then
    for d in /dev/sd?1; do [ -b "$d" ] && DEV="$d" && break; done
  fi
  [ -n "$DEV" ] || { echo "NO_USB"; exit 1; }
  U=$(id -u peta 2>/dev/null || echo 1000); G=$(id -g peta 2>/dev/null || echo 1000)
  mount -o "uid=$U,gid=$G,umask=0022" "$DEV" "$MP" 2>/dev/null || mount "$DEV" "$MP" || { echo "MOUNT_FAIL"; exit 1; }
fi
# app dir: a Habitat/ subfolder if present, else the drive root
if [ -d "$MP/Habitat" ]; then echo "$MP/Habitat"; else echo "$MP"; fi
