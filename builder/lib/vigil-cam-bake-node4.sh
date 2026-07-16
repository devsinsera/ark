#!/bin/bash
# vigil-cam-bake.sh — build a FULLY self-contained VIGIL security-camera image
# for the Pi Zero 2 W + Logitech C920. One-pass native arm64 chroot bake (same
# machinery as mirrorloop), but HEADLESS: no display, no X, no pygame/SDL, no
# HDMI/LCD. The SD boots straight into the camera daemon.
#
# Baked in:
#   * pip opencv-python-headless + numpy; apt requests/dotenv/v4l-utils
#   * a 'vigil' system user (video group) running vigil.service (Restart=always)
#   * 'peta' user (SSH-key only, NOPASSWD sudo) + root SSH key
#   * WiFi (NetworkManager) + rfkill-unblock service, hostname, SSH, locale, swap
#   * first-boot user wizard MASKED
#   * app + .env (anon key + email; VIGIL_PASSWORD blank) at /opt/vigil
#   * gpu_mem=16 (headless — no display)
#
# Output: ONE file → Dev-Sinsera/Builds/vigil-cam-pizero2w.img

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/vigil-cam"
APP_DIR="$PROFILE_DIR/app"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
BUILDS_DELIVER_DIR="/Users/petastockdale/Dev-Sinsera/Builds"
DELIVER_NAME="vigil-cam-node4.img"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
for f in vigil_cam.py vigil_auth.py vigil_mjpeg.py run-vigil.sh; do
  [ -f "$APP_DIR/$f" ] || { echo "ERROR: missing $APP_DIR/$f"; exit 1; }
done
[ -f "$PROFILE_DIR/vigil.service" ] || { echo "ERROR: missing $PROFILE_DIR/vigil.service"; exit 1; }
mkdir -p "$OUT_DIR"
rm -rf "$APP_DIR/__pycache__"

# ── Operator creds (host-side) ──
SSH_PUBKEY=""
[ -f "$HOME/.ssh/sinsera_fleet.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/sinsera_fleet.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/sinsera_fleet.pub not present" >&2; exit 1; }

WIFI_SSID="" ; WIFI_KEY=""
if [ -f "$HOME/.ark/wifi.env" ]; then
  set -a ; # shellcheck disable=SC1090
  source "$HOME/.ark/wifi.env" ; set +a
  : "${WIFI_SSID:=}" ; : "${WIFI_KEY:=}"
fi
[ -n "$WIFI_SSID" ] || echo "WARNING: no WiFi SSID (~/.ark/wifi.env) — Zero 2 W is WiFi-only; unreachable without it!"

