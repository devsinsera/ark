#!/bin/bash
# habitat-kiosk-bake.sh — fully self-contained Pi 5 image: same boot as the
# Sinsera Pi (chromium → sinsera.co on the display) + Claude Code auto-running on
# the HABITAT USB (tty2 + ttyd) + Build Agent feed. All session learnings baked
# in (wizard-mask, WiFi rfkill, display auto-detect, screensaver, fan, SSH, etc.).
# Native-arm64 chroot (Apple Silicon) runs apt/npm at native speed. SD boot, WiFi.
#
# Provisioning lives in builds/habitat-kiosk/install.sh (run in the chroot) — this
# just stages files + secrets and orchestrates. Output → Dev-Sinsera/Builds/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/habitat-kiosk"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
BUILDS_DELIVER_DIR="/Users/petastockdale/Dev-Sinsera/Builds"
DELIVER_NAME="habitat-kiosk-$(date +%Y-%m-%d).img.xz"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
[ -f "$PROFILE_DIR/install.sh" ] || { echo "ERROR: missing install.sh" >&2; exit 1; }
mkdir -p "$OUT_DIR"; rm -rf "$PROFILE_DIR/app/__pycache__"

SSH_PUBKEY=""; [ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/id_ed25519.pub missing" >&2; exit 1; }
WIFI_SSID=""; WIFI_KEY=""
if [ -f "$HOME/.ark/wifi.env" ]; then set -a; source "$HOME/.ark/wifi.env"; set +a; : "${WIFI_SSID:=}"; : "${WIFI_KEY:=}"; fi
[ -n "$WIFI_SSID" ] || echo "WARNING: no WiFi (~/.ark/wifi.env) — Pi will be unreachable on WiFi!"
ENV_PROD="/Users/petastockdale/Dev-Sinsera/Sinsera Core/.env.production"
ANON_KEY=""; [ -f "$ENV_PROD" ] && ANON_KEY=$(grep -E "^VITE_SUPABASE_ANON_KEY=" "$ENV_PROD" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')

echo "[habitat-bake] decompress base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[habitat-bake] expand rootfs (+2600 MB for chromium + node + claude)"
docker run --rm --privileged -v "$OUT_DIR:/baking" --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/baking/ark-built.img
  SZ=$(stat -c%s "$IMG"); truncate -s $((SZ + 2600*1024*1024)) "$IMG"
  START=$(parted -s "$IMG" unit s print | awk "\$1==2{print \$2}" | tr -d s)
  parted -s "$IMG" rm 2; parted -s "$IMG" unit s mkpart primary ${START}s 100%
  LOOP=$(losetup -fP --show "$IMG"); P2=${LOOP}p2
  [ -e "$P2" ] || { kpartx -av "$LOOP"; P2=/dev/mapper/$(basename "$LOOP")p2; }
  e2fsck -fy "$P2" || true; resize2fs "$P2"; kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
'

echo "[habitat-bake] chroot provisioning (apt + node + claude + users + services)…"
docker run --rm --privileged -v "$OUT_DIR:/baking" -v "$PROFILE_DIR:/profile:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" -e WIFI_SSID="$WIFI_SSID" -e WIFI_KEY="$WIFI_KEY" -e ANON_KEY="$ANON_KEY" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/baking/ark-built.img
  LOOP=$(losetup -fP --show "$IMG"); P1=${LOOP}p1; P2=${LOOP}p2
  if [ ! -e "$P1" ]; then kpartx -av "$LOOP"; LN=$(basename "$LOOP"); P1=/dev/mapper/${LN}p1; P2=/dev/mapper/${LN}p2; fi
  R=/mnt/root; mkdir -p "$R"; mount "$P2" "$R"; mkdir -p "$R/boot/firmware"; mount "$P1" "$R/boot/firmware"
  mount --bind /dev "$R/dev"; mount -t devpts none "$R/dev/pts" 2>/dev/null || mount --bind /dev/pts "$R/dev/pts"
  mount -t proc none "$R/proc"; mount -t sysfs none "$R/sys"; cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true

  mkdir -p "$R/opt/habitat-kiosk"
  cp /profile/install.sh "$R/opt/habitat-kiosk/install.sh"; chmod 755 "$R/opt/habitat-kiosk/install.sh"
  cp -r /profile/app "$R/opt/habitat-kiosk/app"
  cat > "$R/opt/habitat-kiosk/secrets.env" <<SEC
SSH_PUBKEY="${SSH_PUBKEY}"
WIFI_SSID="${WIFI_SSID}"
WIFI_KEY="${WIFI_KEY}"
ANON_KEY="${ANON_KEY}"
SEC
  chmod 600 "$R/opt/habitat-kiosk/secrets.env"

  echo "[bake] running install.sh in chroot…"
  chroot "$R" /bin/bash /opt/habitat-kiosk/install.sh
  rm -f "$R/opt/habitat-kiosk/secrets.env" "$R/etc/resolv.conf"

  sync
  umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$R" 2>/dev/null || true
  kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
  echo "[habitat-bake] provisioning complete"
'

echo "[habitat-bake] compress → .img.xz"
rm -f "$OUT_DIR/ark-built.img.xz"; xz -T 0 "$OUT_IMG"
mkdir -p "$BUILDS_DELIVER_DIR"
rm -f "$BUILDS_DELIVER_DIR/habitat-kiosk-"*.img 2>/dev/null || true
mv -f "$OUT_DIR/ark-built.img.xz" "$BUILDS_DELIVER_DIR/$DELIVER_NAME"
SZ=$(du -h "$BUILDS_DELIVER_DIR/$DELIVER_NAME" | awk '{print $1}')
echo ""; echo "[habitat-bake] DONE — $BUILDS_DELIVER_DIR/$DELIVER_NAME ($SZ)"
echo "  ssh: peta@habitat-kiosk.local · wifi: ${WIFI_SSID:-MISSING} · anon: $([ -n "$ANON_KEY" ] && echo present || echo MISSING)"
