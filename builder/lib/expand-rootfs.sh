#!/bin/bash
# expand-rootfs.sh — grow the rootfs (partition 2) of a .img file.
#
# Used by the sinsera-installer build pipeline: the default DietPi
# rootfs is ~950 MB which can't fit the ~840 MB of bundled Sinsera
# images. We pre-expand BEFORE running chroot-run.sh so the extras
# copy step has somewhere to write.
#
# Runs INSIDE the ark-builder Linux container (needs losetup, parted,
# resize2fs, kpartx — all already in the Dockerfile).
#
# Arguments:
#   $1 = path to .img file (will be modified in place)
#   $2 = MB to add to the file (positive integer). The rootfs
#        partition is grown to fill the new total size.
#
# Idempotent if you re-run with the same args you get a slightly
# bigger file each time — don't.

set -euo pipefail

IMG="${1:-}"
ADD_MB="${2:-}"

if [[ -z "$IMG" || -z "$ADD_MB" ]]; then
  echo "ERROR: expand-rootfs.sh <img> <mb-to-add>" >&2
  exit 2
fi
[[ -f "$IMG" ]] || { echo "ERROR: image not found: $IMG" >&2; exit 2; }
[[ "$ADD_MB" =~ ^[0-9]+$ ]] || { echo "ERROR: mb must be a positive integer" >&2; exit 2; }

log() { echo "[expand-rootfs] $*"; }
LOOP=""
KPARTX_USED=0
cleanup() {
  local ec=$?
  if [[ "$KPARTX_USED" == "1" && -n "$LOOP" ]]; then
    kpartx -d "$LOOP" 2>/dev/null || true
  fi
  if [[ -n "$LOOP" ]]; then
    losetup -d "$LOOP" 2>/dev/null || true
  fi
  exit "$ec"
}
trap cleanup EXIT

OLD_BYTES=$(stat --printf='%s' "$IMG")
ADD_BYTES=$((ADD_MB * 1024 * 1024))
NEW_BYTES=$((OLD_BYTES + ADD_BYTES))
log "expanding $IMG: $OLD_BYTES → $NEW_BYTES bytes (+${ADD_MB} MB)"
truncate --size=$NEW_BYTES "$IMG"

LOOP=$(losetup --find --show "$IMG")
LOOP_BASE=$(basename "$LOOP")
log "loop = $LOOP"

# Use parted to grow partition 2 to the end. The script form auto-
# answers any "Fix the GPT" prompts (a backup GPT lives at the OLD
# end of the disk; parted offers to relocate it).
log "growing partition 2 to fill"
parted -s "$LOOP" --fix resizepart 2 100% || {
  # parted 3.5+ on Trixie sometimes needs an explicit unit-aware call.
  END=$(parted -s "$LOOP" unit s print | awk '/^Disk/ {gsub(/s$/,"",$3); print $3-1; exit}')
  parted -s "$LOOP" --fix resizepart 2 ${END}s
}
partprobe "$LOOP" 2>/dev/null || true
sleep 0.3

# Get the rootfs partition device (loop0p2 or /dev/mapper/loop0p2).
ROOT_PART="${LOOP}p2"
if [[ ! -b "$ROOT_PART" ]]; then
  log "loopXpN not visible — falling back to kpartx"
  kpartx -av "$LOOP" >/dev/null
  KPARTX_USED=1
  sleep 0.3
  ROOT_PART="/dev/mapper/${LOOP_BASE}p2"
fi
[[ -b "$ROOT_PART" ]] || { echo "ERROR: rootfs partition device not visible" >&2; exit 3; }

# Filesystem check (required before resize2fs)
log "e2fsck on $ROOT_PART"
e2fsck -fy "$ROOT_PART" || true   # -y answers yes to all fixes; ignore non-zero (it returns 1 for "errors corrected")

log "resize2fs $ROOT_PART"
resize2fs "$ROOT_PART"

log "done — rootfs grown by ${ADD_MB} MB"
