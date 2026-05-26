#!/bin/bash
# Phase-2 installer for The Hive (Pi 5). Runs once on first boot
# (after firstrun.sh creates the brocoli user + brings up WiFi).
#
# Sets up the whole runtime stack:
#   - Node + Claude CLI
#   - Tor + torsocks (LAN-exposed SOCKS5)
#   - X11 (modesetting) + Chromium + openbox
#   - ttyd (web terminal for Claude)
#   - The Comb launcher app at /opt/the-comb
#   - USB STICK auto-mount at /mnt/stick
#   - Pinned kernel 6.12 + RTL8821AU AC600 DKMS driver
#
# Disables itself when done.

set +e
exec > /var/log/the-hive-install.log 2>&1
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

# --- core packages: node, dkms toolchain, wifi tools, X stack ---
apt-get install -y -q --no-install-recommends \
  nodejs npm \
  dkms git build-essential bc \
  iw wireless-tools rfkill \
  linux-headers-rpi-v8 linux-headers-rpi-2712 \
  xserver-xorg-core xserver-xorg-input-libinput \
  xserver-xorg-video-modesetting xserver-xorg-legacy \
  xinit x11-xserver-utils \
  openbox unclutter fonts-dejavu-core \
  chromium chromium-common \
  || true

# --- Tor + torsocks (recommends required on Debian 13) ---
apt-get install -y tor torsocks || true
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

# --- node fallback to nodesource if apt version is too old ---
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi
node --version || true
npm --version || true

# --- claude code CLI (global) ---
npm install -g @anthropic-ai/claude-code || true
which claude || true

# --- ttyd static binary (not in Debian Trixie apt) ---
if [ ! -x /usr/local/bin/ttyd ]; then
  TTYD_URL=$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest \
    | grep browser_download_url | grep aarch64 | head -1 \
    | sed 's/.*"\(https:[^"]*\)".*/\1/')
  curl -fsSL "$TTYD_URL" -o /usr/local/bin/ttyd
  chmod 755 /usr/local/bin/ttyd
fi

# --- Pin kernel to 6.12 BEFORE building the AC600 driver ---
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
if ! modinfo 8821au >/dev/null 2>&1; then
  cd /usr/src
  [ -d 8821au-20210708 ] && rm -rf 8821au-20210708
  git clone --depth 1 https://github.com/morrownr/8821au-20210708.git \
    >> /var/log/the-hive-install.log 2>&1 || true
  if [ -d /usr/src/8821au-20210708 ]; then
    cd /usr/src/8821au-20210708
    bash ./install-driver.sh NoPrompt >> /var/log/the-hive-install.log 2>&1 || true
  fi
fi

# --- X server config: allow brocoli user to start X, force modesetting ---
mkdir -p /etc/X11
cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=yes
EOF
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/20-modesetting.conf <<EOF
Section "Device"
  Identifier "TheHiveGPU"
  Driver "modesetting"
  Option "kmsdev" "/dev/dri/card1"
EndSection
EOF

# --- HDMI console getty (Bookworm + cloud-init can leave it disabled) ---
systemctl enable getty@tty1.service 2>/dev/null || true

# --- USB STICK auto-mount at /mnt/stick ---
mkdir -p /mnt/stick
chown brocoli:brocoli /mnt/stick
if ! grep -q "LABEL=STICK" /etc/fstab; then
  cat >> /etc/fstab <<EOF
# Auto-mount the The Comb project USB stick by label (safe if missing)
LABEL=STICK  /mnt/stick  vfat  defaults,uid=1001,gid=1001,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0
EOF
fi

# --- Strip any leftover Claude tty1 autostart in .bashrc ---
# The launcher kiosk now owns the screen; Claude is served via ttyd
# inside the launcher (Claude tile → web terminal). Don't double-launch.
sed -i '/# CLAUDE_AUTOSTART/,/^fi$/d' /home/brocoli/.bashrc 2>/dev/null || true

# --- Enable launcher app + ttyd + kiosk services (units installed by bake) ---
systemctl daemon-reload
systemctl enable the-comb.service     2>/dev/null || true
systemctl enable ttyd-claude.service  2>/dev/null || true
systemctl enable ark-kiosk.service    2>/dev/null || true

# Ensure /opt/the-comb is owned correctly (bake copies the source in)
[ -d /opt/the-comb ] && chown -R brocoli:brocoli /opt/the-comb

# --- marker file ---
echo "TheHive — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /home/brocoli/TheHive
chown brocoli:brocoli /home/brocoli/TheHive

# --- disable myself ---
systemctl disable the-hive-install.service 2>/dev/null || true

echo "[the-hive-install] done $(date)"

# Reboot — kernel pin + driver bind + kiosk all need clean start.
( sleep 3 ; systemctl reboot ) &

exit 0
