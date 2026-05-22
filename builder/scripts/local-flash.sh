#!/usr/bin/env bash
# local-flash.sh — flash an Ark-built .img onto an SD card or USB drive
# attached DIRECTLY to this laptop (no Flash Node needed).
#
# macOS-tuned: uses `diskutil` for safe disk enumeration + unmount,
# then `dd` against /dev/rdiskN (raw device, ~3x faster than /dev/diskN).
# Linux-compatible: detects which OS we're on and switches commands.
#
# Hard safety: refuses to write to non-removable disks; refuses the
# system disk; requires explicit confirmation of the target.
#
# Usage:
#   bash builder/scripts/local-flash.sh <image.img>
#   bash builder/scripts/local-flash.sh builds/my-build/out/ark-built.img

set -euo pipefail

IMG="${1:-}"
if [[ -z "$IMG" || ! -f "$IMG" ]]; then
  echo "usage: $0 <image.img>" >&2
  echo "  e.g. $0 builds/phase3-validate/out/ark-built.img" >&2
  exit 2
fi

IMG_SIZE=$(stat -f%z "$IMG" 2>/dev/null || stat -c%s "$IMG")
IMG_SIZE_MB=$((IMG_SIZE / 1024 / 1024))

# xz-compressed image support — decompress on the fly via process
# substitution so we don't have to materialise the .img on disk.
DD_INPUT="$IMG"
DD_INPUT_DESC="$IMG ($IMG_SIZE_MB MB compressed)"
if [[ "$IMG" == *.xz ]]; then
  if ! command -v xz >/dev/null 2>&1; then
    echo "✖ xz not installed. brew install xz" >&2; exit 1
  fi
  echo "(input is .xz — will decompress in stream; uncompressed size unknown until write completes)"
fi

OS_KIND="$(uname -s)"

case "$OS_KIND" in
  Darwin)  flash_macos "$IMG" ;;
  Linux)   flash_linux "$IMG" ;;
  *)       echo "unsupported OS: $OS_KIND" >&2; exit 1 ;;
esac

# ─────────────────────────────────────────────────────────────────────
# macOS implementation
# ─────────────────────────────────────────────────────────────────────
flash_macos() {
  local img="$1"

  echo "=== Removable disks attached to this Mac ==="
  echo ""
  diskutil list external physical | awk '/^\/dev\// || /^[[:space:]]+#:/'
  echo ""
  echo "Image: $img ($IMG_SIZE_MB MB)"
  echo ""

  # Get just the candidate disk identifiers
  local candidates
  candidates=$(diskutil list external physical | awk '/^\/dev\/disk/ {print $1}')
  if [[ -z "$candidates" ]]; then
    echo "✖ No external removable disks attached." >&2
    echo "  Plug in your SD card / USB drive and re-run." >&2
    exit 1
  fi

  # Prompt for the target
  echo "Pick a target (just the diskN, NOT /dev/diskN):"
  echo -n "  > "
  read -r TARGET
  if [[ -z "$TARGET" ]]; then echo "aborted (empty input)"; exit 1; fi

  # Normalise — strip /dev/ if user pasted full path
  TARGET="${TARGET#/dev/}"
  TARGET="${TARGET#rdisk}"  # strip leading 'r' if pasted
  if [[ ! "$TARGET" =~ ^disk[0-9]+$ ]]; then
    echo "✖ Invalid target name: $TARGET (expected diskN)" >&2; exit 1
  fi
  local DEV="/dev/$TARGET"
  local RDEV="/dev/r$TARGET"

  # Safety: refuse the boot disk
  local BOOT_DISK
  BOOT_DISK=$(diskutil info / 2>/dev/null | awk -F': *' '/Part of Whole/ {print $2; exit}')
  BOOT_DISK="${BOOT_DISK:-disk0}"
  if [[ "$TARGET" == "$BOOT_DISK" ]]; then
    echo "✖ REFUSING: $DEV is your boot disk." >&2
    exit 1
  fi

  # Safety: confirm it's external + physical
  if ! diskutil info "$DEV" 2>/dev/null | grep -q 'Removable Media:.*Yes\|Device Location:.*External'; then
    echo "✖ REFUSING: $DEV does not look removable / external." >&2
    echo "  (use a USB SD reader or USB SSD; don't write to fixed internal storage)" >&2
    exit 1
  fi

  # Show what's about to die
  echo ""
  echo "=== TARGET ==="
  diskutil info "$DEV" | grep -E 'Device Identifier|Device Node|Media Name|Disk Size|Removable' | sed 's/^/  /'
  echo ""
  echo "This will COMPLETELY ERASE $DEV and replace with $img"
  echo -n "Type 'YES' to proceed: "
  read -r CONFIRM
  if [[ "$CONFIRM" != "YES" ]]; then echo "aborted"; exit 1; fi

  echo "→ unmounting $DEV"
  diskutil unmountDisk "$DEV"

  echo "→ writing (may take several minutes; no output until done unless you press Ctrl-T)"
  # Use raw device + 4M block size for speed. xz inputs stream-decompress.
  if [[ "$img" == *.xz ]]; then
    xz -dc "$img" | sudo dd of="$RDEV" bs=4m status=progress conv=fsync
  else
    sudo dd if="$img" of="$RDEV" bs=4m status=progress conv=fsync
  fi
  sync

  echo "→ ejecting $DEV"
  diskutil eject "$DEV"

  echo "✓ Done. Insert into the Pi and power on."
}

