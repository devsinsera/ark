#!/bin/bash
# install.sh — Node 5 (GR86 in-car Pi) provisioner. Runs INSIDE the chroot during
# the bake (node5-bake.sh stages this + app/ + secrets.env to /opt/node5, then
# `chroot ... /opt/node5/install.sh`). Idempotent: re-running is safe.
#
# Applies: hostname node5 · peta SSH-key user + fleet key · headless (gpu_mem=16)
# · USB WiFi/BT dongle firmware + rfkill-unblock · NetworkManager AP + priority
# uplinks · garage-pi-bridge OBD logger (.env baked) · node-status/command fleet
# reporters · local-first HUD stub · store-and-forward timer -> Node 3 · idle
# -shutdown stub · Tailscale first-boot installer (no secret baked).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

ROOT=/opt/node5
APPSRC="$ROOT/app"
SEC="$ROOT/secrets.env"
[ -f "$SEC" ] && { set -a; . "$SEC"; set +a; }

# --- defaults / placeholders (secrets.env overrides) ------------------------
: "${SSH_PUBKEY:=}"
: "${ANON_KEY:=}"
: "${SUPABASE_URL:=https://lkhtgkmivqwgnvzmjbhr.supabase.co}"
: "${VIGIL_EMAIL:=peta.stockdale@outlook.com}"
: "${VIGIL_PASSWORD:=}"
: "${OWNER_ID:=82e75fd1-7878-45f5-9760-ba0af6838a3d}"
: "${CAR_ID:=}"
: "${OBDLINK_MAC:=}"
: "${AP_SSID:=Sinsera-GR86}"
: "${AP_PSK:=CHANGE-ME-AP-PASSPHRASE}"
: "${HOME_SSID:=}"      ; : "${HOME_PSK:=}"
: "${IPHONE_SSID:=}"    ; : "${IPHONE_PSK:=}"
: "${WIFI_COUNTRY:=AU}"
: "${HOSTNAME_NEW:=node5}"

step(){ echo "" ; echo "== [node5-install] $* ==" ; }

step "apt — python/venv, bluetooth, NetworkManager, rsync, USB-dongle firmware"
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-venv python3-requests \
  bluetooth bluez bluez-tools libglib2.0-dev \
  network-manager rfkill rsync curl ca-certificates \
  fonts-dejavu-core
# Firmware for the USB dongles (TP-Link AX1300 = MediaTek mt76 / some Realtek
# rtl88xx; Ugreen BT 6.0 = generic BT USB). Package names vary by repo — try all,
# never fail the bake if a repo lacks one (verify on the real Pi).
apt-get install -y --no-install-recommends \
  firmware-misc-nonfree firmware-realtek firmware-atheros firmware-brcm80211 \
  2>/dev/null || echo "[node5-install] some firmware packages unavailable — verify dongle drivers on the Pi"

step "hostname -> $HOSTNAME_NEW"
echo "$HOSTNAME_NEW" > /etc/hostname
sed -i "s/127.0.1.1.*/127.0.1.1\t${HOSTNAME_NEW}/g" /etc/hosts || true

step "mask the first-boot user wizard (headless, no display)"
systemctl disable userconfig.service 2>/dev/null || true; systemctl mask userconfig.service 2>/dev/null || true
systemctl disable userconf.service 2>/dev/null || true; systemctl mask userconf.service 2>/dev/null || true
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null || true

step "locale + swap"
sed -i "s/^# *en_AU.UTF-8 UTF-8/en_AU.UTF-8 UTF-8/" /etc/locale.gen 2>/dev/null || true
locale-gen 2>/dev/null || true; update-locale LANG=en_AU.UTF-8 2>/dev/null || true
sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/" /etc/dphys-swapfile 2>/dev/null || true

