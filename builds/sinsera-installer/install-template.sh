#!/bin/bash
# Sinsera Installer — Ark install plan.
#
# Bundles every other Sinsera image and provides the `flash-to-nvme`
# command for writing them onto attached storage from a booted Pi.
# The chroot pipeline (chroot-run.sh + extras) drops the bundled
# .img.xz files at /opt/ark-extras/ inside the rootfs. First-boot
# script moves them to /opt/sinsera-images/.

set -e
set -o pipefail
LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/registry
ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ── Find boot partition ──
BOOT_DIR=""
for cand in /boot/firmware /boot; do
  if [[ -d "$cand" ]] && [[ -f "$cand/cmdline.txt" || -f "$cand/dietpi.txt" || -f "$cand/config.txt" ]]; then
    BOOT_DIR="$cand"; break
  fi
done
[[ -z "$BOOT_DIR" ]] && { ark_log "ERROR: no boot partition"; exit 1; }
ark_log "boot partition: $BOOT_DIR"

# Confirm at least one bundled image landed via chroot-run.sh's
# extras-copy step (writes to /opt/ark-extras/).
if compgen -G "/opt/ark-extras/*.img.xz" > /dev/null; then
  count=$(ls -1 /opt/ark-extras/*.img.xz 2>/dev/null | wc -l | tr -d ' ')
  size=$(du -sh /opt/ark-extras/ | awk '{print $1}')
  ark_log "✓ $count bundled image(s) present at /opt/ark-extras ($size)"
else
  ark_log "WARN: no .img.xz extras found at /opt/ark-extras — flash-to-nvme will have nothing to flash. Check that the .img.xz files exist next to install.plan.sh at build time."
fi

# ── /boot/dietpi.txt ──
if [[ -f "$BOOT_DIR/dietpi.txt" ]]; then
  ark_log "tuning $BOOT_DIR/dietpi.txt"
  set_dp() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$BOOT_DIR/dietpi.txt"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$BOOT_DIR/dietpi.txt"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$BOOT_DIR/dietpi.txt"
    fi
  }
  set_dp AUTO_SETUP_NET_HOSTNAME            'SinseraInstaller'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED        '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE   'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID           'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY            'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE                'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                  'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT         'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX        '-1'
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX  '1'
  set_dp AUTO_SETUP_AUTOSTART_LOGIN_USER    'root'
  set_dp SURVEY_OPTED_IN                    '0'
  set_dp AUTO_SETUP_ACCEPT_LICENSE          '1'
fi

ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# ── flash-to-nvme — the tool the operator runs after first boot ──
ark_log "writing /usr/local/bin/flash-to-nvme"
mkdir -p /usr/local/bin
cat > /usr/local/bin/flash-to-nvme <<'FLASH_TOOL'
#!/bin/bash
# flash-to-nvme — interactive Sinsera image installer.
#
# Lists bundled .img.xz files at /opt/sinsera-images/, asks which
# one to flash, asks which disk to flash to, confirms, writes with
# progress, then offers to set the Pi 5 BOOT_ORDER for NVMe-first.

set -euo pipefail
IMG_DIR=/opt/sinsera-images

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2; exit 1
fi
if [[ ! -d "$IMG_DIR" ]] || [[ -z "$(ls -A "$IMG_DIR"/*.img.xz 2>/dev/null)" ]]; then
  echo "No bundled images found at $IMG_DIR." >&2
  exit 1
fi

# Pick image
echo ""
echo "Sinsera Installer — pick an image to flash:"
echo "──────────────────────────────────────────────"
mapfile -t IMAGES < <(ls -1 "$IMG_DIR"/*.img.xz)
for i in "${!IMAGES[@]}"; do
  name=$(basename "${IMAGES[$i]}")
  size=$(du -h "${IMAGES[$i]}" | cut -f1)
  printf "  %2d) %-40s %s\n" "$((i+1))" "$name" "$size"
done
echo ""
read -rp "Image number: " IMG_NUM
if ! [[ "$IMG_NUM" =~ ^[0-9]+$ ]] || (( IMG_NUM < 1 )) || (( IMG_NUM > ${#IMAGES[@]} )); then
  echo "Invalid selection." >&2; exit 1
fi
IMG_PATH="${IMAGES[$((IMG_NUM-1))]}"
IMG_NAME=$(basename "$IMG_PATH")
echo "✓ Selected: $IMG_NAME"

# Pick target disk
echo ""
echo "Available disks (your root disk is excluded):"
echo "──────────────────────────────────────────────"
# Find the root disk so we refuse to flash to it
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null || echo "")
if [[ -z "$ROOT_DISK" ]]; then
  ROOT_DISK=$(findmnt -no SOURCE / | sed 's/[0-9]*$//' | sed 's|/dev/||')
fi
ROOT_DISK_DEV="/dev/$ROOT_DISK"
echo "  (root disk = $ROOT_DISK_DEV; not shown)"

mapfile -t DISKS < <(lsblk -dno NAME,SIZE,MODEL,TYPE | awk -v r="$ROOT_DISK" '$1!=r && $NF=="disk" {print}')
if (( ${#DISKS[@]} == 0 )); then
  echo "No flashable disks found. Plug an NVMe / USB drive in and re-run." >&2
  exit 1
fi
for i in "${!DISKS[@]}"; do
  printf "  %2d) /dev/%s\n" "$((i+1))" "${DISKS[$i]}"
done
echo ""
read -rp "Disk number: " DISK_NUM
if ! [[ "$DISK_NUM" =~ ^[0-9]+$ ]] || (( DISK_NUM < 1 )) || (( DISK_NUM > ${#DISKS[@]} )); then
  echo "Invalid selection." >&2; exit 1
fi
TARGET=$(echo "${DISKS[$((DISK_NUM-1))]}" | awk '{print "/dev/"$1}')
TARGET_SIZE=$(echo "${DISKS[$((DISK_NUM-1))]}" | awk '{print $2}')
echo "✓ Target: $TARGET ($TARGET_SIZE)"

# Refuse to flash the root disk (defensive — already filtered above but
# paranoia is cheap)
if [[ "$TARGET" == "$ROOT_DISK_DEV" ]]; then
  echo "REFUSED: that's the running root disk." >&2
  exit 1
fi

# Unmount anything mounted from the target
for m in $(mount | awk -v t="$TARGET" '$1 ~ t {print $3}'); do
  echo "  unmounting $m"
  umount "$m" 2>/dev/null || true
done

# Confirm destructive write
echo ""
echo "About to flash $IMG_NAME → $TARGET ($TARGET_SIZE)"
echo "ALL DATA ON $TARGET WILL BE DESTROYED."
read -rp "Type the target name exactly to confirm (e.g. ${TARGET#/dev/}): " CONFIRM
if [[ "$CONFIRM" != "${TARGET#/dev/}" ]]; then
  echo "Confirmation didn't match — aborted." >&2
  exit 1
fi

echo ""
echo "Flashing… (this takes ~30 s on PCIe NVMe, ~3 min on USB 3.0)"
xz -dc "$IMG_PATH" | dd of="$TARGET" bs=4M status=progress conv=fsync
sync
echo "✓ Flash complete."

# Verify by reading back the partition table
echo ""
echo "Target partition table:"
parted -s "$TARGET" print 2>&1 | head -10 || true

# Offer to set Pi 5 BOOT_ORDER for NVMe-first
if command -v rpi-eeprom-config >/dev/null 2>&1; then
  echo ""
  read -rp "Set Pi 5 BOOT_ORDER to prefer NVMe → USB → SD ? [Y/n] " ANS
  ANS=${ANS:-y}
  if [[ "$ANS" =~ ^[Yy]$ ]]; then
    TMP=$(mktemp)
    rpi-eeprom-config > "$TMP"
    if grep -q '^BOOT_ORDER' "$TMP"; then
      sed -i 's/^BOOT_ORDER=.*/BOOT_ORDER=0xf416/' "$TMP"
    else
      echo "BOOT_ORDER=0xf416" >> "$TMP"
    fi
    rpi-eeprom-config --apply "$TMP" && echo "✓ BOOT_ORDER set (NVMe → USB → SD)"
    rm -f "$TMP"
  fi
fi

echo ""
echo "Done. Next:"
echo "  1) Power off:    sudo poweroff"
echo "  2) Remove the SD card."
echo "  3) Power on — the Pi will boot from the NVMe / target you just flashed."
FLASH_TOOL
chmod +x /usr/local/bin/flash-to-nvme
ark_log "wrote /usr/local/bin/flash-to-nvme ($(stat --printf='%s' /usr/local/bin/flash-to-nvme) bytes)"

# ── First-boot script — move bundled images out of /opt/ark-extras/ ──
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'INSTALLER_FIRSTBOOT'
#!/bin/bash
set -e
exec > >(tee -a /var/log/sinsera-installer-firstboot.log) 2>&1
echo "[sinsera-installer] first-boot $(date)"

mkdir -p /opt/sinsera-images
if compgen -G "/opt/ark-extras/*.img.xz" > /dev/null; then
  count=$(ls -1 /opt/ark-extras/*.img.xz 2>/dev/null | wc -l | tr -d ' ')
  echo "[sinsera-installer] moving $count bundled image(s) → /opt/sinsera-images/"
  mv /opt/ark-extras/*.img.xz /opt/sinsera-images/
  ls -lh /opt/sinsera-images/
else
  echo "[sinsera-installer] WARN: no /opt/ark-extras/*.img.xz to move"
fi

# Tools the flash-to-nvme script may need
apt-get update
apt-get install -y --no-install-recommends parted xz-utils rpi-eeprom

# Mirror SSH key to dietpi user too
for user in dietpi pi; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    install -d -o "$user" -g "$user" -m 700 "$home/.ssh"
    install -o "$user" -g "$user" -m 600 /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
  fi
done

cat >> /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Sinsera Installer                                            ║
  ║                                                               ║
  ║  Available images at /opt/sinsera-images/                     ║
  ║                                                               ║
  ║  Flash any of them onto attached NVMe / USB:                  ║
  ║    sudo flash-to-nvme                                         ║
  ║                                                               ║
  ║  The tool will:                                               ║
  ║    1) List bundled images + ask which                         ║
  ║    2) List attached disks + ask target                        ║
  ║    3) Confirm (you type the disk name back)                   ║
  ║    4) Decompress + dd with progress                           ║
  ║    5) Set Pi 5 BOOT_ORDER to NVMe→USB→SD                      ║
  ║                                                               ║
  ║  Then: sudo poweroff, remove SD, boot from the new drive.     ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF
echo "[sinsera-installer] first-boot complete"
INSTALLER_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

printf '{"name":"sinsera-installer","version":"1","installed_at":"%s","profile":"sinsera-installer","strategy":"first-boot-install"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-installer.json
ark_log "registered sinsera-installer"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Installer image baked."
ark_log "  Before flashing onto SD: edit /boot/dietpi.txt for your WiFi."
ark_log "  After boot: ssh root@SinseraInstaller.local, then run:"
ark_log "      sudo flash-to-nvme"
ark_log "================================================================"
exit 0
