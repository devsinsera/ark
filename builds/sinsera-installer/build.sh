#!/bin/bash
# build.sh — wrap the chroot pipeline for the sinsera-installer profile.
#
# Steps:
#   1. Symlink the bundled .img.xz files from their canonical
#      builds/<name>/out/ paths into this profile dir so the chroot
#      extras step picks them up.
#   2. Bake the operator's SSH key into install.plan.sh
#   3. Copy the base DietPi image, pre-expand the rootfs partition.
#   4. Run chroot-run.sh on the expanded image.
#
# Run from the Ark repo root:
#   bash builds/sinsera-installer/build.sh

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PROFILE_DIR="$REPO_ROOT/builds/sinsera-installer"
BASE_IMG="$REPO_ROOT/Os/DietPi_RPi5-ARMv8-Trixie.img"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
EXPAND_MB=1100   # 1.1 GB headroom for ~840 MB of bundled images

cd "$REPO_ROOT"
[[ -f "$BASE_IMG" ]] || { echo "ERROR: base image not found at $BASE_IMG" >&2; exit 2; }

echo "[installer-build] step 1: symlink bundled images into profile dir"
# Use RELATIVE symlinks so the targets resolve both on the host (under
# $REPO_ROOT) and inside the docker container (under /work). Absolute
# /Users/... paths don't exist inside the container, which silently
# breaks the chroot-run.sh extras copy.
rm -f "$PROFILE_DIR"/*.img.xz
for img in builds/sinsera-vanilla/out/ark-built.img.xz \
           builds/sinsera-kiosk/out/ark-built.img.xz \
           builds/claude-cli-pi/out/ark-built.img.xz \
           builds/sinsera-raspyjack/out/ark-built.img.xz \
           builds/sinsera-flipper/out/ark-built.img.xz; do
  if [[ -f "$REPO_ROOT/$img" ]]; then
    name=$(basename "$(dirname "$(dirname "$img")")")
    # Relative target: ../<sibling>/out/ark-built.img.xz
    ln -sf "../$(echo "$img" | sed 's|^builds/||')" "$PROFILE_DIR/$name.img.xz"
    sz=$(du -h "$REPO_ROOT/$img" | awk '{print $1}')
    echo "  ✓ $name.img.xz  ($sz)"
  else
    echo "  ⚠ $img not found — skipping"
  fi
done

echo "[installer-build] step 2: bake SSH key into install.plan.sh"
SSH_PUBKEY=$(cat ~/.ssh/id_ed25519.pub 2>/dev/null) || { echo "ERROR: no ~/.ssh/id_ed25519.pub" >&2; exit 2; }
awk -v key="$SSH_PUBKEY" '{gsub(/__SSH_PUBKEY_PLACEHOLDER__/, key); print}' \
  "$PROFILE_DIR/install-template.sh" > "$PROFILE_DIR/install.plan.sh"
chmod +x "$PROFILE_DIR/install.plan.sh"

echo "[installer-build] step 3: copy + expand base image"
mkdir -p "$OUT_DIR"
# Plain cp — macOS cp doesn't support --reflink. APFS will do its own
# clone-on-write under the hood when source + dest are on the same volume.
cp "$BASE_IMG" "$OUT_IMG"
docker run --rm --privileged \
  -v "$REPO_ROOT:/work" \
  --entrypoint /bin/bash ark-builder:0.1 \
  /work/builder/lib/expand-rootfs.sh "/work/builds/sinsera-installer/out/ark-built.img" "$EXPAND_MB"

echo "[installer-build] step 4: run chroot-run on the expanded image"
# Use the on-disk chroot-run.sh (not the one baked into the container) so
# edits to builder/lib/chroot-run.sh take effect without a container rebuild.
# Specifically: this profile needs the BASE_IMG==OUT_IMG same-file skip
# that was added recently.
docker run --rm --privileged \
  -v "$REPO_ROOT:/work" \
  --entrypoint /bin/bash \
  ark-builder:0.1 \
  /work/builder/lib/chroot-run.sh \
  /work/builds/sinsera-installer/out/ark-built.img \
  /work/builds/sinsera-installer/install.plan.sh \
  /work/builds/sinsera-installer/out/ark-built.img

echo ""
echo "[installer-build] compressing → ark-built.img.xz"
rm -f "$OUT_DIR/ark-built.img.xz"
xz -k -T0 "$OUT_IMG"
echo ""
echo "[installer-build] done:"
ls -lh "$OUT_DIR"
echo ""
shasum -a 256 "$OUT_DIR/ark-built.img.xz" | awk '{print "  sha256:", $1}'
