#!/bin/bash
# node5-bake-native.sh — NATIVE arm64 adaptation of node5-bake.sh for the Core
# build host (aarch64 Debian trixie). The original script wraps its two privileged
# phases in `docker run --privileged ark-builder:0.1`; that image is absent on Core,
# so here those two blocks run INLINE on the host (Core is native arm64, has
# losetup/parted/chroot/e2fsck/resize2fs/kpartx). Run as root:
#   cd /home/peta/ark-build && sudo bash builder/lib/node5-bake-native.sh
# Creds are staged under $REPO_ROOT/creds (fleet.pub + env.production) so the bake
# does not depend on $HOME. Output stays at builds/node5/out/ark-built.img (the Mac
# deliver path is skipped on Core; operator scp's the image back).
set -euo pipefail
export PATH="/usr/sbin:/sbin:/usr/bin:/bin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/node5"
APP_DIR="$PROFILE_DIR/app"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
[ -f "$PROFILE_DIR/install.sh" ] || { echo "ERROR: missing $PROFILE_DIR/install.sh" >&2; exit 1; }
for f in bridge.py obd_pids.py requirements.txt .env.template hud-server.py \
         store-forward.sh idle-shutdown.sh tailscale-firstboot.sh \
         node-status-reporter.sh node-command-runner.sh \
         ap-sinsera-gr86.nmconnection uplink-home-wifi.nmconnection \
         uplink-iphone-hotspot.nmconnection uplink-car-wifi.nmconnection \
         garage-obd-bridge.service node-status-reporter.service \
         node-command-runner.service gr86-hud.service \
         gr86-store-forward.service gr86-store-forward.timer \
         gr86-idle-shutdown.service gr86-idle-shutdown.timer \
         gr86-tailscale-install.service; do
  [ -f "$APP_DIR/$f" ] || { echo "ERROR: missing $APP_DIR/$f" >&2; exit 1; }
done
mkdir -p "$OUT_DIR"
rm -rf "$APP_DIR/__pycache__"

# ── Operator creds (staged; no $HOME dependency) ──
SSH_PUBKEY=""
[ -f "$REPO_ROOT/creds/fleet.pub" ] && SSH_PUBKEY=$(cat "$REPO_ROOT/creds/fleet.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: no fleet key ($REPO_ROOT/creds/fleet.pub)" >&2; exit 1; }