# ─────────────────────────────────────────────────────────────────────
# Linux implementation
# ─────────────────────────────────────────────────────────────────────
flash_linux() {
  local img="$1"
  echo "=== Removable disks attached to this Linux host ==="
  lsblk -dno NAME,SIZE,TYPE,RM,MODEL | awk '$3=="disk" && $4=="1"'
  echo ""

  echo -n "Pick a target (just the device name, e.g. sdb): "
  read -r TARGET
  if [[ -z "$TARGET" ]]; then echo "aborted (empty input)"; exit 1; fi
  TARGET="${TARGET#/dev/}"
  local DEV="/dev/$TARGET"

  # Safety
  local ROOT_DISK
  ROOT_DISK=$(findmnt -n -o SOURCE / | sed -E 's|p?[0-9]+$||; s|^/dev/||')
  if [[ "$TARGET" == "$ROOT_DISK" ]]; then
    echo "✖ REFUSING: $DEV is your root disk." >&2; exit 1
  fi
  local REMOVABLE
  REMOVABLE=$(cat "/sys/block/$TARGET/removable" 2>/dev/null || echo 0)
  if [[ "$REMOVABLE" != "1" ]]; then
    echo "✖ REFUSING: $DEV is not removable." >&2; exit 1
  fi

  echo ""
  echo "This will COMPLETELY ERASE $DEV and replace with $img"
  echo -n "Type 'YES' to proceed: "
  read -r CONFIRM
  if [[ "$CONFIRM" != "YES" ]]; then echo "aborted"; exit 1; fi

  # Unmount any partitions
  for p in /dev/${TARGET}*; do
    [[ -b "$p" && "$p" != "$DEV" ]] && sudo umount "$p" 2>/dev/null || true
  done

  echo "→ writing"
  if [[ "$img" == *.xz ]]; then
    if command -v bmaptool >/dev/null 2>&1; then
      sudo bmaptool copy --nobmap "$img" "$DEV"
    else
      xz -dc "$img" | sudo dd of="$DEV" bs=4M status=progress conv=fsync
    fi
  else
    if command -v bmaptool >/dev/null 2>&1; then
      sudo bmaptool copy --nobmap "$img" "$DEV"
    else
      sudo dd if="$img" of="$DEV" bs=4M status=progress conv=fsync
    fi
  fi
  sync
  echo "✓ Done. Eject and insert into the Pi."
}
