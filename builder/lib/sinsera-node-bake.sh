#!/bin/bash
# sinsera-node-bake.sh — Pi 5 8GB kiosk image, boot from the NVMe SSD on the HAT.
# Bakes node-1 (full native-arm64 chroot), then clones to node-2 with hostname +
# a VISIBLE cursor (node-2 = K400 trackpad; node-1 = touchscreen, no cursor).
#   Node 1 — bedroom 18.5" touchscreen · Wi-Fi (onboard; TP-Link AX1800 USB = follow-up)
#   Node 2 — lounge 75" Bravia · LAN · Logitech K400 · 2TB SSD (adapter-powered for now)
# Flash each .img to that node's NVMe SSD (not SD). Output → Dev-Sinsera/Builds/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/sinsera-node"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
BUILDS="/Users/petastockdale/Dev-Sinsera/Builds"

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
# Camera-account creds for the zero-touch Vigil-wall auto-auth (pulled from the live node)
VIGIL_EMAIL=""; VIGIL_PASSWORD=""; SUPABASE_URL=""
if [ -f "$HOME/.ark/vigil.env" ]; then set -a; source "$HOME/.ark/vigil.env"; set +a; fi
[ -n "$VIGIL_EMAIL" ] || echo "WARNING: no camera creds (~/.ark/vigil.env) — the wall won't auto-auth!"

echo "[node-bake] decompress base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[node-bake] expand rootfs (+2600 MB for cage/cog/node/claude)"
docker run --rm --privileged -v "$OUT_DIR:/baking" --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/baking/ark-built.img
  SZ=$(stat -c%s "$IMG"); truncate -s $((SZ + 2600*1024*1024)) "$IMG"
  START=$(parted -s "$IMG" unit s print | awk "\$1==2{print \$2}" | tr -d s)
  parted -s "$IMG" rm 2; parted -s "$IMG" unit s mkpart primary ${START}s 100%
  LOOP=$(losetup -fP --show "$IMG"); P2=${LOOP}p2
  [ -e "$P2" ] || { kpartx -av "$LOOP"; P2=/dev/mapper/$(basename "$LOOP")p2; }
  e2fsck -fy "$P2" || true; resize2fs "$P2"; kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
'

echo "[node-bake] chroot provisioning (hostname sinsera-node-1)…"
docker run --rm --privileged -v "$OUT_DIR:/baking" -v "$PROFILE_DIR:/profile:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" -e WIFI_SSID="$WIFI_SSID" -e WIFI_KEY="$WIFI_KEY" -e ANON_KEY="$ANON_KEY" \
  -e VIGIL_EMAIL="$VIGIL_EMAIL" -e VIGIL_PASSWORD="$VIGIL_PASSWORD" -e SUPABASE_URL="$SUPABASE_URL" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/baking/ark-built.img
  LOOP=$(losetup -fP --show "$IMG"); P1=${LOOP}p1; P2=${LOOP}p2
  if [ ! -e "$P1" ]; then kpartx -av "$LOOP"; LN=$(basename "$LOOP"); P1=/dev/mapper/${LN}p1; P2=/dev/mapper/${LN}p2; fi
  R=/mnt/root; mkdir -p "$R"; mount "$P2" "$R"; mkdir -p "$R/boot/firmware"; mount "$P1" "$R/boot/firmware"
  mount --bind /dev "$R/dev"; mount -t devpts none "$R/dev/pts" 2>/dev/null || mount --bind /dev/pts "$R/dev/pts"
  mount -t proc none "$R/proc"; mount -t sysfs none "$R/sys"; cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true
  mkdir -p "$R/opt/sinsera-node"
  cp /profile/install.sh "$R/opt/sinsera-node/install.sh"; chmod 755 "$R/opt/sinsera-node/install.sh"
  cp -r /profile/app "$R/opt/sinsera-node/app"
  cat > "$R/opt/sinsera-node/secrets.env" <<SEC
SSH_PUBKEY="${SSH_PUBKEY}"
WIFI_SSID="${WIFI_SSID}"
WIFI_KEY="${WIFI_KEY}"
ANON_KEY="${ANON_KEY}"
VIGIL_EMAIL="${VIGIL_EMAIL}"
VIGIL_PASSWORD="${VIGIL_PASSWORD}"
SUPABASE_URL="${SUPABASE_URL}"
HOSTNAME_NEW="sinsera-node-1"
SEC
  chmod 600 "$R/opt/sinsera-node/secrets.env"
  echo "[bake] running install.sh in chroot…"
  chroot "$R" /bin/bash /opt/sinsera-node/install.sh
  # belt-and-braces: the in-chroot write of this has been unreliable → ensure the no-arrow cursor
  mkdir -p "$R/usr/share/icons/default"
  printf "[Icon Theme]\nName=Default\nInherits=blank\n" > "$R/usr/share/icons/default/index.theme"
  rm -f "$R/opt/sinsera-node/secrets.env" "$R/etc/resolv.conf"
  sync
  umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$R" 2>/dev/null || true
  kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
  echo "[node-bake] provisioning complete"
'

echo "[node-bake] deliver node-1 + clone → node-2 (hostname rewrite)"
mkdir -p "$BUILDS"
# only our two outputs — NOT a broad sinsera-node-*.img glob (that would nuke node-3's image)
rm -f "$BUILDS/sinsera-node-1-"*.img "$BUILDS/sinsera-node-2-"*.img 2>/dev/null || true
cp "$OUT_IMG" "$BUILDS/sinsera-node-1-pi5-8gb.img"
mv -f "$OUT_IMG" "$BUILDS/sinsera-node-2-pi5-8gb.img"
docker run --rm --privileged -v "$BUILDS:/b" --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/b/sinsera-node-2-pi5-8gb.img
  LOOP=$(losetup -fP --show "$IMG"); P2=${LOOP}p2
  [ -e "$P2" ] || { kpartx -av "$LOOP"; P2=/dev/mapper/$(basename "$LOOP")p2; }
  R=/m; mkdir -p $R; mount "$P2" $R
  sed -i "s/sinsera-node-1/sinsera-node-2/g" $R/etc/hostname $R/etc/hosts $R/etc/motd \
    $R/etc/systemd/system/agent-status-reporter.service 2>/dev/null || true
  # Node 2 = lounge 75" Bravia driven by a Logitech K400 trackpad (NOT touch) → VISIBLE cursor.
  # XCURSOR_THEME (read by the launcher) is the mechanism cage/cog actually honours; index.theme
  # alone proved unreliable. Node 1 keeps the blank (hidden) cursor.
  printf "XCURSOR_THEME=DMZ-White\n" > $R/opt/sinsera-node/cursor.env
  sync; umount $R 2>/dev/null; kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
  echo "[node-bake] node-2 → hostname sinsera-node-2 + visible cursor (K400)"
'
echo ""; echo "[node-bake] DONE:"
echo "  $BUILDS/sinsera-node-1-pi5-8gb.img   (bedroom touchscreen · Wi-Fi · no cursor)"
echo "  $BUILDS/sinsera-node-2-pi5-8gb.img   (lounge 75\" · LAN · K400 · visible cursor)"
echo "  → FLASH EACH .img TO ITS NVMe SSD (not SD). First boot sets BOOT_ORDER to prefer NVMe."
echo "  → sinsera.co/?kiosk=1&node=<host> · view per node via the Kiosks module · ssh peta@sinsera-node-{1,2}.local"
