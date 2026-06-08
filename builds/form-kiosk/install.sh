#!/bin/bash
# form-kiosk install.sh — runs IN the chroot at bake time (native arm64).
# A LIGHT display-only kiosk for a Pi Zero 2 W on the Sony Bravia 75": boots
# straight to https://sinsera.co/form/ using cage (Wayland kiosk compositor) +
# cog (WPE WebKit) directly on DRM/KMS — no X, no Chromium (too heavy for the
# 512MB Zero 2 W). Output forced to 1080p. All standard fixes baked.
# Reads secrets from /opt/form-kiosk/secrets.env (SSH_PUBKEY, WIFI_SSID, WIFI_KEY).
set +e
HOSTNAME_NEW=form-kiosk
KIOSK_URL="https://sinsera.co/form/"
. /opt/form-kiosk/secrets.env 2>/dev/null
export DEBIAN_FRONTEND=noninteractive
step(){ echo; echo "== $* =="; }

step "apt: cage + cog (WPE) lightweight kiosk + seatd"
apt-get update -y
apt-get install -y --no-install-recommends \
  cage cog seatd libseat1 \
  fonts-dejavu-core fonts-liberation ca-certificates \
  rfkill raspi-config

step "locale + swap (Zero 2 W = 512MB → 1G swap) + force 1080p"
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null; locale-gen 2>/dev/null; update-locale LANG=en_AU.UTF-8 2>/dev/null
sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile 2>/dev/null
BOOTDIR=/boot/firmware; [ -d "$BOOTDIR" ] || BOOTDIR=/boot
BOOTCFG="$BOOTDIR/config.txt"
if [ -f "$BOOTCFG" ] && ! grep -q "form-kiosk" "$BOOTCFG"; then
  printf '\n# form-kiosk — force 1080p on the 4K Bravia (lighter for the Zero 2 W)\nhdmi_force_hotplug=1\nhdmi_group=1\nhdmi_mode=16\ndisable_overscan=1\ngpu_mem=128\n' >> "$BOOTCFG"
fi
# KMS path: pin the HDMI mode to 1080p60 via cmdline video=
CMDLINE="$BOOTDIR/cmdline.txt"
if [ -f "$CMDLINE" ] && ! grep -q "video=HDMI" "$CMDLINE"; then
  sed -i 's/$/ video=HDMI-A-1:1920x1080@60D/' "$CMDLINE"
fi

step "mask first-boot user wizard"
systemctl disable userconfig.service 2>/dev/null; systemctl mask userconfig.service 2>/dev/null
systemctl disable userconf.service 2>/dev/null; systemctl mask userconf.service 2>/dev/null
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null
systemctl disable cloud-init cloud-config cloud-final cloud-init-local cloud-init-main 2>/dev/null; mkdir -p /etc/cloud; touch /etc/cloud/cloud-init.disabled 2>/dev/null

step "WiFi country + rfkill-unblock boot service"
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

step "hostname"
echo "$HOSTNAME_NEW" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\t$HOSTNAME_NEW/g" /etc/hosts 2>/dev/null

step "peta user (SSH-key, NOPASSWD sudo) + root key + ssh"
id peta >/dev/null 2>&1 || useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev,gpio,i2c,spi peta
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

step "kiosk user + autologin tty1 → cage+cog (sinsera.co/form)"
systemctl enable seatd 2>/dev/null
groupadd -f seat 2>/dev/null   # may not exist yet; -G a missing group makes useradd fail
if ! id kiosk >/dev/null 2>&1; then useradd -m -s /bin/bash kiosk; passwd -l kiosk; fi
# add only groups that exist, one at a time, so a missing one can't abort it
for g in video audio input render tty seat plugdev netdev; do
  getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" kiosk
done
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<G1
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
G1
systemctl enable getty@tty1.service   # auto-start unreliable on raspios → enable explicitly
# Launcher: cage runs ONE app fullscreen on DRM; cog is the WPE browser.
cat > /usr/local/bin/form-kiosk-launch.sh <<KL
#!/bin/bash
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
export LIBSEAT_BACKEND=logind
# cog runs as a WAYLAND CLIENT of cage. Do NOT use -P drm — that makes cog fight
# cage for DRM master and every page-flip is denied (black screen). cage is the
# sole DRM master; cog renders into it.
exec cage -d -- cog "$KIOSK_URL" 2>>/var/log/form-kiosk.log
KL
chmod 755 /usr/local/bin/form-kiosk-launch.sh
# Start the kiosk from the tty1 login shell (real seat/VT → DRM works).
cat > /home/kiosk/.bash_profile <<'BP'
if [[ "$(tty)" == "/dev/tty1" ]]; then
  # Wait for the network/DRM to settle, then launch the kiosk (retry on exit).
  while true; do
    /usr/local/bin/form-kiosk-launch.sh
    sleep 3
  done
fi
BP
chown kiosk:kiosk /home/kiosk/.bash_profile
touch /var/log/form-kiosk.log; chown kiosk:kiosk /var/log/form-kiosk.log

step "MOTD + done"
cat > /etc/motd <<M

  Form Kiosk — Pi Zero 2 W → $KIOSK_URL on the Bravia 75" (cage+cog, 1080p).
  SSH: peta@form-kiosk.local   ·   logs: /var/log/form-kiosk.log
  Tune the kiosk: edit /usr/local/bin/form-kiosk-launch.sh
M
apt-get clean
echo "[form-kiosk install] DONE"
