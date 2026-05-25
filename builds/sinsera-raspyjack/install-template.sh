#!/bin/bash
# Sinsera RaspyJack — Ark install plan.
#
# The chroot pipeline (modified chroot-run.sh) automatically copies
# any *.tar.gz file sitting next to this script into /boot/ on the
# .img. So if builds/sinsera-raspyjack/raspyjack-src.tar.gz exists,
# it'll appear at /boot/raspyjack-src.tar.gz on the SD card.
#
# This script just writes /boot/dietpi.txt + /boot/Automation_Custom_
# Script.sh. The Pi does the heavy work at first boot:
#   1) DietPi first-boot setup (~60 s, partition expands)
#   2) Automation_Custom_Script.sh extracts the tarball to
#      /opt/raspyjack/ + runs install_raspyjack.sh
#   3) reboot
#   4) operator SSH-keys in + launches /opt/raspyjack/raspyjack.py

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
[[ -z "$BOOT_DIR" ]] && { ark_log "ERROR: no boot partition"; exit 1; }
ark_log "boot partition: $BOOT_DIR"

# Confirm the tarball landed via chroot-run.sh's sibling-copy step.
# chroot-run.sh stages it at /opt/ark-extras/ in the rootfs (not the
# FAT32 boot partition which is too small for ~70 MB of source).
if [[ -f /opt/ark-extras/raspyjack-src.tar.gz ]]; then
  ark_log "✓ raspyjack-src.tar.gz present at /opt/ark-extras/: $(stat --printf='%s' /opt/ark-extras/raspyjack-src.tar.gz) bytes"
else
  ark_log "WARN: raspyjack-src.tar.gz NOT found at /opt/ark-extras/ — first boot will fall back to git clone"
fi

# ── /boot/dietpi.txt ──
if [[ -f "$BOOT_DIR/dietpi.txt" ]]; then
  ark_log "tuning $BOOT_DIR/dietpi.txt"
  set_dp() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$BOOT_DIR/dietpi.txt"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$BOOT_DIR/dietpi.txt"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$BOOT_DIR/dietpi.txt"
    fi
  }
  set_dp AUTO_SETUP_NET_HOSTNAME            'RaspyJack'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED        '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE   'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID           'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY            'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE                'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                  'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT         'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX        '-1'
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX  '1'    # console autologin
  set_dp AUTO_SETUP_AUTOSTART_LOGIN_USER    'root'
  set_dp SURVEY_OPTED_IN                    '0'
  set_dp AUTO_SETUP_ACCEPT_LICENSE          '1'
fi

# ── Bake operator's SSH public key into root's authorized_keys ──
ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# ── /boot/Automation_Custom_Script.sh — first-boot installer ──
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'RJ_FIRSTBOOT'
#!/bin/bash
# Sinsera RaspyJack — first-boot install.
# Runs at the end of DietPi's first-boot setup. Extracts the
# bundled RaspyJack source from the boot partition and runs its
# own install_raspyjack.sh.
set -e
exec > >(tee -a /var/log/sinsera-raspyjack-firstboot.log) 2>&1
echo "[sinsera-raspyjack] starting first-boot install $(date)"

# Boot partition on a Pi is either /boot/firmware (recent) or /boot.
BOOT=""
for cand in /boot/firmware /boot; do
  [[ -f "$cand/dietpi.txt" || -f "$cand/cmdline.txt" ]] && BOOT="$cand" && break
done
[[ -z "$BOOT" ]] && { echo "ERROR: no boot dir"; exit 1; }
echo "[sinsera-raspyjack] boot: $BOOT"

mkdir -p /opt/raspyjack
cd /opt/raspyjack

# chroot-run.sh stages the bundled tarball into /opt/ark-extras/ at
# build time. Older builds put it on the boot partition — check both
# for backwards compat.
SRC_TAR=""
for cand in /opt/ark-extras/raspyjack-src.tar.gz "$BOOT/raspyjack-src.tar.gz"; do
  [[ -f "$cand" ]] && SRC_TAR="$cand" && break