step "peta user (SSH-key only, NOPASSWD sudo) + fleet key"
if ! id peta >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G adm,dialout,cdrom,sudo,audio,video,plugdev,games,users,input,render,netdev,gpio,i2c,spi peta
fi
passwd -l peta 2>/dev/null || true
echo "peta ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_peta-nopasswd
chmod 440 /etc/sudoers.d/010_peta-nopasswd
mkdir -p /home/peta/.ssh && chmod 700 /home/peta/.ssh
if [ -n "$SSH_PUBKEY" ]; then
  printf '%s\n' "$SSH_PUBKEY" > /home/peta/.ssh/authorized_keys
  chmod 600 /home/peta/.ssh/authorized_keys
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  printf '%s\n' "$SSH_PUBKEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi
# store-and-forward needs a key to reach Node 3 (peta@192.168.4.182). Generate an
# unattended one if absent; its .pub must be added to Node 3's authorized_keys
# post-boot (README). Never overwrite an existing key.
if [ ! -f /home/peta/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -C "node5-store-forward" -f /home/peta/.ssh/id_ed25519 >/dev/null 2>&1 || true
fi
chown -R peta:peta /home/peta/.ssh
systemctl enable ssh 2>/dev/null || true

step "headless: gpu_mem=16 (no display)"
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ] && ! grep -q "node5 (headless)" "$BOOTCFG"; then
  printf "\n# node5 (headless)\ngpu_mem=16\n" >> "$BOOTCFG"
fi

step "NetworkManager: AP (Sinsera-GR86) + priority uplinks (home > iphone > car)"
systemctl enable NetworkManager 2>/dev/null || true
NMDIR=/etc/NetworkManager/system-connections
mkdir -p "$NMDIR"
for f in ap-sinsera-gr86 uplink-home-wifi uplink-iphone-hotspot uplink-car-wifi; do
  if [ -f "$APPSRC/$f.nmconnection" ]; then
    cp "$APPSRC/$f.nmconnection" "$NMDIR/$f.nmconnection"
    chmod 600 "$NMDIR/$f.nmconnection"
  fi
done
# Substitute baked SSID/PSK values into the profiles when provided (else the
# CHANGE-ME placeholders remain for the user to edit).
[ -n "$AP_SSID" ]     && sed -i "s/^ssid=Sinsera-GR86/ssid=${AP_SSID}/"                 "$NMDIR/ap-sinsera-gr86.nmconnection"       2>/dev/null || true
[ "$AP_PSK" != "CHANGE-ME-AP-PASSPHRASE" ] && sed -i "s/^psk=CHANGE-ME-AP-PASSPHRASE/psk=${AP_PSK}/" "$NMDIR/ap-sinsera-gr86.nmconnection" 2>/dev/null || true
[ -n "$HOME_SSID" ]   && sed -i "s/^ssid=CHANGE-ME-HOME-SSID/ssid=${HOME_SSID}/"        "$NMDIR/uplink-home-wifi.nmconnection"      2>/dev/null || true
[ -n "$HOME_PSK" ]    && sed -i "s/^psk=CHANGE-ME-HOME-PSK/psk=${HOME_PSK}/"             "$NMDIR/uplink-home-wifi.nmconnection"      2>/dev/null || true
[ -n "$IPHONE_SSID" ] && sed -i "s/^ssid=CHANGE-ME-IPHONE-SSID/ssid=${IPHONE_SSID}/"    "$NMDIR/uplink-iphone-hotspot.nmconnection" 2>/dev/null || true
[ -n "$IPHONE_PSK" ]  && sed -i "s/^psk=CHANGE-ME-IPHONE-PSK/psk=${IPHONE_PSK}/"         "$NMDIR/uplink-iphone-hotspot.nmconnection" 2>/dev/null || true

step "WiFi country + rfkill-unblock boot service (needed for the USB radios)"
raspi-config nonint do_wifi_country "$WIFI_COUNTRY" 2>/dev/null || true
mkdir -p /usr/local/sbin
cat > /usr/local/sbin/node5-wifi-unblock.sh <<WUB
#!/bin/bash
raspi-config nonint do_wifi_country ${WIFI_COUNTRY} 2>/dev/null || true
rfkill unblock all 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
exit 0
WUB
chmod +x /usr/local/sbin/node5-wifi-unblock.sh
cat > /etc/systemd/system/node5-wifi-unblock.service <<'WUS'
[Unit]
Description=Unblock WiFi/BT (rfkill) + set WLAN country for Node 5 USB radios
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/node5-wifi-unblock.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
WUS
systemctl enable node5-wifi-unblock.service 2>/dev/null || true
systemctl enable bluetooth 2>/dev/null || true

