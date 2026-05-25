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
# When BASE_IMG and OUT_IMG resolve to the same inode (the caller has
# already prepared the working image — e.g. the sinsera-installer
# pipeline pre-expands then passes the same path for both), skip the
# copy and operate on it in place.
mkdir -p "$(dirname "$OUT_IMG")"
if [[ "$(readlink -f "$BASE_IMG")" == "$(readlink -f "$OUT_IMG")" ]]; then
  log "BASE_IMG == OUT_IMG — operating in place ($(stat --printf='%s' "$OUT_IMG") bytes)"
else
  log "copying base image (this may take a minute)…"
  cp --reflink=auto "$BASE_IMG" "$OUT_IMG"
  log "copied → $OUT_IMG ($(stat --printf='%s' "$OUT_IMG") bytes)"
fi

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
# Match host arch against the image rootfs's /bin/bash ELF header. For
# arm32 images on an arm64 host we need qemu-arm-static; for arm64
# images on x86 hosts we need qemu-aarch64-static. binfmt_misc on
# the kernel side ties everything together via /proc/sys/fs/binfmt_misc.
HOST_ARCH=$(uname -m)
# Read the ELF machine field from the image's /bin/bash (offset 18-19).
# 0x28 (40) = ARM (arm32), 0xB7 (183) = AArch64, 0x3E (62) = x86_64.
IMG_ELF_MACHINE=$(od -An -t u1 -N 1 -j 18 "$MNT_ROOT/bin/bash" 2>/dev/null | awk '{print $1}')
case "$IMG_ELF_MACHINE" in
  40)  IMG_ARCH=arm32 ;;
  183) IMG_ARCH=arm64 ;;
  62)  IMG_ARCH=x86_64 ;;
  *)   IMG_ARCH=unknown ;;
esac
log "host arch: $HOST_ARCH · image arch: $IMG_ARCH (elf machine $IMG_ELF_MACHINE)"

needs_qemu=""
case "$HOST_ARCH:$IMG_ARCH" in
  x86_64:arm64|i*86:arm64) needs_qemu=qemu-aarch64-static ;;
  x86_64:arm32|i*86:arm32) needs_qemu=qemu-arm-static ;;
  aarch64:arm32|arm64:arm32) needs_qemu=qemu-arm-static ;;
  aarch64:arm64|arm64:arm64) needs_qemu="" ;;
  *)                          needs_qemu="" ;;
esac

if [[ -n "$needs_qemu" ]]; then
  if [[ -x "/usr/bin/$needs_qemu" ]]; then
    log "cross-arch chroot — installing $needs_qemu into rootfs"
    cp "/usr/bin/$needs_qemu" "$MNT_ROOT/usr/bin/$needs_qemu"
  else
    echo "WARN: need $needs_qemu but /usr/bin/$needs_qemu not present in container" >&2
  fi
else
  log "no qemu emulation needed (host and image arch match)"
fi

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

# Sibling artefacts: anything next to install.plan.sh that looks like
# a tarball (.tar.gz / .tgz / .tar.xz) OR a Pi image (.img / .img.xz)
# gets copied into the rootfs at /opt/ark-extras/. The .img / .img.xz
# matching lets the sinsera-installer profile bundle other Sinsera
# images so the installer Pi can write them onto NVMe / USB drives
# without needing network access. Caller is responsible for
# pre-expanding the rootfs partition (see builder/lib/expand-rootfs.sh)
# if the extras don't fit.
PLAN_DIR="$(dirname "$PLAN_SH")"
EXTRAS_DIR="$MNT_ROOT/opt/ark-extras"
if [[ -d "$PLAN_DIR" ]]; then
  mkdir -p "$EXTRAS_DIR"
  shopt -s nullglob
  for extra in "$PLAN_DIR"/*.tar.gz "$PLAN_DIR"/*.tgz "$PLAN_DIR"/*.tar.xz \
               "$PLAN_DIR"/*.img    "$PLAN_DIR"/*.img.xz; do
    [[ -f "$extra" ]] || continue
    # Follow symlinks so the installer profile can symlink to the
    # canonical images sitting in their own builds/*/out/ trees.
    real=$(readlink -f "$extra")
    bn=$(basename "$extra")
    log "staging plan extra: $bn  ($(stat --printf='%s' "$real") bytes) -> /opt/ark-extras/$bn"
    cp "$real" "$EXTRAS_DIR/$bn"
  done
  shopt -u nullglob
fi

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
