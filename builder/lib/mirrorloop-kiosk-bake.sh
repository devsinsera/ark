#!/bin/bash
# mirrorloop-kiosk-bake.sh — build a FULLY self-contained Mirror Loop Kiosk
# image for the Pi Zero 2 W. Everything is baked in ONE pass via a native
# arm64 chroot (Apple Silicon → ark-builder runs arm64 Linux, so apt-get runs
# at native speed, no qemu). The flashed SD boots STRAIGHT into Mirror Loop —
# no first-boot apt, no setup wizard, no SSH fixing required.
#
# Baked at build time (in chroot):
#   * apt: python3-opencv, python3-pygame, numpy, requests, dotenv, SDL2, v4l-utils
#   * 'mirror' user with tty1 autologin → run-mirror-loop.sh (SDL kmsdrm, no X)
#   * 'peta' user (SSH-key only, NOPASSWD sudo) + root SSH key
#   * WiFi (NetworkManager), hostname, SSH enabled, locale, 512MB swap, HDMI
#   * THE FIRST-BOOT USER WIZARD IS MASKED (userconfig.service) — the cause of
#     the "which username would you like to change?" box.
#   * app + .env (anon key + email; MIRROR_PASSWORD blank) at /opt/mirror-loop
#
# Output: ONE file → Dev-Sinsera/Builds/mirrorloop-kiosk-<date>.img.xz
#
# Targets Pi Zero 2 W / Zero 2 WH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/mirrorloop-kiosk"
APP_DIR="$PROFILE_DIR/app"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
BUILDS_DELIVER_DIR="/Users/petastockdale/Dev-Sinsera/Builds"
DELIVER_NAME="mirrorloop-kiosk-pizero2w.img"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
for f in mirror_loop.py telemetry.py run-mirror-loop.sh; do
  [ -f "$APP_DIR/$f" ] || { echo "ERROR: missing $APP_DIR/$f"; exit 1; }
done
mkdir -p "$OUT_DIR"
rm -rf "$APP_DIR/__pycache__"

