#!/bin/bash
# chroot-run.sh — runs INSIDE the ark-builder Linux container.
#
# Takes a base .img file, copies it to an output path, mounts it,
# chroots in, and executes the install plan. The plan was emitted by
# the Ark Installer Engine; running it pre-installs every apt + pip
# dep so the Pi's first boot is near-instant.
#
# Arguments (positional):
#   $1 = path inside container to base .img        (e.g. /work/base.img)
#   $2 = path inside container to install plan .sh (e.g. /work/install.plan.sh)
#   $3 = path inside container to write output .img to (e.g. /work/out/ark.img)
#
# Environment knobs:
#   ARK_SKIP_INSTALL=1  — mount + bind only, don't run plan (debug)
#   ARK_KEEP_MOUNTED=1  — don't unmount/detach on exit (debug)
#
# Idempotent: every mount/losetup is cleaned up via the EXIT trap even
# on partial failure. Re-running with the same arguments is safe.

set -euo pipefail

BASE_IMG="${1:-}"
PLAN_SH="${2:-}"
OUT_IMG="${3:-}"

if [[ -z "$BASE_IMG" || -z "$PLAN_SH" || -z "$OUT_IMG" ]]; then
  echo "ERROR: chroot-run.sh <base.img> <install.plan.sh> <out.img>" >&2
  exit 2
fi
[[ -f "$BASE_IMG" ]] || { echo "ERROR: base image not found: $BASE_IMG" >&2; exit 2; }
[[ -f "$PLAN_SH" ]]  || { echo "ERROR: plan not found: $PLAN_SH" >&2; exit 2; }

MNT_BOOT="/mnt/ark-boot"
MNT_ROOT="/mnt/ark-root"
LOOP_DEV=""
KPARTX_USED=0
# Leave EXIT_CODE unset so the trap can fall back to $? (the actual
# last-command exit code). Initialising to 0 here causes the trap to
# happily exit 0 even when the script aborted via `exit 3`.
EXIT_CODE=""

log() { echo "[chroot-run] $*"; }

cleanup() {
  local ec=$?
  if [[ "${ARK_KEEP_MOUNTED:-0}" == "1" ]]; then
    log "ARK_KEEP_MOUNTED=1 — leaving mounts in place for inspection"
    return
  fi
  log "cleanup…"
  for m in \
      "$MNT_ROOT/dev/pts" \
      "$MNT_ROOT/dev"     \
      "$MNT_ROOT/proc"    \
      "$MNT_ROOT/sys"     \
      "$MNT_ROOT/boot/firmware" \
      "$MNT_ROOT/boot"    \
      "$MNT_ROOT"         \
      "$MNT_BOOT"         ; do
    mountpoint -q "$m" && umount "$m" 2>/dev/null || true
  done
  if [[ "$KPARTX_USED" == "1" && -n "$LOOP_DEV" ]]; then
    kpartx -d "$LOOP_DEV" 2>/dev/null || true
  fi
  if [[ -n "$LOOP_DEV" ]]; then
    losetup -d "$LOOP_DEV" 2>/dev/null || true
  fi
  exit "${EXIT_CODE:-$ec}"
}
trap cleanup EXIT

# ── 1) copy base → output (don't mutate the source) ──────────────────
log "copying base image (this may take a minute)…"
mkdir -p "$(dirname "$OUT_IMG")"
cp --reflink=auto "$BASE_IMG" "$OUT_IMG"
log "copied → $OUT_IMG ($(stat --printf='%s' "$OUT_IMG") bytes)"

# ── 2) losetup ──────────────────────────────────────────────────────
# In Colima / Docker on macOS, the host kernel doesn't always create
# /dev/loopXpN partition devices even with --partscan, because the
# partition-table scan needs udev which the container lacks. kpartx
# uses device-mapper to expose partitions as /dev/mapper/loopXpN,
# which works inside privileged containers without udev.
log "loop-attaching $OUT_IMG"
LOOP_DEV=$(losetup --find --show "$OUT_IMG")
LOOP_BASE=$(basename "$LOOP_DEV")
log "loop = $LOOP_DEV"

# Try partprobe first (cheap; works on metal); fall back to kpartx if
# the partition devices don't materialise.
partprobe "$LOOP_DEV" 2>/dev/null || true
sleep 0.5
BOOT_PART="${LOOP_DEV}p1"
ROOT_PART="${LOOP_DEV}p2"
if [[ ! -b "$BOOT_PART" || ! -b "$ROOT_PART" ]]; then
  log "loopXpN not visible — falling back to kpartx device-mapper"
  kpartx -av "$LOOP_DEV"
  KPARTX_USED=1
  sleep 0.5
  BOOT_PART="/dev/mapper/${LOOP_BASE}p1"
  ROOT_PART="/dev/mapper/${LOOP_BASE}p2"
fi

