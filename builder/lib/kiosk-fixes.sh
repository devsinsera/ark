#!/bin/bash
# kiosk-fixes.sh — canonical, reusable provisioning fixes for Ark Pi images.
#
# These are the hard-won defaults every Pi kiosk needs (learned building the
# mirrorloop-kiosk image, 2026-06-07). Source this file inside a chroot (bake
# time) OR on the Pi (first-boot install) and call the functions:
#
#   . kiosk-fixes.sh
#   ark_mask_firstboot_wizard
#   ark_wifi_country_unblock "AU"
#   ark_install_wiretunnel            # if /etc/wireguard/wg0.conf was placed
#
# All functions are idempotent and never fail the caller (best-effort).

# Kill the RPi OS first-boot user-setup wizard (the "which username would you
# like to change?" box on the console). Bake images create their own user, so
# the wizard is pure friction.
ark_mask_firstboot_wizard() {
  echo "[kiosk-fixes] masking first-boot user wizard"
  systemctl disable userconfig.service 2>/dev/null || true
  systemctl mask    userconfig.service 2>/dev/null || true
  systemctl disable userconf.service   2>/dev/null || true
  systemctl mask    userconf.service   2>/dev/null || true
  rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null || true
  rm -f /etc/systemd/system/getty@tty1.service.d/*userconfig* 2>/dev/null || true
}

# Set the WLAN regulatory country and unblock the radio at every boot. REQUIRED
# for the Pi Zero 2 W (its WiFi is rfkill-soft-blocked until a country is set).
# The unblock must run on real hardware, so this installs a boot service.
ark_wifi_country_unblock() {
  local country="${1:-AU}"
  echo "[kiosk-fixes] WiFi country=$country + rfkill-unblock boot service"
  raspi-config nonint do_wifi_country "$country" 2>/dev/null || true
  mkdir -p /usr/local/sbin
  cat > /usr/local/sbin/ark-wifi-unblock.sh <<UNBLK
#!/bin/bash
raspi-config nonint do_wifi_country ${country} 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
rfkill unblock all  2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
nmcli con up preconfigured 2>/dev/null || true
exit 0
UNBLK
  chmod +x /usr/local/sbin/ark-wifi-unblock.sh
  cat > /etc/systemd/system/ark-wifi-unblock.service <<UNBSVC
[Unit]
Description=Ark: set WLAN country + rfkill-unblock WiFi
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ark-wifi-unblock.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNBSVC
  systemctl enable ark-wifi-unblock.service 2>/dev/null || true
}

# Enable a WireGuard "wiretunnel". The bake host must have already copied the
# operator's .conf to /etc/wireguard/wg0.conf in the image; this installs the
# tools and enables it on boot.
ark_install_wiretunnel() {
  [ -f /etc/wireguard/wg0.conf ] || { echo "[kiosk-fixes] no /etc/wireguard/wg0.conf — wiretunnel skipped"; return 0; }
  echo "[kiosk-fixes] enabling WireGuard wiretunnel (wg0)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends wireguard-tools 2>/dev/null || true
  chmod 600 /etc/wireguard/wg0.conf 2>/dev/null || true
  systemctl enable wg-quick@wg0 2>/dev/null || true
}
