#!/bin/bash
# nvme-bootorder-firstboot — make the Pi 5 boot from the NVMe SSD on the HAT, then
# self-disable. Sets the EEPROM BOOT_ORDER to 0xf416 = try NVMe (6) → USB-MSD (4) →
# SD (1) → repeat (f). Idempotent; runs once and disables itself.
#
# Note: this configures the bootloader from a RUNNING system. Flash this image to the
# SSD and boot it once (most Pi 5 firmware already tries NVMe); this then locks NVMe as
# the preferred boot device so it's reliable thereafter. If a board's EEPROM won't try
# NVMe at all yet, boot the same image from SD once — this runs, then move to the SSD.
set +e

if ! command -v rpi-eeprom-config >/dev/null 2>&1; then
  systemctl disable nvme-bootorder-firstboot.service 2>/dev/null
  exit 0
fi

CUR=$(rpi-eeprom-config 2>/dev/null | grep -E '^BOOT_ORDER=' | head -1)
if ! echo "$CUR" | grep -q '0xf416'; then
  TMP=$(mktemp)
  rpi-eeprom-config > "$TMP" 2>/dev/null
  if grep -q '^BOOT_ORDER=' "$TMP"; then
    sed -i 's/^BOOT_ORDER=.*/BOOT_ORDER=0xf416/' "$TMP"
  else
    printf 'BOOT_ORDER=0xf416\n' >> "$TMP"
  fi
  rpi-eeprom-config --apply "$TMP" 2>/dev/null && logger -t nvme-bootorder "BOOT_ORDER set to 0xf416 (prefer NVMe)"
  rm -f "$TMP"
fi

# Only stand down once the order is in place (so a failed apply retries next boot).
NOW=$(rpi-eeprom-config 2>/dev/null | grep -E '^BOOT_ORDER=' | head -1)
echo "$NOW" | grep -q '0xf416' && systemctl disable nvme-bootorder-firstboot.service 2>/dev/null
exit 0