step "garage-pi-bridge OBD logger -> /opt/garage-pi-bridge (+ venv + .env baked)"
mkdir -p /opt/garage-pi-bridge
cp "$APPSRC/bridge.py" "$APPSRC/obd_pids.py" "$APPSRC/requirements.txt" /opt/garage-pi-bridge/
if [ ! -d /opt/garage-pi-bridge/.venv ]; then
  python3 -m venv /opt/garage-pi-bridge/.venv
fi
/opt/garage-pi-bridge/.venv/bin/pip install --quiet --upgrade pip 2>/dev/null || true
/opt/garage-pi-bridge/.venv/bin/pip install --quiet -r /opt/garage-pi-bridge/requirements.txt 2>/dev/null \
  || echo "[node5-install] pip (bleak/aiohttp) failed in chroot — will resolve on first network boot"
# Bake the .env from the template, then fill the values we know. SUPABASE_PASSWORD
# + CAR_ID + OBDLINK_MAC stay as placeholders unless secrets.env supplied them.
cp "$APPSRC/.env.template" /opt/garage-pi-bridge/.env
sed -i "s|^SUPABASE_URL=.*|SUPABASE_URL=${SUPABASE_URL}|"                 /opt/garage-pi-bridge/.env
sed -i "s|^SUPABASE_ANON_KEY=.*|SUPABASE_ANON_KEY=${ANON_KEY}|"           /opt/garage-pi-bridge/.env
sed -i "s|^SUPABASE_EMAIL=.*|SUPABASE_EMAIL=${VIGIL_EMAIL}|"              /opt/garage-pi-bridge/.env
sed -i "s|^SUPABASE_PASSWORD=.*|SUPABASE_PASSWORD=${VIGIL_PASSWORD}|"     /opt/garage-pi-bridge/.env
sed -i "s|^OWNER_ID=.*|OWNER_ID=${OWNER_ID}|"                            /opt/garage-pi-bridge/.env
[ -n "$CAR_ID" ]      && sed -i "s|^CAR_ID=.*|CAR_ID=${CAR_ID}|"           /opt/garage-pi-bridge/.env
[ -n "$OBDLINK_MAC" ] && sed -i "s|^OBDLINK_MAC=.*|OBDLINK_MAC=${OBDLINK_MAC}|" /opt/garage-pi-bridge/.env
chmod 600 /opt/garage-pi-bridge/.env
cp "$APPSRC/garage-obd-bridge.service" /etc/systemd/system/garage-obd-bridge.service
systemctl enable garage-obd-bridge.service 2>/dev/null || true

step "fleet reporters -> /opt/sinsera-node (node_status + node_commands)"
mkdir -p /opt/sinsera-node
cp "$APPSRC/node-status-reporter.sh"  /opt/sinsera-node/node-status-reporter.sh
cp "$APPSRC/node-command-runner.sh"   /opt/sinsera-node/node-command-runner.sh
chmod 755 /opt/sinsera-node/node-status-reporter.sh /opt/sinsera-node/node-command-runner.sh
# The reporters read camera-account creds from this file (same pattern as the kiosk nodes).
cat > /opt/sinsera-node/kiosk-auth.env <<KA
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${ANON_KEY}
VIGIL_EMAIL=${VIGIL_EMAIL}
VIGIL_PASSWORD=${VIGIL_PASSWORD}
KA
chmod 600 /opt/sinsera-node/kiosk-auth.env
cp "$APPSRC/node-status-reporter.service" /etc/systemd/system/node-status-reporter.service
cp "$APPSRC/node-command-runner.service"  /etc/systemd/system/node-command-runner.service
systemctl enable node-status-reporter.service 2>/dev/null || true
systemctl enable node-command-runner.service  2>/dev/null || true

