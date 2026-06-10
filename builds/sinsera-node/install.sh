#!/bin/bash
# sinsera-node install.sh — Pi 5 8GB SD-booted SECONDARY kiosk. Runs in the chroot.
# Display: cage + cog (WPE on DRM) → https://sinsera.co/?kiosk=1 (auto-login dashboard),
# NO cursor (touch), auto-detect display (native res). Claude Code builds off whatever
# USB is inserted (ttyd + tmux + auto-resume). Every session learning baked in.
# secrets.env: SSH_PUBKEY, WIFI_SSID, WIFI_KEY, ANON_KEY, HOSTNAME_NEW
set +e
. /opt/sinsera-node/secrets.env 2>/dev/null
: "${HOSTNAME_NEW:=sinsera-node-1}"
KIOSK_URL="https://sinsera.co/vigil?wall=1&kiosk=1"
APPSRC=/opt/sinsera-node/app
export DEBIAN_FRONTEND=noninteractive
step(){ echo; echo "== $* =="; }

step "apt: cage+cog kiosk + Claude stack"
apt-get update -y
apt-get install -y --no-install-recommends \
  cage cog libseat1 \
  fonts-dejavu-core fonts-liberation ca-certificates curl \
  nodejs npm tmux git python3 python3-pip rfkill raspi-config iw dmz-cursor-theme

step "ttyd web terminal (arm64)"
curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.aarch64 && chmod +x /usr/local/bin/ttyd

step "Claude Code"
npm install -g @anthropic-ai/claude-code

step "locale + 1G swap + fan + HDMI hotplug (NO forced resolution — auto-detect)"
sed -i 's/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null; locale-gen 2>/dev/null; update-locale LANG=en_AU.UTF-8 2>/dev/null
sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile 2>/dev/null
BOOTDIR=/boot/firmware; [ -d "$BOOTDIR" ] || BOOTDIR=/boot
BOOTCFG="$BOOTDIR/config.txt"
if [ -f "$BOOTCFG" ] && ! grep -q "sinsera-node" "$BOOTCFG"; then
  printf '\n# sinsera-node — cage auto-detects the connected display (native res)\ndtparam=cooling_fan=on\nhdmi_force_hotplug=1\ndisable_overscan=1\n' >> "$BOOTCFG"
fi

step "mask first-boot wizard + disable cloud-init"
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

step "hostname ($HOSTNAME_NEW)"
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

step "transparent cursor (touch kiosk → no pointer arrow; cog ignores web cursor:none)"
python3 - <<'PY'
import struct, os
d = "/usr/share/icons/blank/cursors"; os.makedirs(d, exist_ok=True)
w = h = 32
data = (b'Xcur' + struct.pack('<3I',16,0x00010000,1) + struct.pack('<3I',0xfffd0002,32,28)
        + struct.pack('<9I',36,0xfffd0002,32,1,w,h,0,0,0) + b'\x00\x00\x00\x00'*(w*h))
open(d+"/left_ptr","wb").write(data)
for n in ["default","arrow","top_left_arrow","cursor","pointer","hand1","hand2","xterm","text","watch"]:
    p = d+"/"+n
    try: os.remove(p)
    except FileNotFoundError: pass
    os.symlink("left_ptr", p)
open("/usr/share/icons/blank/index.theme","w").write("[Icon Theme]\nName=blank\n")
# The system DEFAULT theme is what cog actually honours — it must inherit blank, or an arrow shows.
os.makedirs("/usr/share/icons/default", exist_ok=True)
open("/usr/share/icons/default/index.theme","w").write("[Icon Theme]\nName=Default\nInherits=blank\n")
PY

step "keep wifi awake — disable power-save (the classic Pi 'drops off the network' cause)"
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
systemctl enable wifi-powersave-off.service

