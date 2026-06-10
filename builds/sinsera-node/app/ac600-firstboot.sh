#!/bin/bash
# First-boot: install the TP-Link AC600 (RTL8811AU) 8821au DKMS driver, then put
# wlan1 on the network as the PRIMARY and DISABLE the built-in wlan0 entirely.
# (Running both on the same LAN dual-homes the Pi → ARP flux / flaky connectivity.)
# Uses 2.4GHz — better range/penetration than 5GHz at typical kiosk spots, and the
# camera streams aren't bandwidth-heavy. DKMS can't run in the bake chroot (needs the
# live kernel), hence first-boot; self-disables once wlan1 is up.
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

# Configure wlan1 on 2.4GHz, mirroring the built-in's wifi creds
if ip -o link show | grep -qoE 'wlan1'; then
  CON=$(nmcli -t -f NAME,TYPE con show | grep wireless | grep -v ac600 | head -1 | cut -d: -f1)
  SSID=$(nmcli -t -g 802-11-wireless.ssid con show "$CON")
  PSK=$(nmcli -s -g 802-11-wireless-security.psk con show "$CON")
  nmcli con delete ac600-5g 2>/dev/null || true
  nmcli con add type wifi ifname wlan1 con-name ac600-5g ssid "$SSID" 802-11-wireless.band bg \
    802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.psk "$PSK" \
    connection.autoconnect yes connection.autoconnect-priority 20 ipv4.route-metric 50
  nmcli con up ac600-5g || true
  sleep 6
  # Single-home onto wlan1 ONLY if it actually has internet (else keep wlan0 as the lifeline).
  # Dual-homing wlan0+wlan1 on the same LAN causes flaky/intermittent connectivity.
  if ping -c2 -W3 -I wlan1 1.1.1.1 >/dev/null 2>&1; then
    nmcli con mod "$CON" connection.autoconnect no 2>/dev/null || true
    nmcli con down "$CON" 2>/dev/null || true
    echo "=== wlan1 verified → wlan0 disabled (single-homed on AC600 2.4GHz) ==="
    systemctl disable ac600-firstboot.service   # success → never re-run
  else
    nmcli con mod "$CON" ipv4.route-metric 800 2>/dev/null || true
    echo "=== wlan1 has no internet yet → kept wlan0 as fallback, retry next boot ==="
  fi
else
  echo "=== wlan1 still absent — will retry on next boot ==="
fi
exit 0
