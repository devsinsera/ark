#!/bin/bash
# Install the Realtek 8821au DKMS driver for the TP-Link AC600 (Archer T2U Nano, RTL8811AU)
# so Node 1 gets a wlan1 (dual-band, 5GHz) and we can ditch the flaky built-in wifi.
exec > /tmp/ac600-driver.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y dkms git build-essential bc || true
apt-get install -y raspberrypi-kernel-headers || apt-get install -y "linux-headers-$(uname -r)" || true
cd /tmp && rm -rf 8821au
git clone --depth 1 https://github.com/morrownr/8821au-20210708.git 8821au || { echo "GIT CLONE FAILED (wifi?)"; exit 1; }
cd 8821au && ./install-driver.sh NoPrompt
modprobe 8821au 2>/dev/null || true
sleep 2
echo "=== RESULT: interfaces = $(ip -o link show | grep -oE 'wlan[0-9]' | sort -u | tr '\n' ' ') ==="
