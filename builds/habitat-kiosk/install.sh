#!/bin/bash
# habitat-kiosk install.sh — runs IN the chroot at bake time (native arm64).
# Bakes the full Sinsera-Pi setup into one image: chromium kiosk → sinsera.co on
# the display + Claude Code auto-running on the HABITAT USB (tty2 + ttyd) + Build
# Agent feed, with every fix from the FORM/mirror work applied. Reads secrets from
# /opt/habitat-kiosk/secrets.env (SSH_PUBKEY, WIFI_SSID, WIFI_KEY, ANON_KEY).
set +e
HOSTNAME_NEW=habitat-kiosk
APPSRC=/opt/habitat-kiosk/app
. /opt/habitat-kiosk/secrets.env 2>/dev/null
export DEBIAN_FRONTEND=noninteractive
step(){ echo; echo "== $* =="; }

step "apt: kiosk (chromium/X11) + Claude stack + display/screensaver tools"
apt-get update -y
apt-get install -y --no-install-recommends \
  chromium chromium-sandbox xserver-xorg xserver-xorg-input-libinput xinit \
  x11-xserver-utils openbox unclutter onboard feh xprintidle edid-decode \
  fonts-dejavu-core fonts-liberation ca-certificates curl \
  nodejs npm tmux python3 python3-pip
CHROMIUM=/usr/bin/chromium; [ -x "$CHROMIUM" ] || CHROMIUM=/usr/bin/chromium-browser

step "ttyd web terminal (arm64 binary)"
curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.aarch64 && chmod +x /usr/local/bin/ttyd

step "Claude Code (npm global)"
npm install -g @anthropic-ai/claude-code

step "locale + swap + Pi5 fan + HDMI hotplug"
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null; locale-gen 2>/dev/null; update-locale LANG=en_AU.UTF-8 2>/dev/null
sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/' /etc/dphys-swapfile 2>/dev/null
BOOTCFG=/boot/firmware/config.txt; [ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ] && ! grep -q "habitat-kiosk" "$BOOTCFG"; then
  printf '\n# habitat-kiosk\ndtparam=cooling_fan=on\nhdmi_force_hotplug=1\ndisable_overscan=1\n' >> "$BOOTCFG"
fi

step "mask first-boot user wizard (the username box)"
systemctl disable userconfig.service 2>/dev/null; systemctl mask userconfig.service 2>/dev/null
systemctl disable userconf.service 2>/dev/null; systemctl mask userconf.service 2>/dev/null
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null

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

step "display + screensaver assets → /opt/kiosk"
mkdir -p /opt/kiosk
cp "$APPSRC"/kiosk-display.sh /opt/kiosk/; chmod 755 /opt/kiosk/kiosk-display.sh
cp "$APPSRC"/display-profiles.conf /opt/kiosk/
cp "$APPSRC"/kiosk-screensaver.sh /opt/kiosk/; chmod 755 /opt/kiosk/kiosk-screensaver.sh
cp "$APPSRC"/logo.png /opt/kiosk/logo.png

step "kiosk user (chromium → sinsera.co) autologin tty1"
id kiosk >/dev/null 2>&1 || { useradd -m -s /bin/bash -G video,audio,input,tty,plugdev,netdev,render kiosk; passwd -l kiosk; }
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<G1
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
G1
printf 'if [[ -z "$DISPLAY" && $(tty) == /dev/tty1 ]]; then exec startx; fi\n' > /home/kiosk/.bash_profile
printf '#!/bin/sh\nexec openbox-session\n' > /home/kiosk/.xinitrc; chmod +x /home/kiosk/.xinitrc
mkdir -p /home/kiosk/.config/openbox
cat > /home/kiosk/.config/openbox/autostart <<OB
#!/bin/sh
xset -dpms; xset s off; xset s noblank
unclutter -idle 0.1 -root &
if [ -x /opt/kiosk/kiosk-display.sh ]; then SCALE=\$(/opt/kiosk/kiosk-display.sh 2>/dev/null); fi
[ -z "\$SCALE" ] && SCALE=1
[ -x /opt/kiosk/kiosk-screensaver.sh ] && /opt/kiosk/kiosk-screensaver.sh &
exec $CHROMIUM --kiosk --no-sandbox --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-features=Translate \
  --check-for-update-interval=31536000 --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required --no-first-run --start-fullscreen \
  --force-device-scale-factor=\$SCALE https://sinsera.co/
