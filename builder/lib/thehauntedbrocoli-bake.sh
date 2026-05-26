#!/bin/bash
# thehauntedbrocoli-bake.sh — build the TheHauntedBrocoli image.
#
# Pi OS Lite (Bookworm, 64-bit) + two-phase install:
#   Phase 1 (cmdline systemd.run=): firstrun.sh — user/SSH/WiFi/hostname/autologin.
#   Phase 2 (systemd oneshot): apt-installs nodejs + Claude Code CLI,
#     configures bashrc autostart, drops marker file.
#
# Identity: brocoli (no peta, no sinsera, no ark references on-Pi).
# Hostname: thehauntedbrocoli

set -euo pipefail

# NOTE: avoid apostrophes inside the docker -c body — Mac shell single
# quoting closes on any stray apostrophe and silently breaks the FIRSTRUN
# heredoc. See memory: project_pi_image_gotchas.md.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/builds/thehauntedbrocoli"
OUT_DIR="$PROFILE_DIR/out"
OUT_IMG="$OUT_DIR/ark-built.img"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
for f in install.sh brocoli-install.service; do
  [ -f "$PROFILE_DIR/$f" ] || { echo "ERROR: missing $PROFILE_DIR/$f"; exit 1; }
done
mkdir -p "$OUT_DIR"

# Operator SSH key for headless access (no name/email — just the key)
SSH_PUBKEY=""
[ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/id_ed25519.pub not present" >&2; exit 1; }

WIFI_SSID="" ; WIFI_KEY=""
if [ -f "$HOME/.ark/wifi.env" ]; then
  set -a ; # shellcheck disable=SC1090
  source "$HOME/.ark/wifi.env" ; set +a
  : "${WIFI_SSID:=}" ; : "${WIFI_KEY:=}"
fi

echo "[brocoli-bake] decompressing base -> $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

# Expand rootfs by 200 MB for npm install + node_modules
echo "[brocoli-bake] expanding image + rootfs (+200 MB)"
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

echo "[brocoli-bake] mounting + writing customizations..."
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

    echo "[bake] installing phase-2 script + service"
    mkdir -p /mnt/root/opt/brocoli
    cp /profile/install.sh /mnt/root/opt/brocoli/install.sh
    chmod 755 /mnt/root/opt/brocoli/install.sh
    cp /profile/brocoli-install.service /mnt/root/etc/systemd/system/
    mkdir -p /mnt/root/etc/systemd/system/multi-user.target.wants
    ln -sf ../brocoli-install.service \
      /mnt/root/etc/systemd/system/multi-user.target.wants/brocoli-install.service

    # Marker file in /boot so the SD is identifiable on any host
    echo "TheHauntedBrocoli" > /mnt/boot/TheHauntedBrocoli

    cat > /mnt/boot/firstrun.sh <<FIRSTRUN
#!/bin/bash
set +e
exec > /var/log/firstrun.log 2>&1
set -x

echo "thehauntedbrocoli" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\tthehauntedbrocoli/g" /etc/hosts

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

# Autologin brocoli on tty1 so Claude can run on HDMI console
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<AUTO
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin brocoli --noclear %I \$TERM
AUTO

systemctl enable brocoli-install.service 2>/dev/null || true

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
    echo "[brocoli-bake] customizations written"
  '

echo "[brocoli-bake] DONE — image at $OUT_IMG"
SZ=$(du -h "$OUT_IMG" | awk '{print $1}')
echo "  size: $SZ"
echo "  hostname: thehauntedbrocoli"
echo "  user: brocoli (password brocoli, NOPASSWD sudo)"
echo "  ssh:    $(echo "$SSH_PUBKEY" | cut -c1-30)..."
echo "  wifi:   ${WIFI_SSID:-MISSING}"