done
if [ -n "$SRC_TAR" ]; then
  echo "[sinsera-raspyjack] extracting bundled source tarball: $SRC_TAR"
  tar -xzf "$SRC_TAR" -C /opt/raspyjack
  # Keep a copy in /var/lib for reinstall; remove the build-time stash.
  mkdir -p /var/lib/raspyjack
  mv "$SRC_TAR" /var/lib/raspyjack/source.tar.gz
else
  echo "[sinsera-raspyjack] no bundled tarball; falling back to upstream git clone"
  apt-get install -y --no-install-recommends git
  git clone --depth=1 https://github.com/7h30th3r0n3/Raspyjack /opt/raspyjack-tmp
  mv /opt/raspyjack-tmp/* /opt/raspyjack/
  mv /opt/raspyjack-tmp/.* /opt/raspyjack/ 2>/dev/null || true
  rmdir /opt/raspyjack-tmp
fi

# Mirror the SSH key Ark baked for root onto the dietpi + pi users
# (whichever exists at this point post-DietPi-first-boot).
for user in dietpi pi; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    install -d -o "$user" -g "$user" -m 700 "$home/.ssh"
    install -o "$user" -g "$user" -m 600 /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
    echo "[sinsera-raspyjack] SSH key mirrored to $user"
  fi
done

cd /opt/raspyjack
if [ -x install_raspyjack.sh ] || [ -f install_raspyjack.sh ]; then
  chmod +x install_raspyjack.sh
  echo "[sinsera-raspyjack] running RaspyJack's installer (non-interactive)"
  # RaspyJack's installer may prompt; we provide common defaults via
  # piped 'y' answers. If install_raspyjack.sh needs different input
  # the operator should ssh in and run it manually.
  yes y 2>/dev/null | bash install_raspyjack.sh || {
    echo "[sinsera-raspyjack] install_raspyjack.sh exited non-zero"
    echo "[sinsera-raspyjack] SSH in and run it manually: cd /opt/raspyjack && bash install_raspyjack.sh"
  }
else
  echo "[sinsera-raspyjack] no install_raspyjack.sh found at /opt/raspyjack/"
  ls /opt/raspyjack/ | head -20
fi

cat >> /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Sinsera RaspyJack                                            ║
  ║                                                               ║
  ║  Source at /opt/raspyjack/                                    ║
  ║  Re-run installer:  cd /opt/raspyjack && bash install_*.sh    ║
  ║  Launch local UI:   python3 /opt/raspyjack/raspyjack.py       ║
  ║                                                               ║
  ║  Drive defensive scripts from Ark on your Mac:                ║
  ║    https://sinsera.co/ark/#security/raspyjack                 ║
  ║  (First register this Pi in Ark → SSH Runner)                 ║
  ║                                                               ║
  ║  Use only on hardware you own + networks you have permission ║
  ║  to test.                                                     ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

echo "[sinsera-raspyjack] first-boot install complete $(date)"
RJ_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# ── Registry marker ──
printf '{"name":"sinsera-raspyjack","version":"1","installed_at":"%s","profile":"sinsera-raspyjack","strategy":"first-boot-install","source":"local:~/Downloads/Jack/"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-raspyjack.json
ark_log "registered sinsera-raspyjack"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera RaspyJack image baked."
ark_log "  ONE thing before flashing: edit /boot/dietpi.txt and replace"
ark_log "    AUTO_SETUP_NET_WIFI_SSID=REPLACE_WITH_YOUR_SSID"
ark_log "    AUTO_SETUP_NET_WIFI_KEY=REPLACE_WITH_YOUR_WIFI_PASSWORD"
ark_log "  Then power on. First boot ~5-10 min (RaspyJack installer)."
ark_log "  Then: ssh root@RaspyJack.local (key-based, no password)"
ark_log "================================================================"
exit 0