OB
chmod +x /home/kiosk/.config/openbox/autostart; chown -R kiosk:kiosk /home/kiosk
cat > /etc/X11/Xwrapper.config <<XW
allowed_users=anybody
needs_root_rights=no
XW

step "Claude on HABITAT USB (tty2 console + tmux + ttyd)"
cp "$APPSRC"/habitat-mount.sh /usr/local/bin/; chmod 755 /usr/local/bin/habitat-mount.sh
cp "$APPSRC"/habitat-launch.sh /usr/local/bin/; chmod 755 /usr/local/bin/habitat-launch.sh
mkdir -p /etc/systemd/system/getty@tty2.service.d
cat > /etc/systemd/system/getty@tty2.service.d/autologin.conf <<G2
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin peta --noclear %I \$TERM
G2
systemctl enable getty@tty2.service
grep -q "HABITAT Claude console" /home/peta/.bash_profile 2>/dev/null || cat >> /home/peta/.bash_profile <<'BP'

# HABITAT Claude console on tty2 (not SSH)
if [[ -z "$SSH_CONNECTION" && "$(tty)" == /dev/tty2 ]]; then
  tmux attach -t habitat 2>/dev/null || /usr/local/bin/habitat-launch.sh
fi
BP
chown peta:peta /home/peta/.bash_profile
touch /var/log/habitat.log; chown peta:peta /var/log/habitat.log
cat > /etc/systemd/system/habitat-session.service <<HS
[Unit]
Description=Claude Code (HABITAT) persistent tmux session
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=peta
RemainAfterExit=yes
Environment=HOME=/home/peta
ExecStart=/usr/bin/tmux new-session -d -s habitat /usr/local/bin/habitat-launch.sh
ExecStop=/usr/bin/tmux kill-session -t habitat
[Install]
WantedBy=multi-user.target
HS
F=/home/peta/.habitat-ttyd-pass; openssl rand -hex 6 > "$F" 2>/dev/null || echo habitat$RANDOM > "$F"; chown peta:peta "$F"; chmod 600 "$F"
TPW=$(cat "$F")
cat > /etc/systemd/system/ttyd-habitat.service <<TS
[Unit]
Description=ttyd web terminal -> Claude Code (HABITAT)
After=habitat-session.service
Wants=habitat-session.service
[Service]
User=peta
Environment=HOME=/home/peta
ExecStart=/usr/local/bin/ttyd -p 7681 -i 0.0.0.0 -W -c peta:$TPW /usr/bin/tmux attach -t habitat
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
TS
systemctl enable habitat-session.service ttyd-habitat.service

step "Build Agent reporter (HABITAT → Supabase agent_status)"
mkdir -p /opt/kiosk-agent
cp "$APPSRC"/agent-status-reporter.py /opt/kiosk-agent/
cat > /opt/kiosk-agent/.env <<AE
SUPABASE_URL=https://lkhtgkmivqwgnvzmjbhr.supabase.co
SUPABASE_ANON_KEY=$ANON_KEY
AE
chown -R peta:peta /opt/kiosk-agent; chmod 600 /opt/kiosk-agent/.env
cat > /etc/systemd/system/agent-status-reporter.service <<AR
[Unit]
Description=HABITAT Claude -> Supabase agent_status reporter
After=network-online.target habitat-session.service
Wants=network-online.target
[Service]
User=peta
Environment=HOME=/home/peta
Environment=AGENT_TMUX=habitat
Environment=AGENT_NAME=habitat-build
ExecStart=/usr/bin/python3 /opt/kiosk-agent/agent-status-reporter.py
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
AR
systemctl enable agent-status-reporter.service

step "MOTD + done"
cat > /etc/motd <<'M'

  Habitat Kiosk — Pi 5 · chromium→sinsera.co (tty1) · Claude→HABITAT USB (tty2/ttyd)
  Sign in once: open ttyd or tty2, run `claude login`, then: continue the Habitat app.
  SSH: peta@habitat-kiosk.local   ttyd: http://habitat-kiosk.local:7681
M
apt-get clean
echo "[habitat-kiosk install] DONE"
