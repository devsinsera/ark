#!/bin/bash
# sinsera-node-3 install.sh — Pi ZERO 2 W → 75" TV Vigil camera wall.
# Renders the 4 Eufy cams as a 2x2 grid FULLSCREEN on the HDMI framebuffer
# (Pygame on SDL kmsdrm — NO X, NO browser; the Zero 2 W can't run WPE/cog).
# LCD HAT disabled (HDMI only). LAN-local: reaches the bridge at
# 192.168.4.163:8091 over wifi. Lean by design — no Claude/USB-builder/WireGuard
# stack (too heavy for 512MB). Runs in the chroot.
# secrets.env: SSH_PUBKEY, WIFI_SSID, WIFI_KEY, ANON_KEY, HOSTNAME_NEW
set +e
. /opt/sinsera-node/secrets.env 2>/dev/null
: "${HOSTNAME_NEW:=sinsera-node-3}"
APPSRC=/opt/sinsera-node/app
export DEBIAN_FRONTEND=noninteractive
step(){ echo; echo "== $* =="; }

step "apt: framebuffer renderer stack (pygame + requests, NO browser)"
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pygame python3-requests \
  libsdl2-2.0-0 libsdl2-image-2.0-0 \
  fonts-dejavu-core ca-certificates curl \
  rfkill raspi-config iw network-manager

step "locale + Zero 2 W boot config (force 1080p HDMI, gpu_mem, NO fan, LCD HAT off)"
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null; locale-gen 2>/dev/null; update-locale LANG=en_AU.UTF-8 2>/dev/null
BOOTDIR=/boot/firmware; [ -d "$BOOTDIR" ] || BOOTDIR=/boot
BOOTCFG="$BOOTDIR/config.txt"
if [ -f "$BOOTCFG" ] && ! grep -q "sinsera-node-3" "$BOOTCFG"; then
  cat >> "$BOOTCFG" <<'CFG'

# sinsera-node-3 — Zero 2 W → 75" TV: force 1080p HDMI on the framebuffer, no LCD HAT
hdmi_force_hotplug=1
disable_overscan=1
hdmi_group=1
hdmi_mode=16
gpu_mem=128
# No SPI/LCD-HAT dtoverlay loaded — HDMI framebuffer is the only display.
dtparam=spi=off
CFG
fi

step "best-effort LCD-HAT backlight OFF (common Waveshare pins) — HDMI is the display"
cat > /usr/local/sbin/lcd-hat-off.sh <<'LH'
#!/bin/bash
# Drive common Waveshare LCD-HAT backlight pins LOW so the little screen stays dark
# (HDMI is the real display). Harmless if no HAT / a different pin — tune if needed.
for PIN in 18 24 13; do
  pinctrl set $PIN op dl 2>/dev/null || {
    echo $PIN > /sys/class/gpio/export 2>/dev/null
    echo out > /sys/class/gpio/gpio$PIN/direction 2>/dev/null
    echo 0 > /sys/class/gpio/gpio$PIN/value 2>/dev/null
  }
done
exit 0
LH
chmod +x /usr/local/sbin/lcd-hat-off.sh
cat > /etc/systemd/system/lcd-hat-off.service <<'LHS'
[Unit]
Description=Turn the LCD HAT backlight off (HDMI-only display)
DefaultDependencies=no
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lcd-hat-off.sh
RemainAfterExit=yes
[Install]
WantedBy=sysinit.target
LHS
systemctl enable lcd-hat-off.service 2>/dev/null

step "mask first-boot wizard + cloud-init"
systemctl disable userconfig.service 2>/dev/null; systemctl mask userconfig.service 2>/dev/null
systemctl disable userconf.service 2>/dev/null; systemctl mask userconf.service 2>/dev/null
systemctl disable cloud-init cloud-config cloud-final cloud-init-local cloud-init-main 2>/dev/null; mkdir -p /etc/cloud; touch /etc/cloud/cloud-init.disabled 2>/dev/null

