#!/bin/bash
# Phase-2 installer for TheHauntedBrocoli. Runs once on first boot
# (after firstrun.sh creates user + brings up WiFi) and installs the
# Claude CLI so it auto-launches on the HDMI console.
#
# Disables itself when done.

set +e
exec > /var/log/brocoli-install.log 2>&1
set -x

# --- wait for network ---
for i in 1 2 3 4 5 6 7 8 9 10; do
  if getent hosts deb.debian.org >/dev/null 2>&1 && \
     getent hosts registry.npmjs.org >/dev/null 2>&1; then
    break
  fi
  sleep 6
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -q

# --- node 20 + tooling for AC600 driver build ---
apt-get install -y -q --no-install-recommends \
  nodejs npm \
  dkms git build-essential bc \
  iw wireless-tools rfkill \
  linux-headers-rpi-v8 linux-headers-rpi-2712 \
  || true

# --- Tor + torsocks ---
# Debian 13 split the tor package — needs recommends for the actual
# tor-instance to install, so do NOT pass --no-install-recommends here.
apt-get install -y tor torsocks || true
# LAN-exposed SOCKS5 (operator-controlled network only)
if ! grep -q "^SocksPort 0.0.0.0:9050" /etc/tor/torrc 2>/dev/null; then
  cat >> /etc/tor/torrc <<TORRC

# Sinsera — LAN SOCKS5 (operator-controlled network only)
SocksPort 0.0.0.0:9050
SocksPolicy accept 192.168.0.0/16
SocksPolicy accept 10.0.0.0/8
SocksPolicy reject *
TORRC
fi
systemctl enable tor 2>/dev/null || true
systemctl restart tor@default 2>/dev/null || systemctl restart tor 2>/dev/null || true

# Fallback to NodeSource if apt nodejs is too old
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi
node --version || true
npm --version || true

# --- claude code CLI ---
npm install -g @anthropic-ai/claude-code || true
which claude || true

# --- Pin kernel to 6.12 BEFORE building the AC600 driver ---
# The morrownr/aircrack-ng RTL8811AU drivers do not yet compile against
# kernel 6.18 (released 2026); pin to 6.12 (still supported) so the
# DKMS build succeeds. Hold all kernel packages to keep it pinned.
if dpkg -l | grep -q "^ii\s\+linux-image-6.12.75"; then
  cp /boot/firmware/kernel_2712.img /boot/firmware/kernel_2712.6.18.bak 2>/dev/null || true
  cp /boot/firmware/initramfs_2712 /boot/firmware/initramfs_2712.6.18.bak 2>/dev/null || true
  cp /boot/vmlinuz-6.12.75+rpt-rpi-2712 /boot/firmware/kernel_2712.img 2>/dev/null || true
  cp /boot/initrd.img-6.12.75+rpt-rpi-2712 /boot/firmware/initramfs_2712 2>/dev/null || true
  apt-mark hold \
    linux-image-rpi-2712 linux-image-rpi-v8 \
    linux-image-6.12.75+rpt-rpi-2712 linux-image-6.12.75+rpt-rpi-v8 \
    linux-headers-rpi-2712 linux-headers-rpi-v8 2>/dev/null || true
fi

# --- AC600 / Archer T2U Nano (RTL8811AU) DKMS driver ---
# Adds wlan1 with monitor mode support. Skips silently if already present.
# Driver is built against the CURRENTLY RUNNING kernel — after the kernel
# pin above, the post-reboot kernel will be 6.12 and DKMS will rebuild.
if ! modinfo 8821au >/dev/null 2>&1; then
  cd /usr/src
  [ -d 8821au-20210708 ] && rm -rf 8821au-20210708
  git clone --depth 1 https://github.com/morrownr/8821au-20210708.git \
    >> /var/log/brocoli-install.log 2>&1 || true
  if [ -d /usr/src/8821au-20210708 ]; then
    cd /usr/src/8821au-20210708
    bash ./install-driver.sh NoPrompt \
      >> /var/log/brocoli-install.log 2>&1 || true
  fi
fi

# --- ensure HDMI console (getty@tty1) is enabled ---
# Pi OS Lite Bookworm with cloud-init sometimes leaves getty@tty1.service
# in 'disabled' state, so the autologin drop-in never fires and HDMI
# shows only stale boot scrollback. Explicit enable fixes this.
systemctl enable getty@tty1.service 2>/dev/null || true

# --- autolaunch claude on tty1 for user brocoli ---
mkdir -p /home/brocoli
if ! grep -q "CLAUDE_AUTOSTART" /home/brocoli/.bashrc 2>/dev/null; then
  cat >> /home/brocoli/.bashrc <<'BRC'

# CLAUDE_AUTOSTART — run Claude CLI on HDMI console only
if [ -z "$CLAUDE_AUTOSTARTED" ] && [ "$(tty)" = "/dev/tty1" ]; then
  export CLAUDE_AUTOSTARTED=1
  echo
  echo "  TheHauntedBrocoli"
  echo "  ---"
  echo "  Launching Claude. Type /help for commands, /quit to exit."
  echo
  sleep 1
  exec claude
fi
BRC
fi
chown brocoli:brocoli /home/brocoli/.bashrc

# --- marker file ---
echo "TheHauntedBrocoli — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /home/brocoli/TheHauntedBrocoli
chown brocoli:brocoli /home/brocoli/TheHauntedBrocoli

# --- disable myself ---
systemctl disable brocoli-install.service 2>/dev/null || true

echo "[brocoli-install] done $(date)"

# reboot so autologin → claude takes effect cleanly
( sleep 3 ; systemctl reboot ) &

exit 0
