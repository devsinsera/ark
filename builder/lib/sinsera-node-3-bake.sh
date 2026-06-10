#!/bin/bash
# sinsera-node-3-bake.sh — Pi 5 8GB SD kiosk that shows ONLY the bridge camera wall
# (http://192.168.4.163:8091/wall) reached over WireGuard. Same Pi base as node-1
# (cage+cog, no cursor, Claude-on-USB), but no Supabase/camera-auth — just the wall + tunnel.
# Output → Dev-Sinsera/Builds/sinsera-node-3-pi5-8gb.img
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/sinsera-node-3"
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
[ -n "$WIFI_SSID" ] || echo "WARNING: no WiFi (~/.ark/wifi.env) — Node 3 will be unreachable on WiFi!"
ENV_PROD="/Users/petastockdale/Dev-Sinsera/Sinsera Core/.env.production"
ANON_KEY=""; [ -f "$ENV_PROD" ] && ANON_KEY=$(grep -E "^VITE_SUPABASE_ANON_KEY=" "$ENV_PROD" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
WG_CONF=""; [ -f "$HOME/.ark/node3-wg.conf" ] && WG_CONF=$(cat "$HOME/.ark/node3-wg.conf")
[ -n "$WG_CONF" ] || { echo "ERROR: ~/.ark/node3-wg.conf missing (the WireGuard client config)" >&2; exit 1; }

echo "[node3-bake] decompress base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[node3-bake] expand rootfs (+2600 MB)"
docker run --rm --privileged -v "$OUT_DIR:/baking" --entrypoint /bin/bash ark-builder:0.1 -c '
  set -e; IMG=/baking/ark-built.img
  SZ=$(stat -c%s "$IMG"); truncate -s $((SZ + 2600*1024*1024)) "$IMG"
  START=$(parted -s "$IMG" unit s print | awk "\$1==2{print \$2}" | tr -d s)
  parted -s "$IMG" rm 2; parted -s "$IMG" unit s mkpart primary ${START}s 100%
  LOOP=$(losetup -fP --show "$IMG"); P2=${LOOP}p2
  [ -e "$P2" ] || { kpartx -av "$LOOP"; P2=/dev/mapper/$(basename "$LOOP")p2; }
  e2fsck -fy "$P2" || true; resize2fs "$P2"; kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
'

echo "[node3-bake] chroot provisioning (hostname sinsera-node-3)…"
docker run --rm --privileged -v "$OUT_DIR:/baking" -v "$PROFILE_DIR:/profile:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" -e WIFI_SSID="$WIFI_SSID" -e WIFI_KEY="$WIFI_KEY" -e ANON_KEY="$ANON_KEY" \
  -e WG_CONF="$WG_CONF" \
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
  printf "%s\n" "$WG_CONF" > "$R/opt/sinsera-node/wg0.conf"; chmod 600 "$R/opt/sinsera-node/wg0.conf"
  cat > "$R/opt/sinsera-node/secrets.env" <<SEC
SSH_PUBKEY="${SSH_PUBKEY}"
WIFI_SSID="${WIFI_SSID}"
WIFI_KEY="${WIFI_KEY}"
ANON_KEY="${ANON_KEY}"
HOSTNAME_NEW="sinsera-node-3"
SEC
  chmod 600 "$R/opt/sinsera-node/secrets.env"
  echo "[bake] running install.sh in chroot…"
  chroot "$R" /bin/bash /opt/sinsera-node/install.sh
  rm -f "$R/opt/sinsera-node/secrets.env" "$R/opt/sinsera-node/wg0.conf" "$R/etc/resolv.conf"
  sync
  umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$R" 2>/dev/null || true
  kpartx -d "$LOOP" 2>/dev/null || true; losetup -d "$LOOP"
  echo "[node3-bake] provisioning complete"
'

echo "[node3-bake] deliver → $BUILDS/sinsera-node-3-pi5-8gb.img"
mkdir -p "$BUILDS"
mv -f "$OUT_IMG" "$BUILDS/sinsera-node-3-pi5-8gb.img"
echo ""; echo "[node3-bake] DONE:"
echo "  $BUILDS/sinsera-node-3-pi5-8gb.img"
echo "  → bridge wall http://192.168.4.163:8091/wall over WireGuard (10.7.0.3) · no cursor · ssh peta@sinsera-node-3.local"