step "WiFi country + rfkill-unblock + powersave-off"
raspi-config nonint do_wifi_country AU 2>/dev/null
cat > /usr/local/sbin/ark-wifi-unblock.sh <<'UNB'
#!/bin/bash
raspi-config nonint do_wifi_country AU 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true; rfkill unblock all 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true; nmcli con up preconfigured 2>/dev/null || true
exit 0
UNB
chmod +x /usr/local/sbin/ark-wifi-unblock.sh
cat > /etc/systemd/system/ark-wifi-unblock.service <<'UNBS'
[Unit]
Description=Ark: WLAN country + rfkill-unblock
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ark-wifi-unblock.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNBS
systemctl enable ark-wifi-unblock.service 2>/dev/null
cat > /etc/systemd/system/wifi-powersave-off.service <<'WP'
[Unit]
Description=Disable wlan0 power saving
After=network.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'iw dev wlan0 set power_save off || true'
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
WP
systemctl enable wifi-powersave-off.service 2>/dev/null

step "hostname ($HOSTNAME_NEW)"
echo "$HOSTNAME_NEW" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\t$HOSTNAME_NEW/g" /etc/hosts 2>/dev/null

step "peta user (SSH-key, NOPASSWD sudo) + ssh"
id peta >/dev/null 2>&1 || useradd -m -s /bin/bash -G adm,dialout,sudo,audio,video,plugdev,users,input,render,netdev,gpio,i2c,spi peta
passwd -l peta
echo "peta ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_peta-nopasswd; chmod 440 /etc/sudoers.d/010_peta-nopasswd
mkdir -p /home/peta/.ssh && chmod 700 /home/peta/.ssh
printf '%s\n' "$SSH_PUBKEY" > /home/peta/.ssh/authorized_keys; chmod 600 /home/peta/.ssh/authorized_keys; chown -R peta:peta /home/peta/.ssh
mkdir -p /root/.ssh && chmod 700 /root/.ssh; printf '%s\n' "$SSH_PUBKEY" > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys
systemctl enable ssh

step "WiFi connection"
if [ -n "$WIFI_SSID" ] && [ -n "$WIFI_KEY" ]; then
  cat > /etc/NetworkManager/system-connections/preconfigured.nmconnection <<NM
[connection]
id=preconfigured
type=wifi
[wifi]
mode=infrastructure
ssid=$WIFI_SSID
hidden=false
[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_KEY
[ipv4]
method=auto
[ipv6]
addr-gen-mode=default
method=auto
NM
  chmod 600 /etc/NetworkManager/system-connections/preconfigured.nmconnection
fi

step "vigil-wall renderer + 'wall' user tty1 autologin (framebuffer, kmsdrm)"
install -d /opt/vigil-wall
cp "$APPSRC"/vigil-wall.py /opt/vigil-wall/vigil-wall.py
cp "$APPSRC"/run-vigil-wall.sh /opt/vigil-wall/run-vigil-wall.sh
chmod +x /opt/vigil-wall/run-vigil-wall.sh
touch /var/log/vigil-wall.log
id wall >/dev/null 2>&1 || { useradd -m -s /bin/bash wall; passwd -l wall; }
for g in video audio input render tty seat plugdev netdev gpio; do getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" wall; done
chown -R wall:wall /opt/vigil-wall /var/log/vigil-wall.log
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<G1
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin wall --noclear %I \$TERM
G1
systemctl enable getty@tty1.service   # auto-start is unreliable on raspios → enable explicitly
cat > /home/wall/.bash_profile <<'BP'
# tty1 → render the Vigil wall on the HDMI framebuffer (crash-loops internally)
if [[ "$(tty)" == "/dev/tty1" ]]; then
  exec /opt/vigil-wall/run-vigil-wall.sh
fi
BP
chown wall:wall /home/wall/.bash_profile

step "MOTD + done"
cat > /etc/motd <<M

  $HOSTNAME_NEW — Pi Zero 2 W · Vigil camera wall on HDMI (framebuffer, 1080p)
  Bridge: http://192.168.4.163:8091  ·  SSH: peta@$HOSTNAME_NEW.local
  Renderer log: /var/log/vigil-wall.log  ·  tune: /opt/vigil-wall/vigil-wall.py
M
apt-get clean
echo "[sinsera-node-3 install] DONE → $HOSTNAME_NEW (Vigil wall, framebuffer)"