# Final diagnostic dump if we still can't see them
if [[ ! -b "$BOOT_PART" || ! -b "$ROOT_PART" ]]; then
  log "DIAGNOSTIC: partition devices still missing"
  ls -la /dev/loop* 2>&1 | head -10 || true
  ls -la /dev/mapper 2>&1 | head -10 || true
  losetup -l 2>&1 || true
  parted -s "$LOOP_DEV" print 2>&1 || true
  echo "ERROR: boot/root partitions not visible. Tried $BOOT_PART and $ROOT_PART." >&2
  exit 3
fi
log "partitions visible: $BOOT_PART · $ROOT_PART"

mkdir -p "$MNT_BOOT" "$MNT_ROOT"
log "mounting $ROOT_PART → $MNT_ROOT"
mount "$ROOT_PART" "$MNT_ROOT"
log "mounting $BOOT_PART → $MNT_BOOT"
mount "$BOOT_PART" "$MNT_BOOT"

# Pi OS bookworm+ expects /boot/firmware to be the firmware partition;
# DietPi mounts boot at /boot. Try both.
if [[ -d "$MNT_ROOT/boot/firmware" ]]; then
  log "binding boot partition → $MNT_ROOT/boot/firmware"
  mount --bind "$MNT_BOOT" "$MNT_ROOT/boot/firmware"
else
  # Backwards compat: also bind to /boot in case the chroot scripts
  # write to that path. We can't bind both, so pick /boot/firmware
  # when present; else use /boot via remount.
  if [[ -d "$MNT_ROOT/boot" && ! -d "$MNT_ROOT/boot/firmware" ]]; then
    log "binding boot partition → $MNT_ROOT/boot"
    mount --bind "$MNT_BOOT" "$MNT_ROOT/boot"
  fi
fi

# ── 4) bind-mount /dev, /proc, /sys so the chroot can use them ──────
log "bind-mounting /dev /proc /sys"
mount --bind /dev     "$MNT_ROOT/dev"
mount -t devpts none  "$MNT_ROOT/dev/pts" 2>/dev/null || mount --bind /dev/pts "$MNT_ROOT/dev/pts"
mount -t proc  none   "$MNT_ROOT/proc"
mount -t sysfs none   "$MNT_ROOT/sys"

# ── 5) handle cross-arch: copy qemu-static if host ≠ image arch ─────
# Apple Silicon hosts run arm64 containers natively, so this is a
# no-op there. x86 hosts emulating arm64 need the static binary inside
# the rootfs so the dynamic linker can find it.
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  x86_64|i*86)
    if [[ -x /usr/bin/qemu-aarch64-static ]]; then
      log "x86 host detected — installing qemu-aarch64-static into rootfs"
      cp /usr/bin/qemu-aarch64-static "$MNT_ROOT/usr/bin/qemu-aarch64-static"
    else
      echo "WARN: x86 host but /usr/bin/qemu-aarch64-static not present in container" >&2
    fi
    ;;
  aarch64|arm64)
    log "arm64 host — no qemu emulation needed"
    ;;
esac

# ── 6) DNS for apt inside the chroot ─────────────────────────────────
if [[ -L "$MNT_ROOT/etc/resolv.conf" ]]; then
  rm -f "$MNT_ROOT/etc/resolv.conf"
fi
cp /etc/resolv.conf "$MNT_ROOT/etc/resolv.conf"

# ── 7) copy install plan into the chroot ────────────────────────────
log "staging install plan inside chroot"
mkdir -p "$MNT_ROOT/ark"
cp "$PLAN_SH" "$MNT_ROOT/ark/install.plan.sh"
chmod +x "$MNT_ROOT/ark/install.plan.sh"

# ── 8) chroot + run the plan ────────────────────────────────────────
if [[ "${ARK_SKIP_INSTALL:-0}" == "1" ]]; then
  log "ARK_SKIP_INSTALL=1 — skipping plan execution (debug)"
else
  log "chroot → /ark/install.plan.sh"
  # set +e so we can capture the chroot's exit code without aborting
  # the cleanup trap below.
  set +e
  chroot "$MNT_ROOT" /bin/bash -lc "/ark/install.plan.sh"
  EXIT_CODE=$?
  set -e
  if [[ $EXIT_CODE -ne 0 ]]; then
    log "WARN: install plan exited with code $EXIT_CODE"
  else
    log "install plan succeeded"
  fi
fi

# ── 9) optional sanitisation — wipe transient state ─────────────────
log "sanitising rootfs (logs, machine-id, apt cache)…"
chroot "$MNT_ROOT" /bin/bash -lc '
  apt-get clean 2>/dev/null || true
  rm -rf /var/lib/apt/lists/*
  rm -rf /var/log/* /tmp/* /var/tmp/*
  rm -f  /etc/machine-id
  touch  /etc/machine-id
  rm -f  /root/.bash_history
  history -c 2>/dev/null || true
' || true

log "done — output: $OUT_IMG"
EXIT_CODE=${EXIT_CODE:-0}
