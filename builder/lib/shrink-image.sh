#!/bin/bash
# shrink-image.sh — runs INSIDE the ark-builder container.
# Shrinks the rootfs partition to minimum + truncates the .img.
#
# Phase 3.3 of the image builder. Saves typically 3-5 GB on stock
# DietPi images (default partition table assumes a 16 GB SD; the
# actual installed content is < 1 GB).
#
# Idempotent: if the image is already minimised, resize2fs -M is a
# near-no-op.
set -euo pipefail

IMG="$1"
[[ -f "$IMG" ]] || { echo "ERROR: image not found: $IMG" >&2; exit 1; }

LOOP=""
ROOT_PART=""
cleanup() {
  if [[ -n "$ROOT_PART" ]]; then
    mountpoint -q /mnt/shrink-root && umount /mnt/shrink-root 2>/dev/null || true
  fi
  if [[ -n "$LOOP" ]]; then
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[shrink] attaching $IMG"
LOOP=$(losetup --find --show "$IMG")
LB=$(basename "$LOOP")
partprobe "$LOOP" 2>/dev/null || true
sleep 0.5

# kpartx for partition mapping (matches chroot-run.sh approach)
kpartx -av "$LOOP" >/dev/null
sleep 0.5
ROOT_PART="/dev/mapper/${LB}p2"
[[ -b "$ROOT_PART" ]] || { echo "ERROR: root partition not visible at $ROOT_PART" >&2; exit 1; }

echo "[shrink] fsck ext4"
e2fsck -fy "$ROOT_PART" || true

echo "[shrink] resize2fs -M (shrink to minimum)"
resize2fs -M "$ROOT_PART"

# Find the new size in blocks
NEW_BLOCKS=$(tune2fs -l "$ROOT_PART" | awk '/^Block count:/ {print $3}')
BLOCK_SIZE=$(tune2fs -l "$ROOT_PART" | awk '/^Block size:/ {print $3}')
NEW_SIZE_B=$((NEW_BLOCKS * BLOCK_SIZE))
echo "[shrink] new rootfs size: $NEW_BLOCKS blocks × $BLOCK_SIZE bytes = $NEW_SIZE_B bytes"

# Drop the device-mapper entry so we can resize the underlying partition
kpartx -d "$LOOP" >/dev/null
ROOT_PART=""

# Find where p2 starts (in 512-byte sectors)
P2_START_SECTORS=$(parted -ms "$LOOP" unit s print | awk -F: '$1=="2" {gsub(/s$/,"",$2); print $2}')
[[ -n "$P2_START_SECTORS" ]] || { echo "ERROR: couldn't read p2 start sector" >&2; exit 1; }

# New end sector = start + (size in sectors) - 1
# Add a small slack (16 MB) so the filesystem isn't completely flush
SLACK_MB=16
NEW_SIZE_WITH_SLACK_B=$((NEW_SIZE_B + SLACK_MB * 1024 * 1024))
NEW_SIZE_SECTORS=$((NEW_SIZE_WITH_SLACK_B / 512))
NEW_END_SECTORS=$((P2_START_SECTORS + NEW_SIZE_SECTORS - 1))

echo "[shrink] resizing partition table: p2 ${P2_START_SECTORS}s → ${NEW_END_SECTORS}s"
parted -s "$LOOP" resizepart 2 ${NEW_END_SECTORS}s

# Detach + truncate the .img
losetup -d "$LOOP"
LOOP=""

# Truncate the file to the new partition end (round up to MB boundary)
TRUNCATE_B=$(( (NEW_END_SECTORS + 1) * 512 ))
TRUNCATE_MB=$(( (TRUNCATE_B + 1024 * 1024 - 1) / (1024 * 1024) ))

OLD_SIZE_MB=$(( $(stat --printf='%s' "$IMG") / 1024 / 1024 ))
echo "[shrink] truncating $IMG: ${OLD_SIZE_MB} MB → ${TRUNCATE_MB} MB"
truncate -s ${TRUNCATE_MB}M "$IMG"

echo "[shrink] done"
