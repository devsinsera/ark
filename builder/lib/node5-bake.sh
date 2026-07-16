#!/bin/bash
# node5-bake.sh — build the FULLY self-contained Node 5 image: the GR86 in-car
# Pi 5 (2GB), HEADLESS. One-pass native arm64 chroot bake (same machinery as
# vigil-cam-bake-node4). No display/X/chromium — Node 5 is an OBD + network hub;
# the dashboard is viewed on the iPad/phone over the Pi's own AP or the cloud.
#
# Baked in (see builds/node5/install.sh):
#   * garage-pi-bridge OBD logger (venv) -> garage-obd-bridge.service (Restart=always),
#     .env with anon key + owner email; OBDLINK_MAC + CAR_ID + password BLANK placeholders
#   * NetworkManager AP (Sinsera-GR86) + priority uplinks (home > iphone > car; placeholders)
#   * onboard + USB WiFi/BT dongle firmware + rfkill-unblock
#   * node-status-reporter + node-command-runner (fleet: shows as node5, remote power)
#   * local-first HUD stub (:8080), store-and-forward timer -> Node 3, idle-shutdown stub
#   * Tailscale first-boot installer (NO authkey baked), overlayfs toggle (off)
#   * 'peta' user (SSH-key only, NOPASSWD sudo) + fleet key; gpu_mem=16 (headless)
#
# Output: ONE file → Dev-Sinsera/Builds/node5.img
#
# Placeholders the user fills post-bake: OBDLINK_MAC + CAR_ID + SUPABASE_PASSWORD
# (/opt/garage-pi-bridge/.env), AP passphrase + uplink SSIDs/psks (.nmconnection),
# Tailscale authkey (`sudo tailscale up`). Optionally supply them at bake time via
# ~/.ark/wifi.env, ~/.ark/vigil.env and ~/.ark/node5.conf (see below).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/node5"
APP_DIR="$PROFILE_DIR/app"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
BUILDS_DELIVER_DIR="/Users/petastockdale/Dev-Sinsera/Builds"
DELIVER_NAME="node5.img"

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

