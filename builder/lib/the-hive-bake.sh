#!/bin/bash
# the-hive-bake.sh — build the The Hive image (Pi 5).
#
# Pi OS Lite (Bookworm, 64-bit) + two-phase install:
#   Phase 1 (cmdline systemd.run=): firstrun.sh — user/SSH/WiFi/hostname/autologin.
#   Phase 2 (systemd oneshot): the-hive-install.service installs nodejs +
#     Claude CLI + Tor + X + Chromium + ttyd + The Comb launcher app.
#
# Identity: brocoli user (no peta/sinsera references on-Pi).
# Hostname: thehive  (mDNS: thehive.local)

set -euo pipefail

# NOTE: avoid apostrophes inside the docker -c body — Mac shell single
# quoting closes on any stray apostrophe and silently breaks the FIRSTRUN
# heredoc. See memory: project_pi_image_gotchas.md.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/the-hive"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
for f in install.sh the-hive-install.service; do
  [ -f "$PROFILE_DIR/$f" ] || { echo "ERROR: missing $PROFILE_DIR/$f"; exit 1; }
done
mkdir -p "$OUT_DIR"

# Operator SSH key for headless access
SSH_PUBKEY=""
[ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/id_ed25519.pub not present" >&2; exit 1; }

WIFI_SSID="" ; WIFI_KEY=""
if [ -f "$HOME/.ark/wifi.env" ]; then
  set -a ; # shellcheck disable=SC1090
  source "$HOME/.ark/wifi.env" ; set +a
  : "${WIFI_SSID:=}" ; : "${WIFI_KEY:=}"
fi

echo "[the-hive-bake] decompressing base -> $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

# Expand rootfs by 200 MB for npm install + node_modules
echo "[the-hive-bake] expanding image + rootfs (+200 MB)"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    SZ=$(stat -c%s "$IMG")
    truncate -s $((SZ + 200*1024*1024)) "$IMG"
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

# The Comb lives outside the Ark repo — on the USB Stick by default.
# Override with THE_COMB_PATH env var if you keep it elsewhere.
APP_DIR="${THE_COMB_PATH:-/Volumes/Stick/the-comb}"
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: The Comb source not found at $APP_DIR." >&2
  echo "       Plug in the Stick USB, or export THE_COMB_PATH=/path/to/the-comb" >&2
  exit 1
fi

echo "[the-hive-bake] mounting + writing customizations..."
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  -v "$PROFILE_DIR:/profile:ro" \
  -v "$APP_DIR:/app:ro" \
  -e SSH_PUBKEY="$SSH_PUBKEY" \
  -e WIFI_SSID="$WIFI_SSID" \
  -e WIFI_KEY="$WIFI_KEY" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    LOOP=$(losetup -fP --show "$IMG")
    PART1=${LOOP}p1 ; PART2=${LOOP}p2
    if [ ! -e "$PART1" ]; then
      kpartx -av "$LOOP"
      LN=$(basename "$LOOP")
      PART1=/dev/mapper/${LN}p1 ; PART2=/dev/mapper/${LN}p2
    fi
    mkdir -p /mnt/boot /mnt/root
    mount "$PART1" /mnt/boot
    mount "$PART2" /mnt/root

    echo "[bake] installing phase-2 script + service"
    mkdir -p /mnt/root/opt/the-hive
    cp /profile/install.sh /mnt/root/opt/the-hive/install.sh
    chmod 755 /mnt/root/opt/the-hive/install.sh
    cp /profile/the-hive-install.service /mnt/root/etc/systemd/system/
    mkdir -p /mnt/root/etc/systemd/system/multi-user.target.wants
    ln -sf ../the-hive-install.service \
      /mnt/root/etc/systemd/system/multi-user.target.wants/the-hive-install.service

    echo "[bake] embedding The Comb app to /opt/the-comb"
    mkdir -p /mnt/root/opt/the-comb
    cp -a /app/. /mnt/root/opt/the-comb/
    rm -rf /mnt/root/opt/the-comb/node_modules /mnt/root/opt/the-comb/.git 2>/dev/null || true
    # Owner gets set to brocoli (uid 1001) on first boot by install.sh
    cp /app/the-comb.service /mnt/root/etc/systemd/system/

    echo "[bake] installing kiosk units (ttyd + X + Chromium)"
    cp /profile/kiosk/ttyd-claude.service /mnt/root/etc/systemd/system/
    cp /profile/kiosk/ark-kiosk.service   /mnt/root/etc/systemd/system/
    cp /profile/kiosk/claude-launch.sh    /mnt/root/usr/local/bin/claude-launch
    chmod 755 /mnt/root/usr/local/bin/claude-launch
    mkdir -p /mnt/root/home/brocoli
    cp /profile/kiosk/xinitrc /mnt/root/home/brocoli/.xinitrc
    chmod 755 /mnt/root/home/brocoli/.xinitrc

    # Marker file in /boot so the SD is identifiable on any host
    echo "TheHive" > /mnt/boot/TheHive

    cat > /mnt/boot/firstrun.sh <<FIRSTRUN
#!/bin/bash
set +e
exec > /var/log/firstrun.log 2>&1
set -x

echo "thehive" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\tthehive/g" /etc/hosts

if ! id brocoli >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev brocoli
fi
echo "brocoli:brocoli" | chpasswd
echo "brocoli ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_brocoli-nopasswd
chmod 440 /etc/sudoers.d/010_brocoli-nopasswd

mkdir -p /home/brocoli/.ssh
chmod 700 /home/brocoli/.ssh
cat > /home/brocoli/.ssh/authorized_keys <<BROCOLI_KEY
${SSH_PUBKEY}
BROCOLI_KEY
chmod 600 /home/brocoli/.ssh/authorized_keys
chown -R brocoli:brocoli /home/brocoli/.ssh

mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<ROOT_KEY
${SSH_PUBKEY}
ROOT_KEY
chmod 600 /root/.ssh/authorized_keys

systemctl enable ssh
systemctl start ssh

# Kill Pi OS Bookworm wizard + misleading SSH banner
rm -f /run/sshwarn /etc/profile.d/sshpwd.sh
systemctl disable userconfig.service 2>/dev/null
systemctl mask userconfig.service 2>/dev/null
rm -f /var/lib/userconf-pi/needs-userconf /run/needs-userconf

# WiFi country gate
raspi-config nonint do_wifi_country AU 2>/dev/null
rfkill unblock all 2>/dev/null
iw reg set AU 2>/dev/null

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

# Autologin brocoli on tty1 so the kiosk + ttyd can run on HDMI
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<AUTO
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin brocoli --noclear %I \$TERM
AUTO

systemctl enable the-hive-install.service 2>/dev/null || true

rm -f /boot/firstrun.sh /boot/firmware/firstrun.sh
sed -i "s| systemd.run.*||g" /boot/firmware/cmdline.txt 2>/dev/null
sed -i "s| systemd.run.*||g" /boot/cmdline.txt 2>/dev/null

echo "[firstrun] done \$(date)"
exit 0
FIRSTRUN
    chmod +x /mnt/boot/firstrun.sh

    CMD=/mnt/boot/cmdline.txt
    ORIG=$(cat "$CMD")
    CLEAN=$(echo "$ORIG" | sed "s| systemd.run.*||g" | tr -d "\n")
    echo -n "$CLEAN systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target" > "$CMD"

    sync
    umount /mnt/root
    umount /mnt/boot
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
    echo "[the-hive-bake] customizations written"
  '

echo "[the-hive-bake] DONE — image at $OUT_IMG"
SZ=$(du -h "$OUT_IMG" | awk '{print $1}')
echo "  size: $SZ"
echo "  hostname: thehive (mDNS: thehive.local)"
echo "  user: brocoli (password brocoli, NOPASSWD sudo)"
echo "  app:  /opt/the-comb  (The Comb launcher on :8080)"
echo "  ssh:  $(echo "$SSH_PUBKEY" | cut -c1-30)..."
echo "  wifi: ${WIFI_SSID:-MISSING}"
