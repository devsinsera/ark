#!/bin/bash
# raspios-bake.sh — produce an Ark build from raspios_lite_arm64.
#
# Workflow:
#   1. Decompress Os/raspios_lite_arm64_latest.img.xz to <out_dir>/ark-built.img
#   2. Inside a Docker container with losetup, mount the boot partition
#   3. Drop a firstrun.sh that:
#        - creates a 'pi' user with the operator's SSH key
#        - sets the requested hostname
#        - configures WiFi from ~/.ark/wifi.env (NetworkManager nmconnection)
#        - enables SSH
#   4. Patch cmdline.txt to invoke firstrun.sh once via systemd
#   5. Unmount, compress to ark-built.img.xz, write sha256
#
# Usage:
#   raspios-bake.sh <out_dir> <hostname>
# Example:
#   raspios-bake.sh /work/builds/pi-zero2/out  pi-zero2

set -euo pipefail
OUT_DIR="${1:?usage: raspios-bake.sh <out_dir> <hostname>}"
HOSTNAME="${2:?usage: raspios-bake.sh <out_dir> <hostname>}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_XZ="$REPO_ROOT/Os/raspios_lite_arm64_latest.img.xz"
OUT_IMG="$OUT_DIR/ark-built.img"

[ -f "$SRC_XZ" ] || { echo "ERROR: base image not found: $SRC_XZ" >&2; exit 1; }
mkdir -p "$OUT_DIR"

# ── Read operator creds (host-side) ──
SSH_PUBKEY=""
[ -f "$HOME/.ssh/id_ed25519.pub" ] && SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
[ -n "$SSH_PUBKEY" ] || { echo "ERROR: ~/.ssh/id_ed25519.pub not present" >&2; exit 1; }
WIFI_SSID="" ; WIFI_KEY=""
if [ -f "$HOME/.ark/wifi.env" ]; then
  set -a; # shellcheck disable=SC1090
  source "$HOME/.ark/wifi.env"
  set +a
  : "${WIFI_SSID:=}" ; : "${WIFI_KEY:=}"
fi

# ── Decompress base ──
echo "[raspios-bake] decompressing base → $OUT_IMG"
xz -dck "$SRC_XZ" > "$OUT_IMG"

# ── Mount boot partition via Docker + losetup ──
# Bind-mount the build's OUT_DIR directly so the .img is always at a
# known path inside the container. Avoids any host↔container path
# translation gymnastics.
echo "[raspios-bake] mounting boot partition + writing customizations…"
docker run --rm --privileged \
  -v "$OUT_DIR:/baking" \
  -e HOSTNAME_NEW="$HOSTNAME" \
  -e SSH_PUBKEY="$SSH_PUBKEY" \
  -e WIFI_SSID="$WIFI_SSID" \
  -e WIFI_KEY="$WIFI_KEY" \
  --entrypoint /bin/bash ark-builder:0.1 -c '
    set -e
    IMG=/baking/ark-built.img
    [ -f "$IMG" ] || { echo "ERROR: $IMG not present in container"; exit 1; }
    LOOP=$(losetup -fP --show "$IMG")
    # losetup -P should create loopXpN partition device nodes, but on
    # some kernels/devicemapper combos they dont appear. Fall back to
    # kpartx, which always produces /dev/mapper/loopXpN. This mirrors
    # what builder/lib/chroot-run.sh does for DietPi images.
    PART1=${LOOP}p1
    if [ ! -e "$PART1" ]; then
      echo "[raspios-bake] ${LOOP}p1 not visible — using kpartx"
      kpartx -av "$LOOP"
      LOOPNAME=$(basename "$LOOP")
      PART1=/dev/mapper/${LOOPNAME}p1
    fi
    echo "[raspios-bake] loop=$LOOP"
    mkdir -p /mnt/boot
    mount "$PART1" /mnt/boot

    # firstrun.sh — runs once on first boot, then self-destructs
    cat > /mnt/boot/firstrun.sh <<FIRSTRUN
#!/bin/bash
set +e
exec > /var/log/firstrun.log 2>&1
set -x

# hostname
echo "${HOSTNAME_NEW}" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\t${HOSTNAME_NEW}/g" /etc/hosts

# pi user (no password — SSH-key only)
if ! id pi >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev,gpio,i2c,spi pi
fi
passwd -l pi
echo "pi ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_pi-nopasswd
chmod 440 /etc/sudoers.d/010_pi-nopasswd

# SSH key for pi
mkdir -p /home/pi/.ssh
chmod 700 /home/pi/.ssh
cat > /home/pi/.ssh/authorized_keys <<PUBKEY_PI
${SSH_PUBKEY}
PUBKEY_PI
chmod 600 /home/pi/.ssh/authorized_keys
chown -R pi:pi /home/pi/.ssh

# SSH key for root
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<PUBKEY_ROOT
${SSH_PUBKEY}
PUBKEY_ROOT
chmod 600 /root/.ssh/authorized_keys

# enable + start sshd
systemctl enable ssh
systemctl start ssh

# WiFi (NetworkManager nmconnection — Pi OS Bookworm default)
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

# clean up: remove this script + restore cmdline.txt
rm -f /boot/firstrun.sh
sed -i "s| systemd.run.*||g" /boot/firmware/cmdline.txt 2>/dev/null
sed -i "s| systemd.run.*||g" /boot/cmdline.txt 2>/dev/null

echo "[firstrun] done $(date)"
exit 0
FIRSTRUN
    chmod +x /mnt/boot/firstrun.sh

    # Patch cmdline.txt to invoke firstrun.sh once
    CMD=/mnt/boot/cmdline.txt
    ORIG=$(cat "$CMD")
    # Strip any prior systemd.run= invocations + trailing newline
    CLEAN=$(echo "$ORIG" | sed "s| systemd.run.*||g" | tr -d "\n")
    echo -n "$CLEAN systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target" > "$CMD"

    sync
    umount /mnt/boot
    # Tear down kpartx mappings if used
    kpartx -d "$LOOP" 2>/dev/null || true
    losetup -d "$LOOP"
    echo "[raspios-bake] customizations written"
  '

# ── Compress + sha256 ──
echo "[raspios-bake] compressing → ark-built.img.xz"
rm -f "$OUT_DIR/ark-built.img.xz"
xz -T 0 -k "$OUT_IMG"
shasum -a 256 "$OUT_DIR/ark-built.img.xz" > "$OUT_DIR/ark-built.img.xz.sha256"

echo ""
echo "[raspios-bake] DONE"
echo "  output: $OUT_DIR/ark-built.img.xz"
echo "  hostname: $HOSTNAME"
echo "  ssh:  $(echo "$SSH_PUBKEY" | cut -c1-30)…"
echo "  wifi: ${WIFI_SSID:-MISSING}"
echo "  sha:  $(awk '{print $1}' "$OUT_DIR/ark-built.img.xz.sha256" | cut -c1-12)…"