# ── Operator creds (host-side) ──
SSH_PUBKEY=""
[ -f "$HOME/.ssh/sinsera_fleet.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/sinsera_fleet.pub")
[ -z "$SSH_PUBKEY" ] && [ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: no fleet key (~/.ssh/sinsera_fleet.pub or ~/.ssh/id_ed25519.pub)" >&2; exit 1; }

# ── Supabase anon key (public) from Sinsera Core ──
ENV_PROD="/Users/petastockdale/Dev-Sinsera/Sinsera Core/.env.production"
ANON_KEY=""
if [ -f "$ENV_PROD" ]; then
  ANON_KEY=$(grep -E "^VITE_SUPABASE_ANON_KEY=" "$ENV_PROD" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
fi
[ -n "$ANON_KEY" ] || echo "WARNING: anon key not found — bridge/reporters .env will need it filled over SSH."

# ── Camera-account creds for the fleet reporters (optional; blank = fill over SSH) ──
VIGIL_EMAIL="peta.stockdale@outlook.com"; VIGIL_PASSWORD=""; SUPABASE_URL="https://lkhtgkmivqwgnvzmjbhr.supabase.co"
if [ -f "$HOME/.ark/vigil.env" ]; then set -a; . "$HOME/.ark/vigil.env"; set +a; fi
[ -n "$VIGIL_PASSWORD" ] || echo "WARNING: no camera password (~/.ark/vigil.env) — node5 won't report to node_status until filled."

# ── Optional WiFi/AP/OBD overrides (~/.ark/node5.conf) — all placeholders otherwise ──
AP_SSID="Sinsera-GR86"; AP_PSK="CHANGE-ME-AP-PASSPHRASE"
HOME_SSID=""; HOME_PSK=""; IPHONE_SSID=""; IPHONE_PSK=""
OBDLINK_MAC=""; CAR_ID=""; WIFI_COUNTRY="AU"; OWNER_ID="82e75fd1-7878-45f5-9760-ba0af6838a3d"
[ -f "$HOME/.ark/node5.conf" ] && { set -a; . "$HOME/.ark/node5.conf"; set +a; }

echo "[node5-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[node5-bake] expanding image + rootfs (+1600 MB for venv/bleak/NM/firmware)"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    SZ=$(stat -c%s "$IMG")
    truncate -s $((SZ + 1600*1024*1024)) "$IMG"
    START=$(parted -s "$IMG" unit s print | awk "\$1==2{print \$2}" | tr -d s)
    parted -s "$IMG" rm 2
    parted -s "$IMG" unit s mkpart primary ${START}s 100%
    LOOP=$(losetup -fP --show "$IMG")
    PART2=${LOOP}p2
    [ -e "$PART2" ] || { kpartx -av "$LOOP"; PART2=/dev/mapper/$(basename "$LOOP")p2; }
    e2fsck -fy "$PART2" || true
    resize2fs "$PART2"
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
  '

echo "[node5-bake] chroot provisioning (install.sh: OBD + AP + fleet + HUD + tailscale)…"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  -v "$PROFILE_DIR:/profile:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" \
  -e ANON_KEY="$ANON_KEY" \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e VIGIL_EMAIL="$VIGIL_EMAIL" \
  -e VIGIL_PASSWORD="$VIGIL_PASSWORD" \
  -e OWNER_ID="$OWNER_ID" \
  -e CAR_ID="$CAR_ID" \
  -e OBDLINK_MAC="$OBDLINK_MAC" \
  -e AP_SSID="$AP_SSID" \
  -e AP_PSK="$AP_PSK" \
  -e HOME_SSID="$HOME_SSID" \
  -e HOME_PSK="$HOME_PSK" \
  -e IPHONE_SSID="$IPHONE_SSID" \
  -e IPHONE_PSK="$IPHONE_PSK" \
  -e WIFI_COUNTRY="$WIFI_COUNTRY" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    LOOP=$(losetup -fP --show "$IMG")
    P1=${LOOP}p1 ; P2=${LOOP}p2
    if [ ! -e "$P1" ]; then
      kpartx -av "$LOOP"; LN=$(basename "$LOOP")
      P1=/dev/mapper/${LN}p1 ; P2=/dev/mapper/${LN}p2
    fi
    R=/mnt/root
    mkdir -p "$R"
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
    cp /profile/install.sh "$R/opt/node5/install.sh"; chmod 755 "$R/opt/node5/install.sh"
    cp -r /profile/app "$R/opt/node5/app"
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
    echo "[node5-bake] chroot provisioning complete"
  '

echo "[node5-bake] deliver uncompressed .img → Builds/"
mkdir -p "$BUILDS_DELIVER_DIR"
rm -f "$BUILDS_DELIVER_DIR/$DELIVER_NAME" 2>/dev/null || true
mv -f "$OUT_IMG" "$BUILDS_DELIVER_DIR/$DELIVER_NAME"

SZ=$(du -h "$BUILDS_DELIVER_DIR/$DELIVER_NAME" | awk '{print $1}')
echo ""
echo "[node5-bake] DONE — headless GR86 OBD/network hub, zero-touch fleet-integrated"
echo "  deliver: $BUILDS_DELIVER_DIR/$DELIVER_NAME ($SZ)"
echo "  ssh:     peta@node5.local"
echo "  AP:      ${AP_SSID}   HUD: http://node5.local:8080"
echo "  anon:    $([ -n "$ANON_KEY" ] && echo present || echo MISSING)"
echo "  FILL post-boot: OBDLINK_MAC + CAR_ID + password (/opt/garage-pi-bridge/.env),"
echo "                  AP/uplink SSIDs+psks (.nmconnection), tailscale authkey (tailscale up)."