step "local-first HUD server -> /opt/gr86-hud (:8080)"
mkdir -p /opt/gr86-hud
cp "$APPSRC/hud-server.py" /opt/gr86-hud/hud-server.py
chmod 755 /opt/gr86-hud/hud-server.py
cat > /opt/gr86-hud/hud.env <<HE
HUD_PORT=8080
GR86_CAR_UUID=${CAR_ID}
HE
chmod 600 /opt/gr86-hud/hud.env
chown -R peta:peta /opt/gr86-hud
cp "$APPSRC/gr86-hud.service" /etc/systemd/system/gr86-hud.service
systemctl enable gr86-hud.service 2>/dev/null || true

step "store-and-forward (rsync OBD buffer -> Node 3) + idle-shutdown stub"
mkdir -p /opt/gr86 /var/lib/garage-obd/buffer
cp "$APPSRC/store-forward.sh"  /opt/gr86/store-forward.sh
cp "$APPSRC/idle-shutdown.sh"  /opt/gr86/idle-shutdown.sh
chmod 755 /opt/gr86/store-forward.sh /opt/gr86/idle-shutdown.sh
chown -R peta:peta /var/lib/garage-obd
cp "$APPSRC/gr86-store-forward.service" /etc/systemd/system/gr86-store-forward.service
cp "$APPSRC/gr86-store-forward.timer"   /etc/systemd/system/gr86-store-forward.timer
cp "$APPSRC/gr86-idle-shutdown.service" /etc/systemd/system/gr86-idle-shutdown.service
cp "$APPSRC/gr86-idle-shutdown.timer"   /etc/systemd/system/gr86-idle-shutdown.timer
systemctl enable gr86-store-forward.timer 2>/dev/null || true
systemctl enable gr86-idle-shutdown.timer 2>/dev/null || true

step "Tailscale first-boot installer (no authkey baked)"
cp "$APPSRC/tailscale-firstboot.sh" /opt/gr86/tailscale-firstboot.sh
chmod 755 /opt/gr86/tailscale-firstboot.sh
cp "$APPSRC/gr86-tailscale-install.service" /etc/systemd/system/gr86-tailscale-install.service
systemctl enable gr86-tailscale-install.service 2>/dev/null || true

step "SD-corruption guard — documented overlayfs toggle (left OFF by default)"
# Read-only root would protect the SD from hard 12V cuts, BUT it makes the OBD
# store-and-forward buffer non-persistent. Left OFF; enable deliberately with:
#   sudo raspi-config nonint enable_overlayfs   (then reboot)
# The idle-shutdown stub (clean poweroff on ignition-off) is the interim guard.
cat > /opt/gr86/enable-overlayfs.sh <<'OFS'
#!/bin/bash
# Turn the rootfs read-only (SD-corruption guard). Do this only AFTER the OBD
# buffer is moved to a USB SSD, or the buffer won't persist across reboots.
raspi-config nonint enable_overlayfs && echo "overlayfs enabled — reboot to apply"
OFS
chmod 755 /opt/gr86/enable-overlayfs.sh

step "MOTD"
cat > /etc/motd <<MOTD

  NODE 5 — GR86 in-car Pi (Pi 5 2GB, HEADLESS)
  OBD:    garage-obd-bridge.service  (fill OBDLINK_MAC + CAR_ID + password in /opt/garage-pi-bridge/.env)
  AP:     Sinsera-GR86  ·  HUD: http://node5.local:8080  (iPad connects to the Pi AP)
  Fleet:  shows as node5 on the Nodes page  ·  reboot/poweroff from Kiosks
  Remote: sudo tailscale up --ssh --hostname node5   (join the tailnet)
  SSH:    peta@node5.local
MOTD

apt-get clean 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true
echo "" ; echo "[node5-install] DONE"
