// Ark output generators — consume a Device Manifest, emit the text
// files DietPi needs to install + configure itself unattended.
//
// Phase 1 outputs:
//   - dietpi.txt
//   - Automation_Custom_Script.sh
//
// Both are pure functions: (manifest) -> string. The UI passes the
// result straight into a Blob for download.

function ts() { return new Date().toISOString(); }

export function dietpiTxt(m) {
  const headless = m.identity.role === 'headless' || m.software.boot_target === 'headless';

  const wifi = m.network.wifi_ssid
    ? `AUTO_SETUP_NET_WIFI_ENABLED=1
AUTO_SETUP_NET_WIFI_COUNTRY_CODE=AU
AUTO_SETUP_NET_WIFI_SSID=${m.network.wifi_ssid}
AUTO_SETUP_NET_WIFI_KEY=${m.network.wifi_password || ''}`
    : `AUTO_SETUP_NET_WIFI_ENABLED=0`;

  // DietPi software IDs we ask for:
  //   113 = Chromium
  //   23  = LXDE desktop
  // We omit both when headless. Boot option 11 (custom script) runs
  // Automation_Custom_Script.sh regardless.
  const softwareLines = headless
    ? '# Headless mode — no Chromium, no LXDE.'
    : `AUTO_SETUP_INSTALL_SOFTWARE_ID=113
AUTO_SETUP_INSTALL_SOFTWARE_ID=23`;

  return `# Ark — generated ${ts()}
# Manifest: ${m.identity.name} (role=${m.identity.role}, model=${m.hardware.model})
#
# Drop this file alongside Automation_Custom_Script.sh in the FAT32
# boot partition of a stock DietPi SD card. The Pi runs through this
# unattended on first boot.

AUTO_SETUP_LOCALE=en_AU.UTF-8
AUTO_SETUP_KEYBOARD_LAYOUT=au
AUTO_SETUP_TIMEZONE=${m.software.timezone}
AUTO_SETUP_HEADLESS=${headless ? 1 : 0}
AUTO_SETUP_ACCEPT_LICENSE=1
AUTO_SETUP_AUTOMATED=1
AUTO_SETUP_NET_HOSTNAME=${m.network.hostname}

# Root + global password (also used for the 'dietpi' user).
AUTO_SETUP_GLOBAL_PASSWORD=${m.software.root_password}

${wifi}

# Software auto-install.
${softwareLines}

# Autostart: boot option 11 = "Custom script" — runs the file
# Automation_Custom_Script.sh as root once after install completes.
AUTO_SETUP_AUTOSTART_TARGET_INDEX=11

# Privacy: don't phone home to DietPi.
SURVEY_OPTED_IN=0

AUTO_SETUP_NET_USESTATIC=0

# Kiosk URL — read by Automation_Custom_Script.sh below.
SOFTWARE_CHROMIUM_AUTOSTART_URL=${m.kiosk.url || ''}
SOFTWARE_CHROMIUM_RES_X=1920
SOFTWARE_CHROMIUM_RES_Y=1080
`;
}


export function automationScript(m) {
  const headless = m.identity.role === 'headless' || m.software.boot_target === 'headless';

  const sshKeysBlock = (m.network.ssh_pubkeys && m.network.ssh_pubkeys.length > 0)
    ? `
# Install authorized_keys for root so the user can SSH in without a
# password. Manifest contributes ${m.network.ssh_pubkeys.length} key(s).
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'KEYS'
${m.network.ssh_pubkeys.join('\n')}
KEYS
chmod 600 /root/.ssh/authorized_keys
systemctl enable ssh 2>/dev/null || true
systemctl restart ssh 2>/dev/null || true
`
    : '';

  if (headless) {
    return `#!/usr/bin/env bash
# Ark — generated ${ts()}
# Manifest: ${m.identity.name} (HEADLESS — role=${m.identity.role})
#
# Runs once on first boot after DietPi's software install.
# Headless variant: no Chromium / no display setup; only the
# non-display parts of the manifest apply.

set -euo pipefail
${sshKeysBlock}
echo "Ark headless setup complete — manifest ${m.identity.name}."
`;
  }

  // GUI / kiosk path
  const blankCmd  = m.kiosk.disable_blanking ? `
# Disable screen blanking + DPMS so the kiosk stays lit forever.
xset -dpms s off s noblank >/dev/null 2>&1 || true
` : '';

  const cursorCmd = m.kiosk.hide_cursor ? `
# Hide the mouse cursor when idle.
apt-get install -y unclutter >/dev/null
` : '';

  const rotationCmd = m.kiosk.rotation && m.kiosk.rotation !== 'normal'
    ? `
# Rotate display (${m.kiosk.rotation}).
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/40-rotate.conf <<XORG
Section "Monitor"
  Identifier "HDMI-1"
  Option "Rotate" "${m.kiosk.rotation}"
EndSection
XORG
`
    : '';

  const refreshCmd = m.kiosk.auto_reload_min > 0
    ? `
# Auto-reload Chromium every ${m.kiosk.auto_reload_min} minutes — useful
# for dashboards that might lose a websocket.
apt-get install -y xdotool >/dev/null
(crontab -l 2>/dev/null; echo "*/${m.kiosk.auto_reload_min} * * * * DISPLAY=:0 xdotool key F5 >/dev/null 2>&1") | crontab -
`
    : '';

  return `#!/usr/bin/env bash
# Ark — generated ${ts()}
# Manifest: ${m.identity.name} (role=${m.identity.role})
#
# Runs once on first boot after DietPi's software install. Idempotent.

set -euo pipefail
${sshKeysBlock}${cursorCmd}${blankCmd}${rotationCmd}${refreshCmd}
# Write the kiosk autostart file. DietPi's "Custom script" preset
# (AUTO_SETUP_AUTOSTART_TARGET_INDEX=11) reads custom.sh on boot.
mkdir -p /var/lib/dietpi/dietpi-autostart
cat > /var/lib/dietpi/dietpi-autostart/custom.sh <<'KIOSK'
#!/usr/bin/env bash
# Wait for display server.
while ! pgrep -x Xorg >/dev/null 2>&1 && ! pgrep -x Xwayland >/dev/null 2>&1; do
  sleep 1
done
export DISPLAY=\${DISPLAY:-:0}
${m.kiosk.hide_cursor ? 'unclutter -idle 0 -root &\n' : ''}
chromium-browser \\
  ${m.kiosk.fullscreen ? '--kiosk \\\n  ' : ''}--noerrdialogs \\
  --disable-infobars \\
  --disable-translate \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --no-first-run \\
  --start-fullscreen \\
  --start-maximized \\
  --user-data-dir=/var/lib/chromium-kiosk \\
  ${m.kiosk.url}
KIOSK
chmod +x /var/lib/dietpi/dietpi-autostart/custom.sh

echo "Ark setup complete — manifest ${m.identity.name}. Reboot to launch."
`;
}