step "kiosk user + tty1 autologin → cage+cog (sinsera.co)"
id kiosk >/dev/null 2>&1 || { useradd -m -s /bin/bash kiosk; passwd -l kiosk; }
for g in video audio input render tty seat plugdev netdev; do getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" kiosk; done
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<G1
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I \$TERM
G1
systemctl enable getty@tty1.service   # auto-start is unreliable on raspios → enable explicitly
# Auto-auth Vigil-wall launcher (signs the camera account in each boot, hands cog the
# session in the URL hash → cameras show zero-touch) + cache-bust + transparent cursor.
cp "$APPSRC"/sinsera-kiosk-launch.sh /usr/local/bin/sinsera-kiosk-launch.sh
chmod 755 /usr/local/bin/sinsera-kiosk-launch.sh
# Camera-account creds the launcher reads — MUST be kiosk-readable (the launcher runs as kiosk)
cat > /opt/sinsera-node/kiosk-auth.env <<KA
SUPABASE_URL=${SUPABASE_URL:-https://lkhtgkmivqwgnvzmjbhr.supabase.co}
SUPABASE_ANON_KEY=$ANON_KEY
VIGIL_EMAIL=$VIGIL_EMAIL
VIGIL_PASSWORD=$VIGIL_PASSWORD
KA
chown kiosk:kiosk /opt/sinsera-node/kiosk-auth.env; chmod 600 /opt/sinsera-node/kiosk-auth.env
cat > /home/kiosk/.bash_profile <<'BP'
if [[ "$(tty)" == "/dev/tty1" ]]; then
  while true; do /usr/local/bin/sinsera-kiosk-launch.sh; sleep 3; done
fi
BP
chown kiosk:kiosk /home/kiosk/.bash_profile
touch /var/log/sinsera-kiosk.log; chown kiosk:kiosk /var/log/sinsera-kiosk.log

step "Node status reporter — CPU/temp/RAM -> Supabase node_status (dashboard status bars)"
cp "$APPSRC"/node-status-reporter.sh /opt/sinsera-node/node-status-reporter.sh
chmod 755 /opt/sinsera-node/node-status-reporter.sh
cat > /etc/systemd/system/node-status-reporter.service <<'NSR'
[Unit]
Description=Node status reporter (CPU/temp/RAM -> Supabase node_status)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/opt/sinsera-node/node-status-reporter.sh
Restart=always
RestartSec=20
[Install]
WantedBy=multi-user.target
NSR
systemctl enable node-status-reporter.service 2>/dev/null

step "Claude on USB (tmux + ttyd) — builds off whatever USB is inserted"
cp "$APPSRC"/usb-mount.sh /usr/local/bin/; chmod 755 /usr/local/bin/usb-mount.sh
cp "$APPSRC"/usb-claude-launch.sh /usr/local/bin/; chmod 755 /usr/local/bin/usb-claude-launch.sh
touch /var/log/claude.log; chown peta:peta /var/log/claude.log
cat > /etc/systemd/system/claude-session.service <<CS
[Unit]
Description=Claude Code (USB build) persistent tmux session
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=peta
RemainAfterExit=yes
Environment=HOME=/home/peta
ExecStart=/usr/bin/tmux new-session -d -s claude /usr/local/bin/usb-claude-launch.sh
ExecStop=/usr/bin/tmux kill-session -t claude
[Install]
WantedBy=multi-user.target
CS
F=/home/peta/.ttyd-pass; openssl rand -hex 6 > "$F" 2>/dev/null || echo "node$RANDOM" > "$F"; chown peta:peta "$F"; chmod 600 "$F"; TPW=$(cat "$F")
cat > /etc/systemd/system/ttyd-claude.service <<TS
[Unit]
Description=ttyd web terminal -> Claude Code (USB build)
After=claude-session.service
Wants=claude-session.service
[Service]
User=peta
Environment=HOME=/home/peta
ExecStart=/usr/local/bin/ttyd -p 7681 -i 0.0.0.0 -W -c peta:$TPW /usr/bin/tmux attach -t claude
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
TS
systemctl enable claude-session.service ttyd-claude.service

step "Build Agent reporter → Supabase agent_status"
mkdir -p /opt/kiosk-agent
cp "$APPSRC"/agent-status-reporter.py /opt/kiosk-agent/
cat > /opt/kiosk-agent/.env <<AE
SUPABASE_URL=https://lkhtgkmivqwgnvzmjbhr.supabase.co
SUPABASE_ANON_KEY=$ANON_KEY
AE
chown -R peta:peta /opt/kiosk-agent; chmod 600 /opt/kiosk-agent/.env
cat > /etc/systemd/system/agent-status-reporter.service <<AR
[Unit]
Description=Claude -> Supabase agent_status reporter
After=network-online.target claude-session.service
Wants=network-online.target
[Service]
User=peta
Environment=HOME=/home/peta
Environment=AGENT_TMUX=claude
Environment=AGENT_NAME=$HOSTNAME_NEW
ExecStart=/usr/bin/python3 /opt/kiosk-agent/agent-status-reporter.py
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
AR
systemctl enable agent-status-reporter.service

step "AC600 (RTL8811AU) 5GHz wifi — first-boot driver install + wlan1 primary"
cp "$APPSRC"/ac600-firstboot.sh /usr/local/sbin/ac600-firstboot.sh; chmod 755 /usr/local/sbin/ac600-firstboot.sh
cat > /etc/systemd/system/ac600-firstboot.service <<AC
[Unit]
Description=AC600 driver install + wlan1 5GHz (runs first boot, self-disables on success)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ac600-firstboot.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
AC
systemctl enable ac600-firstboot.service

step "MOTD + done"
cat > /etc/motd <<M

  $HOSTNAME_NEW — Pi 5 8GB secondary · cage+cog → $KIOSK_URL (no cursor, auto-detect display)
  Claude builds off any inserted USB. SSH: peta@$HOSTNAME_NEW.local · ttyd :7681
  Sign in once: open ttyd or tty2, run \`claude login\`.
M
apt-get clean
echo "[sinsera-node install] DONE → $HOSTNAME_NEW"
