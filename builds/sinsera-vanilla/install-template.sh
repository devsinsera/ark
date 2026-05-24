#!/bin/bash
# Sinsera Vanilla DietPi — bakes personal config into the image so a
# freshly-flashed Pi boots straight into a fully-configured DietPi
# install: WiFi (after placeholder fill-in), SSH key auth, correct
# timezone + locale, normal console login (no kiosk autolaunch).
#
# Runs in the chroot during the Ark image build. Pure file writes —
# fast (~30 s) and uses no extra disk space since no apt-install
# runs. All the heavy lifting happens at first boot via DietPi's
# normal first-boot setup.

set -e
set -o pipefail
LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/registry
ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ── Find boot partition ──
BOOT_DIR=""
for cand in /boot/firmware /boot; do
  if [[ -d "$cand" ]] && [[ -f "$cand/cmdline.txt" || -f "$cand/dietpi.txt" || -f "$cand/config.txt" ]]; then
    BOOT_DIR="$cand"; break
  fi
done
[[ -z "$BOOT_DIR" ]] && { ark_log "ERROR: no boot partition in chroot"; exit 1; }
ark_log "boot partition: $BOOT_DIR"

# ── /boot/dietpi.txt — personal config ──
if [[ -f "$BOOT_DIR/dietpi.txt" ]]; then
  ark_log "configuring $BOOT_DIR/dietpi.txt"
  # Use a function so each edit either updates an existing line OR
  # appends if the key isn't present (some DietPi versions omit keys).
  set_dietpi() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$BOOT_DIR/dietpi.txt"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$BOOT_DIR/dietpi.txt"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$BOOT_DIR/dietpi.txt"
    fi
  }

  set_dietpi AUTO_SETUP_NET_HOSTNAME       'SinseraCore'
  set_dietpi AUTO_SETUP_NET_WIFI_ENABLED   '1'
  set_dietpi AUTO_SETUP_NET_WIFI_COUNTRY_CODE 'AU'
  set_dietpi AUTO_SETUP_NET_WIFI_SSID      'REPLACE_WITH_YOUR_SSID'
  set_dietpi AUTO_SETUP_NET_WIFI_KEY       'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dietpi AUTO_SETUP_TIMEZONE           'Australia/Sydney'
  set_dietpi AUTO_SETUP_LOCALE             'en_AU.UTF-8'
  set_dietpi AUTO_SETUP_KEYBOARD_LAYOUT    'au'
  set_dietpi AUTO_SETUP_SSH_SERVER_INDEX   '-1'    # -1 = OpenSSH (vs dropbear)
  set_dietpi AUTO_SETUP_AUTOSTART_TARGET_INDEX '0' # 0 = normal console login
  set_dietpi AUTO_SETUP_AUTOSTART_LOGIN_USER 'root'
  set_dietpi SURVEY_OPTED_IN               '0'
  set_dietpi AUTO_SETUP_ACCEPT_LICENSE     '1'
fi

# ── Pre-bake the operator's SSH public key for key-based login ──
# Embedded at build time from ~/.ssh/id_ed25519.pub on the Mac running
# the Ark builder. The chroot writes it to root's authorized_keys so
# `ssh root@SinseraCore.local` works the moment the Pi finishes its
# first boot. Password auth is also enabled (DietPi default) as a
# fallback.
ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# Also push a /boot/Automation_Custom_Script.sh that re-applies the
# key to the 'dietpi' user once that user is created on first boot
# (DietPi creates the dietpi user after this chroot's writes), and
# adds the same key to the pi user if one exists.
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'FIRSTBOOT'
#!/bin/bash
# Copy the root SSH key to dietpi + pi users so any of them can log
# in. Idempotent — safe to re-run.
set -e
exec > >(tee -a /var/log/sinsera-vanilla-firstboot.log) 2>&1
echo "[sinsera-vanilla] first-boot setup $(date)"

for user in dietpi pi; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    mkdir -p "$home/.ssh"
    chmod 700 "$home/.ssh"
    cp /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
    chmod 600 "$home/.ssh/authorized_keys"
    chown -R "$user:$user" "$home/.ssh"
    echo "[sinsera-vanilla] SSH key installed for $user"
  fi
done

echo "[sinsera-vanilla] done — SSH in with: ssh root@SinseraCore.local (or dietpi/pi)"
FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# ── Registry marker ──
printf '{"name":"sinsera-vanilla","version":"1","installed_at":"%s","profile":"sinsera-vanilla","strategy":"prebaked-config"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-vanilla.json
ark_log "registered sinsera-vanilla"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Vanilla DietPi image baked."
ark_log ""
ark_log "  After flashing — ONE thing to do before booting:"
ark_log "    Open the SD card on your Mac. Find /boot/dietpi.txt."
ark_log "    Replace these two lines with your real WiFi creds:"
ark_log "      AUTO_SETUP_NET_WIFI_SSID=REPLACE_WITH_YOUR_SSID"
ark_log "      AUTO_SETUP_NET_WIFI_KEY=REPLACE_WITH_YOUR_WIFI_PASSWORD"
ark_log "    Save, eject, insert into Pi, power on."
ark_log ""
ark_log "  After ~60 s first boot:"
ark_log "    ssh root@SinseraCore.local       (key-based — no password)"
ark_log ""
ark_log "  Already preconfigured: hostname, AU locale + timezone,"
ark_log "    OpenSSH, your ed25519 public key, normal console login."
ark_log "================================================================"
exit 0