# ── Supabase anon key (public) from Sinsera Core ──
ENV_PROD="/Users/petastockdale/Dev-Sinsera/Sinsera Core/.env.production"
ANON_KEY=""
if [ -f "$ENV_PROD" ]; then
  ANON_KEY=$(grep -E "^VITE_SUPABASE_ANON_KEY=" "$ENV_PROD" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
fi
[ -n "$ANON_KEY" ] || echo "WARNING: anon key not found — .env SUPABASE_ANON_KEY blank."

# ── Editable overrides from ~/.ark/ark.conf ──
ENV_SSID="$WIFI_SSID"; ENV_KEY="$WIFI_KEY"
[ -f "$HOME/.ark/ark.conf" ] && { set -a; . "$HOME/.ark/ark.conf"; set +a; }
: "${WIFI_SSID:=$ENV_SSID}" ; : "${WIFI_KEY:=$ENV_KEY}"
HOSTNAME_V="${VIGIL_HOSTNAME:-vigil-cam}"
SUPA_URL="${VIGIL_SUPABASE_URL:-https://lkhtgkmivqwgnvzmjbhr.supabase.co}"
[ -n "${VIGIL_SUPABASE_ANON_KEY:-}" ] && ANON_KEY="$VIGIL_SUPABASE_ANON_KEY"
EMAIL_V="${VIGIL_EMAIL:-peta.stockdale@outlook.com}"
PASS_V="${VIGIL_PASSWORD:-}"
SLUG_V="${VIGIL_CAMERA_SLUG:-front-door}"
LABEL_V="${VIGIL_CAMERA_LABEL:-FRONT DOOR}"
WIFI_COUNTRY="${WIFI_COUNTRY:-AU}"
WG_ENABLED=0
if [ -n "${WG_CONF:-}" ] && [ -f "${WG_CONF}" ]; then
  cp "$WG_CONF" "$OUT_DIR/wg0.conf"; WG_ENABLED=1
  echo "[vigil-cam-bake] wiretunnel: baking $WG_CONF → /etc/wireguard/wg0.conf"
fi

echo "[vigil-cam-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[vigil-cam-bake] expanding image + rootfs (+1000 MB for baked deps)"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    SZ=$(stat -c%s "$IMG")
    truncate -s $((SZ + 1000*1024*1024)) "$IMG"
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

echo "[vigil-cam-bake] chroot provisioning (apt + pip + users + vigil.service)…"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  -v "$PROFILE_DIR:/profile:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" \
  -e WIFI_SSID="$WIFI_SSID" \
  -e WIFI_KEY="$WIFI_KEY" \
  -e ANON_KEY="$ANON_KEY" \
  -e HOSTNAME_V="$HOSTNAME_V" \
  -e SUPA_URL="$SUPA_URL" \
  -e EMAIL_V="$EMAIL_V" \
  -e PASS_V="$PASS_V" \
  -e SLUG_V="$SLUG_V" \
  -e LABEL_V="$LABEL_V" \
  -e WIFI_COUNTRY="$WIFI_COUNTRY" \
  -e WG_ENABLED="$WG_ENABLED" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    LOOP=$(losetup -fP --show "$IMG")
    P1=${LOOP}p1 ; P2=${LOOP}p2
    if [ ! -e "$P1" ]; then
      kpartx -av "$LOOP"; LN=$(basename "$LOOP")
      P1=/dev/mapper/${LN}p1 ; P2=/dev/mapper/${LN}p2
    fi
    R=/mnt/root ; B=/mnt/boot
    mkdir -p "$R" "$B"
    mount "$P2" "$R"
    mount "$P1" "$B"
    mount --bind "$B" "$R/boot/firmware"
    mount --bind /dev "$R/dev"
    mount -t devpts none "$R/dev/pts" 2>/dev/null || mount --bind /dev/pts "$R/dev/pts"
    mount -t proc none "$R/proc"
    mount -t sysfs none "$R/sys"
    cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true

    echo "[bake] staging Vigil app → /opt/vigil"
    mkdir -p "$R/opt/vigil"
    cp /profile/app/vigil_cam.py /profile/app/vigil_auth.py /profile/app/vigil_mjpeg.py /profile/app/run-vigil.sh "$R/opt/vigil/"
    cp /profile/vigil.service "$R/opt/vigil/vigil.service"
    chmod 755 "$R/opt/vigil/run-vigil.sh"
    cat > "$R/opt/vigil/.env" <<ENVEOF
# Baked by vigil-cam-bake.sh. VIGIL_PASSWORD BLANK on purpose: LAN MJPEG runs
# immediately; the PRIVATE cloud feed (sinsera.co/vigil) turns on once you set
# it: sudo nano /opt/vigil/.env ; sudo systemctl restart vigil
SUPABASE_URL=${SUPA_URL}
SUPABASE_ANON_KEY=${ANON_KEY}
VIGIL_EMAIL=${EMAIL_V}
VIGIL_PASSWORD=${PASS_V}
CAMERA_SLUG=${SLUG_V}
CAMERA_LABEL="${LABEL_V}"
CAM_WIDTH=640
CAM_HEIGHT=480
CAM_FPS=15
CAM_INDEX=0
JPEG_QUALITY=75
CLOUD_FPS=2
CLOUD_FPS_MOTION=4
MJPEG_PORT=8090
MOTION_THRESHOLD=5.0
MOTION_MIN_AREA=0.012
MOTION_COOLDOWN_S=8
HEARTBEAT_S=30
ENVEOF
    chmod 600 "$R/opt/vigil/.env"

    if [ "$WG_ENABLED" = "1" ] && [ -f /baking/wg0.conf ]; then
      echo "[bake] staging WireGuard wg0.conf → /etc/wireguard/"
      mkdir -p "$R/etc/wireguard"; cp /baking/wg0.conf "$R/etc/wireguard/wg0.conf"; chmod 600 "$R/etc/wireguard/wg0.conf"
    fi

    cat > "$R/root/plan.sh" <<PLAN
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
echo "[plan] apt update + LEAN deps (NO pygame/SDL — headless)"
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-requests python3-dotenv \
  v4l-utils fonts-dejavu-core ca-certificates

echo "[plan] pip install opencv-python-headless + numpy (prebuilt aarch64 wheels)"
pip3 install --break-system-packages --no-cache-dir opencv-python-headless numpy

echo "[plan] locale + swap"
sed -i "s/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/" /etc/locale.gen || true
locale-gen || true; update-locale LANG=en_AU.UTF-8 || true
sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/" /etc/dphys-swapfile 2>/dev/null || true

echo "[plan] MASK the first-boot user wizard"
systemctl disable userconfig.service 2>/dev/null || true; systemctl mask userconfig.service 2>/dev/null || true
systemctl disable userconf.service 2>/dev/null || true; systemctl mask userconf.service 2>/dev/null || true
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null || true

echo "[plan] hostname"
echo "${HOSTNAME_V}" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\t${HOSTNAME_V}/g" /etc/hosts || true

echo "[plan] peta user (SSH-key only, NOPASSWD sudo)"
if ! id peta >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev,gpio,i2c,spi peta
fi
passwd -l peta
echo "peta ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_peta-nopasswd
chmod 440 /etc/sudoers.d/010_peta-nopasswd
mkdir -p /home/peta/.ssh && chmod 700 /home/peta/.ssh
cat > /home/peta/.ssh/authorized_keys <<KEYP
${SSH_PUBKEY}
KEYP
chmod 600 /home/peta/.ssh/authorized_keys; chown -R peta:peta /home/peta/.ssh
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<KEYR
${SSH_PUBKEY}
KEYR
chmod 600 /root/.ssh/authorized_keys
systemctl enable ssh

echo "[plan] WiFi"
if [ -n "${WIFI_SSID}" ] && [ -n "${WIFI_KEY}" ]; then
  cat > /etc/NetworkManager/system-connections/preconfigured.nmconnection <<NMCFG
[connection]
id=preconfigured
type=wifi
[wifi]
mode=infrastructure
ssid=${WIFI_SSID}
hidden=false
[wifi-security]
key-mgmt=wpa-psk
psk=${WIFI_KEY}
[ipv4]
method=auto
[ipv6]
addr-gen-mode=default
method=auto
NMCFG
  chmod 600 /etc/NetworkManager/system-connections/preconfigured.nmconnection
fi

echo "[plan] WiFi country + rfkill-unblock boot service (Zero 2 W needs this)"
raspi-config nonint do_wifi_country ${WIFI_COUNTRY} 2>/dev/null || true
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/vigil-wifi-unblock.sh <<WUB
#!/bin/bash
raspi-config nonint do_wifi_country ${WIFI_COUNTRY} 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
rfkill unblock all  2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
nmcli con up preconfigured 2>/dev/null || true
exit 0
WUB
chmod +x /usr/local/sbin/vigil-wifi-unblock.sh
cat > /etc/systemd/system/vigil-wifi-unblock.service <<WUS
[Unit]
Description=Unblock WiFi (rfkill) + set WLAN country for Pi Zero 2 W
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vigil-wifi-unblock.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
WUS
systemctl enable vigil-wifi-unblock.service

echo "[plan] WireGuard wiretunnel (if a .conf was baked in)"
if [ -f /etc/wireguard/wg0.conf ]; then
  chmod 600 /etc/wireguard/wg0.conf
  apt-get install -y --no-install-recommends wireguard-tools 2>/dev/null || true
  systemctl enable wg-quick@wg0 2>/dev/null || true
fi

echo "[plan] vigil system user + vigil.service (headless camera daemon)"
if ! id vigil >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin --groups video,plugdev vigil
fi
chmod +x /opt/vigil/run-vigil.sh
chown -R vigil:vigil /opt/vigil
touch /var/log/vigil.log; chown vigil:vigil /var/log/vigil.log
cp /opt/vigil/vigil.service /etc/systemd/system/vigil.service
systemctl enable vigil.service

echo "[plan] headless: gpu_mem=16 (no display)"
BOOTCFG=/boot/firmware/config.txt
[ -f "\$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "\$BOOTCFG" ] && ! grep -q "vigil-cam" "\$BOOTCFG"; then
  printf "\n# vigil-cam (headless)\ngpu_mem=16\n" >> "\$BOOTCFG"
fi

echo "[plan] MOTD"
cat > /etc/motd <<MOTD

  VIGIL — Security Camera (Pi Zero 2 W + C920, headless)
  LAN stream:  http://${HOSTNAME_V}.local:8090/stream  (full-rate)
  Private cloud -> sinsera.co/vigil once VIGIL_PASSWORD is set:
    sudo nano /opt/vigil/.env ; sudo systemctl restart vigil
  SSH: peta@${HOSTNAME_V}.local   App log: /var/log/vigil.log
MOTD

apt-get clean
echo "[plan] DONE"
PLAN
    chmod +x "$R/root/plan.sh"

    echo "[bake] running plan in chroot…"
    chroot "$R" /bin/bash /root/plan.sh
    rm -f "$R/root/plan.sh" "$R/etc/resolv.conf"

    sync
    umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$B" "$R" 2>/dev/null || true
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
    echo "[vigil-cam-bake] chroot provisioning complete"
  '

echo "[vigil-cam-bake] deliver uncompressed .img → Builds/"
mkdir -p "$BUILDS_DELIVER_DIR"
rm -f "$BUILDS_DELIVER_DIR/vigil-cam-node4.img" 2>/dev/null || true
mv -f "$OUT_IMG" "$BUILDS_DELIVER_DIR/$DELIVER_NAME"
rm -f "$OUT_DIR/wg0.conf" 2>/dev/null || true

SZ=$(du -h "$BUILDS_DELIVER_DIR/$DELIVER_NAME" | awk '{print $1}')
echo ""
echo "[vigil-cam-bake] DONE — fully baked, headless, zero-touch"
echo "  deliver: $BUILDS_DELIVER_DIR/$DELIVER_NAME ($SZ)"
echo "  ssh:     peta@${HOSTNAME_V}.local"
echo "  LAN:     http://${HOSTNAME_V}.local:8090/stream"
echo "  wifi:    ${WIFI_SSID:-MISSING}"
echo "  anon:    $([ -n "$ANON_KEY" ] && echo present || echo MISSING)"