# ── Supabase anon key (public) ──
ENV_PROD="$REPO_ROOT/creds/env.production"
ANON_KEY=""
if [ -f "$ENV_PROD" ]; then
  ANON_KEY=$(grep -E "^VITE_SUPABASE_ANON_KEY=" "$ENV_PROD" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
fi
[ -n "$ANON_KEY" ] || echo "WARNING: anon key not found — bridge/reporters .env will need it filled over SSH."

# ── Camera-account creds for the fleet reporters (optional; blank = fill over SSH) ──
VIGIL_EMAIL="peta.stockdale@outlook.com"; VIGIL_PASSWORD=""; SUPABASE_URL="https://lkhtgkmivqwgnvzmjbhr.supabase.co"
[ -n "$VIGIL_PASSWORD" ] || echo "WARNING: no camera password — node5 won't report to node_status until filled over SSH."

# ── WiFi/AP/OBD — placeholders (recipe default; user fills post-boot) ──
AP_SSID="Sinsera-GR86"; AP_PSK="CHANGE-ME-AP-PASSPHRASE"
HOME_SSID=""; HOME_PSK=""; IPHONE_SSID=""; IPHONE_PSK=""
OBDLINK_MAC=""; CAR_ID=""; WIFI_COUNTRY="AU"; OWNER_ID="82e75fd1-7878-45f5-9760-ba0af6838a3d"

echo "[node5-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1 (native): expand image + grow rootfs (+1600 MB)
# ─────────────────────────────────────────────────────────────────────────────
echo "[node5-bake] expanding image + rootfs (+1600 MB for venv/bleak/NM/firmware)"
IMG="$OUT_IMG"
SZ=$(stat -c%s "$IMG")
truncate -s $((SZ + 1600*1024*1024)) "$IMG"
START=$(parted -s "$IMG" unit s print | awk '$1==2{print $2}' | tr -d s)
parted -s "$IMG" rm 2
parted -s "$IMG" unit s mkpart primary ${START}s 100%
LOOP=$(losetup -fP --show "$IMG")
PART2=${LOOP}p2
[ -e "$PART2" ] || { kpartx -av "$LOOP"; PART2=/dev/mapper/$(basename "$LOOP")p2; }
e2fsck -fy "$PART2" || true
resize2fs "$PART2"
kpartx -d "$LOOP" 2>/dev/null || true
losetup -d "$LOOP"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2 (native): chroot provisioning (install.sh)
# ─────────────────────────────────────────────────────────────────────────────
echo "[node5-bake] chroot provisioning (install.sh: OBD + AP + fleet + HUD + tailscale)…"
IMG="$OUT_IMG"
LOOP=$(losetup -fP --show "$IMG")
P1=${LOOP}p1 ; P2=${LOOP}p2
if [ ! -e "$P1" ]; then
  kpartx -av "$LOOP"; LN=$(basename "$LOOP")
  P1=/dev/mapper/${LN}p1 ; P2=/dev/mapper/${LN}p2
fi
R=/mnt/node5-root
mkdir -p "$R"

cleanup() {
  set +e
  sync
  umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$R" 2>/dev/null
  kpartx -d "$LOOP" 2>/dev/null
  losetup -d "$LOOP" 2>/dev/null
}
trap cleanup EXIT

mount "$P2" "$R"
mkdir -p "$R/boot/firmware"
mount "$P1" "$R/boot/firmware"
mount --bind /dev "$R/dev"
mount -t devpts none "$R/dev/pts" 2>/dev/null || mount --bind /dev/pts "$R/dev/pts"
mount -t proc none "$R/proc"
mount -t sysfs none "$R/sys"
cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true

echo "[bake] staging Node 5 recipe → /opt/node5"
mkdir -p "$R/opt/node5"
cp "$PROFILE_DIR/install.sh" "$R/opt/node5/install.sh"; chmod 755 "$R/opt/node5/install.sh"
cp -r "$PROFILE_DIR/app" "$R/opt/node5/app"
cat > "$R/opt/node5/secrets.env" <<SEC
SSH_PUBKEY="${SSH_PUBKEY}"
ANON_KEY="${ANON_KEY}"
SUPABASE_URL="${SUPABASE_URL}"
VIGIL_EMAIL="${VIGIL_EMAIL}"
VIGIL_PASSWORD="${VIGIL_PASSWORD}"
OWNER_ID="${OWNER_ID}"
CAR_ID="${CAR_ID}"
OBDLINK_MAC="${OBDLINK_MAC}"
AP_SSID="${AP_SSID}"
AP_PSK="${AP_PSK}"
HOME_SSID="${HOME_SSID}"
HOME_PSK="${HOME_PSK}"
IPHONE_SSID="${IPHONE_SSID}"
IPHONE_PSK="${IPHONE_PSK}"
WIFI_COUNTRY="${WIFI_COUNTRY}"
HOSTNAME_NEW="node5"
SEC
chmod 600 "$R/opt/node5/secrets.env"

echo "[bake] running install.sh in chroot…"
chroot "$R" /bin/bash /opt/node5/install.sh

rm -f "$R/opt/node5/secrets.env" "$R/etc/resolv.conf"
sync
umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$R" 2>/dev/null || true
kpartx -d "$LOOP" 2>/dev/null || true
losetup -d "$LOOP"
trap - EXIT
echo "[node5-bake] chroot provisioning complete"

# ─────────────────────────────────────────────────────────────────────────────
# Deliver — Core keeps the image in OUT_DIR; operator scp's it back to the Mac.
# ─────────────────────────────────────────────────────────────────────────────
SZ_H=$(du -h "$OUT_IMG" | awk '{print $1}')
echo ""
echo "[node5-bake] DONE — headless GR86 OBD/network hub, zero-touch fleet-integrated"
echo "  image:   $OUT_IMG ($SZ_H)"
echo "  ssh:     peta@node5.local"
echo "  AP:      ${AP_SSID}   HUD: http://node5.local:8080"
echo "  anon:    $([ -n "$ANON_KEY" ] && echo present || echo MISSING)"
echo "  FILL post-boot: OBDLINK_MAC + CAR_ID + password (/opt/garage-pi-bridge/.env),"
echo "                  AP/uplink SSIDs+psks (.nmconnection), tailscale authkey (tailscale up)."