# ── Operator creds (host-side) ──
SSH_PUBKEY=""
[ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/id_ed25519.pub not present" >&2; exit 1; }

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

# ── Editable overrides from ~/.ark/ark.conf (additive; blanks fall back to the
#    verified defaults, so with no ark.conf the image is identical to before) ──
ENV_SSID="$WIFI_SSID"; ENV_KEY="$WIFI_KEY"
[ -f "$HOME/.ark/ark.conf" ] && { set -a; . "$HOME/.ark/ark.conf"; set +a; }
: "${WIFI_SSID:=$ENV_SSID}" ; : "${WIFI_KEY:=$ENV_KEY}"
HOSTNAME_V="${MIRRORLOOP_HOSTNAME:-mirrorloop-kiosk}"
SUPA_URL="${MIRRORLOOP_SUPABASE_URL:-https://lkhtgkmivqwgnvzmjbhr.supabase.co}"
[ -n "${MIRRORLOOP_SUPABASE_ANON_KEY:-}" ] && ANON_KEY="$MIRRORLOOP_SUPABASE_ANON_KEY"
EMAIL_V="${MIRRORLOOP_EMAIL:-peta.stockdale@outlook.com}"
PASS_V="${MIRRORLOOP_PASSWORD:-}"
SLUG_V="${MIRRORLOOP_UNIT_SLUG:-test-zero2w}"
LABEL_V="${MIRRORLOOP_UNIT_LABEL:-TEST ZERO 2 W}"
WIFI_COUNTRY="${WIFI_COUNTRY:-AU}"
# WireGuard "wiretunnel": stage the operator .conf for baking if configured.
WG_ENABLED=0
if [ -n "${WG_CONF:-}" ] && [ -f "${WG_CONF}" ]; then
  cp "$WG_CONF" "$OUT_DIR/wg0.conf"; WG_ENABLED=1
  echo "[mirrorloop-kiosk-bake] wiretunnel: baking $WG_CONF → /etc/wireguard/wg0.conf"
fi

echo "[mirrorloop-kiosk-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

echo "[mirrorloop-kiosk-bake] expanding image + rootfs (+1000 MB for baked deps)"
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

echo "[mirrorloop-kiosk-bake] chroot provisioning (apt + users + autostart + wizard-mask)…"
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
    # Pi OS bookworm+: firmware partition lives at /boot/firmware
    mount --bind "$B" "$R/boot/firmware"
    mount --bind /dev "$R/dev"
    mount -t devpts none "$R/dev/pts" 2>/dev/null || mount --bind /dev/pts "$R/dev/pts"
    mount -t proc none "$R/proc"
    mount -t sysfs none "$R/sys"
    cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true

    echo "[bake] staging Mirror Loop app → /opt/mirror-loop"
    mkdir -p "$R/opt/mirror-loop"
    cp /profile/app/mirror_loop.py "$R/opt/mirror-loop/"
    cp /profile/app/telemetry.py "$R/opt/mirror-loop/"
    cp /profile/app/run-mirror-loop.sh "$R/opt/mirror-loop/"
    chmod 755 "$R/opt/mirror-loop/run-mirror-loop.sh"
    cat > "$R/opt/mirror-loop/.env" <<ENVEOF
# Baked by mirrorloop-kiosk-bake.sh. MIRROR_PASSWORD BLANK on purpose:
# display runs immediately; telemetry to sinsera.co/mirrorloop turns on once
# you set it then: sudo systemctl restart getty@tty1
SUPABASE_URL=${SUPA_URL}
SUPABASE_ANON_KEY=${ANON_KEY}
MIRROR_EMAIL=${EMAIL_V}
MIRROR_PASSWORD=${PASS_V}
UNIT_SLUG=${SLUG_V}
UNIT_LABEL="${LABEL_V}"
CAMERA_INDEX=0
HEARTBEAT_S=30
ENVEOF
    chmod 600 "$R/opt/mirror-loop/.env"

    # ── WireGuard wiretunnel: place the operator .conf into the image ──
    if [ "$WG_ENABLED" = "1" ] && [ -f /baking/wg0.conf ]; then
      echo "[bake] staging WireGuard wg0.conf → /etc/wireguard/"
      mkdir -p "$R/etc/wireguard"
      cp /baking/wg0.conf "$R/etc/wireguard/wg0.conf"
      chmod 600 "$R/etc/wireguard/wg0.conf"
    fi

    # ── write the in-chroot provisioning plan ──
    cat > "$R/root/plan.sh" <<PLAN
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
echo "[plan] apt update + install Mirror Loop deps (native arm64, LEAN)"
apt-get update -y
# Pygame + small libs from apt; OpenCV comes from pip (headless) below to
# avoid python3-opencv dragging in ~240 pkgs (OpenMPI/LLVM/GDAL/TCL).
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-pygame \
  python3-requests python3-dotenv \
  libsdl2-2.0-0 v4l-utils fonts-dejavu-core ca-certificates

echo "[plan] pip install LEAN OpenCV (headless) + numpy (prebuilt aarch64 wheels)"
# headless = no GUI/highgui (pygame does the display); we only use VideoCapture,
# cvtColor, absdiff, resize, GaussianBlur, threshold. ~40MB vs ~600MB apt tree.
pip3 install --break-system-packages --no-cache-dir opencv-python-headless numpy

echo "[plan] locale en_AU.UTF-8"
sed -i "s/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/" /etc/locale.gen || true
locale-gen || true
update-locale LANG=en_AU.UTF-8 || true

echo "[plan] swap 512MB"
sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/" /etc/dphys-swapfile 2>/dev/null || true

echo "[plan] MASK the first-boot user wizard (the username box)"
systemctl disable userconfig.service 2>/dev/null || true
systemctl mask    userconfig.service 2>/dev/null || true
systemctl disable userconf.service 2>/dev/null || true
systemctl mask    userconf.service 2>/dev/null || true
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null || true
rm -f /etc/systemd/system/getty@tty1.service.d/*userconfig* 2>/dev/null || true

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
chmod 600 /home/peta/.ssh/authorized_keys
chown -R peta:peta /home/peta/.ssh
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

echo "[plan] WiFi country (${WIFI_COUNTRY}) + rfkill-unblock boot service (Zero 2 W needs this)"
# The Zero 2 W radio stays rfkill-blocked until the WLAN country is set. The
# unblock must happen ON the hardware (no radio in the build chroot), so a tiny
# idempotent boot service does it before NetworkManager connects.
raspi-config nonint do_wifi_country ${WIFI_COUNTRY} 2>/dev/null || true
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/mirrorloop-wifi-unblock.sh <<WUB
#!/bin/bash
raspi-config nonint do_wifi_country ${WIFI_COUNTRY} 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
rfkill unblock all  2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
nmcli con up preconfigured 2>/dev/null || true
exit 0
WUB
chmod +x /usr/local/sbin/mirrorloop-wifi-unblock.sh
cat > /etc/systemd/system/mirrorloop-wifi-unblock.service <<WUS
[Unit]
Description=Unblock WiFi (rfkill) + set WLAN country for Pi Zero 2 W
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mirrorloop-wifi-unblock.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
WUS
systemctl enable mirrorloop-wifi-unblock.service

echo "[plan] WireGuard wiretunnel (if a .conf was baked in)"
if [ -f /etc/wireguard/wg0.conf ]; then
  chmod 600 /etc/wireguard/wg0.conf
  apt-get install -y --no-install-recommends wireguard-tools 2>/dev/null || true
  systemctl enable wg-quick@wg0 2>/dev/null || true
  echo "[plan] wiretunnel wg0 enabled"
fi

echo "[plan] mirror user + tty1 autologin → renderer"
if ! id mirror >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups video,audio,input,tty,render,plugdev,netdev,dialout mirror
  passwd -l mirror
fi
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<GETTY
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin mirror --noclear %I \\\$TERM
GETTY
systemctl enable getty@tty1.service
chmod +x /opt/mirror-loop/run-mirror-loop.sh
cat > /home/mirror/.bash_profile <<BP
if [[ -z "\\\$DISPLAY" && \\\$(tty) == /dev/tty1 ]]; then
  exec /opt/mirror-loop/run-mirror-loop.sh
fi
BP
chown mirror:mirror /home/mirror/.bash_profile
chown mirror:mirror /opt/mirror-loop/.env 2>/dev/null || true  # renderer runs as 'mirror' — must read creds
touch /var/log/mirror-loop.log
chown mirror:mirror /var/log/mirror-loop.log

echo "[plan] HDMI force-hotplug for the Bravia"
BOOTCFG=/boot/firmware/config.txt
[ -f "\$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "\$BOOTCFG" ] && ! grep -q "mirrorloop-kiosk" "\$BOOTCFG"; then
  cat >> "\$BOOTCFG" <<HDMI

# mirrorloop-kiosk
hdmi_force_hotplug=1
disable_overscan=1
HDMI
fi

echo "[plan] Waveshare 1.44in LCD HAT — backlight OFF (kiosk uses the HDMI TV)"
cat > /usr/local/sbin/waveshare-bl-off.sh <<WBL
#!/bin/bash
# Waveshare 1.44inch LCD HAT backlight is on BL=GPIO24. The mirror kiosk
# renders to the HDMI TV, so keep the tiny hat screen dark.
pinctrl set 24 op dl 2>/dev/null || raspi-gpio set 24 op dl 2>/dev/null || true
exit 0
WBL
chmod +x /usr/local/sbin/waveshare-bl-off.sh
cat > /etc/systemd/system/waveshare-bl-off.service <<WBS
[Unit]
Description=Turn off Waveshare 1.44 LCD HAT backlight (GPIO24)
DefaultDependencies=no
After=sysinit.target local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/waveshare-bl-off.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
WBS
systemctl enable waveshare-bl-off.service

echo "[plan] MOTD"
cat > /etc/motd <<MOTD

  Mirror Loop Kiosk — Pi Zero 2 W + C920 -> TV
  Renderer auto-launches on tty1 (SDL kmsdrm, no X).
  Telemetry -> sinsera.co/mirrorloop once MIRROR_PASSWORD is set:
    sudo nano /opt/mirror-loop/.env ; sudo systemctl restart getty@tty1
  SSH: peta@mirrorloop-kiosk.local   App log: /var/log/mirror-loop.log
MOTD

apt-get clean
echo "[plan] DONE"
PLAN
    chmod +x "$R/root/plan.sh"

    echo "[bake] running plan in chroot…"
    chroot "$R" /bin/bash /root/plan.sh
    rm -f "$R/root/plan.sh" "$R/etc/resolv.conf"

    # No firstrun / no systemd.run: everything is already provisioned, so the
    # SD boots straight to multi-user → WiFi + SSH + mirror autologin → app.
    # (Leave stock cmdline.txt incl. init_resize, which expands p2 to fill SD.)

    sync
    umount "$R/sys" "$R/proc" "$R/dev/pts" "$R/dev" "$R/boot/firmware" "$B" "$R" 2>/dev/null || true
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
    echo "[mirrorloop-kiosk-bake] chroot provisioning complete"
  '

echo "[mirrorloop-kiosk-bake] compressing → .img.xz"
rm -f "$OUT_DIR/ark-built.img.xz"
xz -T 0 "$OUT_IMG"   # no -k: drop the uncompressed .img, keep only .xz

mkdir -p "$BUILDS_DELIVER_DIR"
# Single deliverable, per the builds-output-folder rule (no .sha256 sidecar).
rm -f "$BUILDS_DELIVER_DIR/mirrorloop-kiosk"-* "$BUILDS_DELIVER_DIR/mirrorloop-kiosk.img" 2>/dev/null || true
mv -f "$OUT_IMG" "$BUILDS_DELIVER_DIR/$DELIVER_NAME"
rm -f "$OUT_DIR/wg0.conf" 2>/dev/null || true   # don't leave the WG conf staged

SZ=$(du -h "$BUILDS_DELIVER_DIR/$DELIVER_NAME" | awk '{print $1}')
echo ""
echo "[mirrorloop-kiosk-bake] DONE — fully baked, zero-touch"
echo "  deliver: $BUILDS_DELIVER_DIR/$DELIVER_NAME ($SZ)"
echo "  ssh:     peta@mirrorloop-kiosk.local"
echo "  wifi:    ${WIFI_SSID:-MISSING}"
echo "  anon:    $([ -n "$ANON_KEY" ] && echo present || echo MISSING)"
