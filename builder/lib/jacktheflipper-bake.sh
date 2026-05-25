#!/bin/bash
# jacktheflipper-bake.sh — build the JackTheFlipper image.
#
# Pi OS Lite (Bookworm, 64-bit) + RaspyJack source tarball + Flipper
# bridge + systemd oneshot install service.
#
# Two-phase install on the Pi:
#   Phase 1 (cmdline systemd.run=): firstrun.sh creates peta user with
#     SSH key, hostname jacktheflipper, WiFi creds, enables sshd.
#     Reboots.
#   Phase 2 (jacktheflipper-install.service after network-online): runs
#     /opt/jacktheflipper/install.sh — apt-installs, extracts raspyjack,
#     runs install_raspyjack.sh, configures Flipper bridge. Reboots
#     once more for SPI dtoverlay.
#
# Usage:
#   jacktheflipper-bake.sh
# (Reads from builds/jacktheflipper/ — the bundled raspyjack-src.tar.gz,
#  flipper-bridge.py, install.sh, jacktheflipper-install.service, etc.)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/jacktheflipper"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
for f in raspyjack-src.tar.gz flipper-bridge.py install.sh jacktheflipper-install.service 99-flipper.rules; do
  [ -f "$PROFILE_DIR/$f" ] || { echo "ERROR: missing $PROFILE_DIR/$f"; exit 1; }
done
mkdir -p "$OUT_DIR"

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

echo "[jacktheflipper-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

# Pi OS Lite rootfs partition is small. Resize it by ~200 MB to fit
# the 108 MB raspyjack tarball + extras with headroom before flashing.
# We do this before mounting so the ext4 fs has room.
echo "[jacktheflipper-bake] expanding image + rootfs partition (+250 MB)"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    # Pad image file
    SZ=$(stat -c%s "$IMG")
    truncate -s $((SZ + 250*1024*1024)) "$IMG"
    # Rewrite partition table to grow part 2
    parted -s "$IMG" unit s print
    # Get start of partition 2
    START=$(parted -s "$IMG" unit s print | awk "\$1==2{print \$2}" | tr -d s)
    parted -s "$IMG" rm 2
    parted -s "$IMG" unit s mkpart primary ${START}s 100%
    parted -s "$IMG" print
    # Resize the ext4 fs to fill it
    LOOP=$(losetup -fP --show "$IMG")
    PART2=${LOOP}p2
    if [ ! -e "$PART2" ]; then
      kpartx -av "$LOOP"
      LOOPNAME=$(basename "$LOOP")
      PART2=/dev/mapper/${LOOPNAME}p2
    fi
    e2fsck -fy "$PART2" || true
    resize2fs "$PART2"
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
  '

# ── Mount + customize ──
echo "[jacktheflipper-bake] mounting boot + rootfs, writing customizations…"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  -v "$PROFILE_DIR:/profile:ro" \
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

    echo "[bake] writing /opt/jacktheflipper/ + raspyjack tarball to rootfs"
    mkdir -p /mnt/root/opt/jacktheflipper /mnt/root/opt/ark-extras

    cp /profile/flipper-bridge.py /mnt/root/opt/jacktheflipper/flipper-bridge.py
    chmod 755 /mnt/root/opt/jacktheflipper/flipper-bridge.py
    cp /profile/install.sh /mnt/root/opt/jacktheflipper/install.sh
    chmod 755 /mnt/root/opt/jacktheflipper/install.sh
    cp /profile/raspyjack-src.tar.gz /mnt/root/opt/ark-extras/raspyjack-src.tar.gz

    echo "[bake] installing systemd unit + enabling via symlink"
    cp /profile/jacktheflipper-install.service /mnt/root/etc/systemd/system/jacktheflipper-install.service
    mkdir -p /mnt/root/etc/systemd/system/multi-user.target.wants
    ln -sf ../jacktheflipper-install.service \
      /mnt/root/etc/systemd/system/multi-user.target.wants/jacktheflipper-install.service

    echo "[bake] installing udev rule"
    cp /profile/99-flipper.rules /mnt/root/etc/udev/rules.d/99-flipper.rules

    echo "[bake] firstrun.sh on boot partition"
    cat > /mnt/boot/firstrun.sh <<FIRSTRUN
#!/bin/bash
set +e
exec > /var/log/firstrun.log 2>&1
set -x

# hostname
echo "jacktheflipper" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\tjacktheflipper/g" /etc/hosts

# peta user (no password — SSH-key only)
if ! id peta >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev,gpio,i2c,spi peta
fi
passwd -l peta
echo "peta ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_peta-nopasswd
chmod 440 /etc/sudoers.d/010_peta-nopasswd

mkdir -p /home/peta/.ssh
chmod 700 /home/peta/.ssh
cat > /home/peta/.ssh/authorized_keys <<PETA_KEY
${SSH_PUBKEY}
PETA_KEY
chmod 600 /home/peta/.ssh/authorized_keys
chown -R peta:peta /home/peta/.ssh

mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<ROOT_KEY
${SSH_PUBKEY}
ROOT_KEY
chmod 600 /root/.ssh/authorized_keys

systemctl enable ssh
systemctl start ssh

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

# Make sure phase-2 service is enabled (it should already be, but be sure)
systemctl enable jacktheflipper-install.service 2>/dev/null || true

rm -f /boot/firstrun.sh /boot/firmware/firstrun.sh
sed -i "s| systemd.run.*||g" /boot/firmware/cmdline.txt 2>/dev/null
sed -i "s| systemd.run.*||g" /boot/cmdline.txt 2>/dev/null

echo "[firstrun] done $(date)"
exit 0
FIRSTRUN
    chmod +x /mnt/boot/firstrun.sh

    # Patch cmdline.txt to invoke firstrun.sh once
    CMD=/mnt/boot/cmdline.txt
    ORIG=$(cat "$CMD")
    CLEAN=$(echo "$ORIG" | sed "s| systemd.run.*||g" | tr -d "\n")
    echo -n "$CLEAN systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target" > "$CMD"

    sync
    umount /mnt/root
    umount /mnt/boot
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
    echo "[jacktheflipper-bake] customizations written"
  '

# ── Compress + sha256 ──
echo "[jacktheflipper-bake] compressing → ark-built.img.xz"
rm -f "$OUT_DIR/ark-built.img.xz"
xz -T 0 -k "$OUT_IMG"
shasum -a 256 "$OUT_DIR/ark-built.img.xz" > "$OUT_DIR/ark-built.img.xz.sha256"

SHA=$(awk '{print $1}' "$OUT_DIR/ark-built.img.xz.sha256" | cut -c1-12)
SZ=$(du -h "$OUT_DIR/ark-built.img.xz" | awk '{print $1}')

echo ""
echo "[jacktheflipper-bake] DONE"
echo "  output: $OUT_DIR/ark-built.img.xz ($SZ)"
echo "  sha:    ${SHA}…"
echo "  ssh:    $(echo "$SSH_PUBKEY" | cut -c1-30)…"
echo "  wifi:   ${WIFI_SSID:-MISSING}"
