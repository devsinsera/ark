#!/bin/bash
# First-boot: install the TP-Link AC600 (RTL8811AU) 8821au DKMS driver, then put
# wlan1 on 5GHz as the PRIMARY route (built-in wlan0 stays as fallback). Runs via
# ac600-firstboot.service; disables itself once wlan1 is configured. DKMS can't run
# in the bake chroot (needs the live kernel), hence first-boot.
exec >> /var/log/ac600-firstboot.log 2>&1
set -x
echo "=== AC600 first-boot run ==="

# Wait for internet via the built-in wifi (needed to fetch the driver)
for i in $(seq 1 60); do ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && break; sleep 5; done

# Build the driver only if wlan1 isn't already present
if ! ip -o link show | grep -qoE 'wlan1'; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y dkms git build-essential bc raspberrypi-kernel-headers \
    || apt-get install -y dkms git build-essential bc "linux-headers-$(uname -r)" || true
  cd /tmp && rm -rf 8821au
  git clone --depth 1 https://github.com/morrownr/8821au-20210708.git 8821au || { echo "git clone failed (wifi?) — retry next boot"; exit 0; }
  cd 8821au && ./install-driver.sh NoPrompt
  modprobe 8821au 2>/dev/null || true
  sleep 3
fi

# Configure wlan1 on 5GHz as primary, mirroring the built-in's wifi creds
if ip -o link show | grep -qoE 'wlan1'; then
  CON=$(nmcli -t -f NAME,TYPE con show | grep wireless | grep -v ac600 | head -1 | cut -d: -f1)
  SSID=$(nmcli -t -g 802-11-wireless.ssid con show "$CON")
  PSK=$(nmcli -s -g 802-11-wireless-security.psk con show "$CON")
  nmcli con delete ac600-5g 2>/dev/null || true
  nmcli con add type wifi ifname wlan1 con-name ac600-5g ssid "$SSID" 802-11-wireless.band a \
    802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.psk "$PSK" \
    connection.autoconnect yes connection.autoconnect-priority 20 ipv4.route-metric 50
  nmcli con mod "$CON" ipv4.route-metric 800 2>/dev/null || true
  nmcli con up ac600-5g || true
  systemctl disable ac600-firstboot.service   # success → never re-run
  echo "=== AC600 wlan1 on 5GHz, primary; service disabled ==="
else
  echo "=== wlan1 still absent — will retry on next boot ==="
fi
exit 0
