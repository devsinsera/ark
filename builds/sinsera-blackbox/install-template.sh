#!/bin/bash
# Sinsera Blackbox — Ark install plan.
#
# Combines two profiles onto one Pi Zero 2 W:
#   - sinsera-raspyjack: standalone LCD-driven recon toolkit, runs on
#     the Pi itself, uses Pi's WiFi + BT
#   - sinsera-flipper:   bridge to an external Flipper Zero plugged
#     into USB (defensive READ-ONLY allow-list)
#
# Both share the same DietPi base + WiFi + SSH key. No GPIO conflict —
# RaspyJack uses SPI + ~7 GPIO for the LCD HAT; the Flipper connects
# via USB and is invisible to the GPIO header.

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

# Confirm the RaspyJack tarball landed via chroot-run.sh's sibling-copy.
if [[ -f /opt/ark-extras/raspyjack-src.tar.gz ]]; then
  ark_log "✓ raspyjack-src.tar.gz present at /opt/ark-extras/: $(stat --printf='%s' /opt/ark-extras/raspyjack-src.tar.gz) bytes"
else
  ark_log "WARN: raspyjack-src.tar.gz NOT found at /opt/ark-extras/ — first boot will fall back to git clone"
fi

# ── /boot/dietpi.txt: WiFi + SSH + autologin ──
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
  set_dp AUTO_SETUP_NET_HOSTNAME            'SinseraBlackbox'
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

# ── SSH public key (root) ──
ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# ── Stage Flipper bridge at /opt/flipper/ (created at first boot) ──
ark_log "staging Flipper bridge for first-boot install"
mkdir -p /opt/sinsera-blackbox
cat > /opt/sinsera-blackbox/flipper-bridge.py <<'FLIPPER_PY'
#!/usr/bin/env python3
"""Sinsera Flipper Companion — defensive bridge.

Talks to a Flipper Zero over USB serial (/dev/flipper symlink, or
/dev/ttyACM0 fallback) and exposes READ-ONLY commands. Designed to
be invoked by the Ark Hub's SSH Runner from the Can't Phish Here →
Flipper tab.

Allow-list (READ_ONLY) — refuses anything not in this map. Transmit
operations (sub-GHz TX, BadUSB, NFC emulation, IR TX) stay on the
Flipper's physical UI, never via this bridge.
"""
import argparse, json, sys, time, glob, os

try:
    import serial
except ImportError:
    print(json.dumps({"ok": False, "error": "pyserial not installed. run: pip3 install pyserial"}))
    sys.exit(2)

def find_flipper():
    for p in ['/dev/flipper', '/dev/ttyACM0', '/dev/ttyACM1']:
        if os.path.exists(p): return p
    candidates = sorted(glob.glob('/dev/ttyACM*'))
    return candidates[0] if candidates else None

def open_flipper(timeout=4.0):
    path = find_flipper()
    if not path:
        raise RuntimeError("no Flipper found at /dev/flipper or /dev/ttyACM*. Plug it in + check USB.")
    ser = serial.Serial(path, baudrate=115200, timeout=timeout)
    time.sleep(0.2)
    ser.reset_input_buffer()
    return ser, path

def send_cli(ser, cmd, settle=1.5):
    ser.write((cmd + '\r\n').encode())
    deadline = time.time() + settle
    buf = bytearray()
    while time.time() < deadline:
        chunk = ser.read(4096)
        if chunk:
            buf.extend(chunk)
            deadline = time.time() + 0.4
        else:
            time.sleep(0.05)
    return buf.decode(errors='replace').strip()

READ_ONLY = {
    'info':          'device_info',
    'ble-scan':      'ble scan',
    'subghz-listen': 'subghz rx',
    'nfc-detect':    'nfc detect',
    'power':         'power_info',
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=list(READ_ONLY.keys()) + ['list'])
    ap.add_argument('--timeout', type=float, default=8.0,
                    help='seconds to read response (sub-ghz listen wants longer)')
    args = ap.parse_args()

    if args.command == 'list':
        print(json.dumps({'ok': True, 'commands': list(READ_ONLY.keys())}, indent=2))
        return

    cli_cmd = READ_ONLY[args.command]
    try:
        ser, path = open_flipper(timeout=args.timeout)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(1)

    try:
        resp = send_cli(ser, cli_cmd, settle=args.timeout)
        print(json.dumps({
            'ok': True,
            'command': args.command,
            'cli_sent': cli_cmd,
            'device_path': path,
            'response': resp,
            'response_lines': len(resp.splitlines()),
        }, indent=2))
    finally:
        try: ser.close()
        except: pass

if __name__ == '__main__':
    main()
FLIPPER_PY
chmod +x /opt/sinsera-blackbox/flipper-bridge.py

# Stage the udev rule too — first-boot copies it into place.
cat > /opt/sinsera-blackbox/99-flipper.rules <<'UDEV'
# Flipper Zero — stable /dev/flipper symlink.
# USB IDs from the Flipper Zero firmware (production + DFU).
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", SYMLINK+="flipper", MODE="0660", GROUP="dialout"
UDEV

# ── /boot/Automation_Custom_Script.sh — first-boot installer ──
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'BLACKBOX_FIRSTBOOT'
#!/bin/bash
# Sinsera Blackbox — first-boot install.
# Runs at the end of DietPi's first-boot setup.
#   1) Extracts bundled RaspyJack source → /opt/raspyjack/ → runs its installer
#   2) Installs the Flipper bridge prerequisites + udev rule
# After this script, DietPi reboots once so SPI dtoverlay + udev take effect.

set -e
exec > >(tee -a /var/log/sinsera-blackbox-firstboot.log) 2>&1
echo "[sinsera-blackbox] first-boot install starting $(date)"

BOOT=""
for cand in /boot/firmware /boot; do
  [[ -f "$cand/dietpi.txt" || -f "$cand/cmdline.txt" ]] && BOOT="$cand" && break
done
[[ -z "$BOOT" ]] && { echo "ERROR: no boot dir"; exit 1; }

# ── 1. RaspyJack ──────────────────────────────────────────────
echo "[sinsera-blackbox] RaspyJack: extracting + installing"
mkdir -p /opt/raspyjack
cd /opt/raspyjack

SRC_TAR=""
for cand in /opt/ark-extras/raspyjack-src.tar.gz "$BOOT/raspyjack-src.tar.gz"; do
  [[ -f "$cand" ]] && SRC_TAR="$cand" && break
done
if [ -n "$SRC_TAR" ]; then
  echo "[sinsera-blackbox] extracting bundled tarball: $SRC_TAR"
  tar -xzf "$SRC_TAR" -C /opt/raspyjack
  mkdir -p /var/lib/raspyjack
  mv "$SRC_TAR" /var/lib/raspyjack/source.tar.gz
else
  echo "[sinsera-blackbox] no bundled tarball; git-cloning upstream"
  apt-get install -y --no-install-recommends git
  git clone --depth=1 https://github.com/7h30th3r0n3/Raspyjack /opt/raspyjack-tmp
  mv /opt/raspyjack-tmp/* /opt/raspyjack/
  mv /opt/raspyjack-tmp/.* /opt/raspyjack/ 2>/dev/null || true
  rmdir /opt/raspyjack-tmp
fi

# Mirror the SSH key onto the dietpi + pi users (whichever exist post first-boot)
for user in dietpi pi; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    install -d -o "$user" -g "$user" -m 700 "$home/.ssh"
    install -o "$user" -g "$user" -m 600 /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
  fi
done

cd /opt/raspyjack
if [ -x install_raspyjack.sh ] || [ -f install_raspyjack.sh ]; then
  chmod +x install_raspyjack.sh
  echo "[sinsera-blackbox] running RaspyJack installer (non-interactive)"
  yes y 2>/dev/null | bash install_raspyjack.sh || {
    echo "[sinsera-blackbox] install_raspyjack.sh exited non-zero — manual cleanup may be needed"
    echo "  SSH in and run: cd /opt/raspyjack && bash install_raspyjack.sh"
  }
else
  echo "[sinsera-blackbox] no install_raspyjack.sh found at /opt/raspyjack/"
  ls /opt/raspyjack/ | head -20
fi

# ── 2. Flipper bridge ─────────────────────────────────────────
echo "[sinsera-blackbox] Flipper bridge: installing prerequisites"
apt-get install -y --no-install-recommends python3-serial
mkdir -p /opt/flipper
if [ -f /opt/sinsera-blackbox/flipper-bridge.py ]; then
  cp /opt/sinsera-blackbox/flipper-bridge.py /opt/flipper/flipper-bridge.py
  chmod +x /opt/flipper/flipper-bridge.py
fi
if [ -f /opt/sinsera-blackbox/99-flipper.rules ]; then
  cp /opt/sinsera-blackbox/99-flipper.rules /etc/udev/rules.d/99-flipper.rules
  udevadm control --reload-rules || true
  udevadm trigger || true
fi
# Quick self-test so the log shows whether the bridge can find a Flipper
echo "[sinsera-blackbox] Flipper bridge self-test:"
python3 /opt/flipper/flipper-bridge.py list || true

# ── 3. MOTD ──────────────────────────────────────────────────
cat >> /etc/motd <<'EOF'

  ╔═══════════════════════════════════════════════════════════════╗
  ║  Sinsera Blackbox  —  RaspyJack + Flipper bridge              ║
  ║                                                               ║
  ║  RaspyJack:                                                   ║
  ║    Source at /opt/raspyjack/                                  ║
  ║    Launch local UI: python3 /opt/raspyjack/raspyjack.py       ║
  ║                                                               ║
  ║  Flipper bridge:                                              ║
  ║    /opt/flipper/flipper-bridge.py — READ-ONLY allow-list      ║
  ║    Plug Flipper into USB; symlink at /dev/flipper             ║
  ║    Test: python3 /opt/flipper/flipper-bridge.py info          ║
  ║                                                               ║
  ║  Drive defensive scripts from Ark on your Mac:                ║
  ║    https://sinsera.co/ark/#security/raspyjack                 ║
  ║    https://sinsera.co/ark/#security/flipper                   ║
  ║  (Register this Pi in Ark → SSH Runner first)                 ║
  ║                                                               ║
  ║  Authorised use only — own hardware, own networks, written    ║
  ║  permission. The Flipper bridge refuses TX/clone/emulate.     ║
  ╚═══════════════════════════════════════════════════════════════╝

EOF

# ── Tailscale (optional) — joins tailnet if authkey was baked. ──
TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
if [ -n "$TS_AUTHKEY" ]; then
  echo "[sinsera-blackbox] installing Tailscale + joining tailnet"
  for i in 1 2 3 4 5 6; do
    curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts.sh && break
    echo "[sinsera-blackbox] tailscale fetch retry $i…"; sleep 10
  done
  if [ -f /tmp/ts.sh ]; then
    sh /tmp/ts.sh
    tailscale up --auth-key="$TS_AUTHKEY" --hostname="sinsera-blackbox" --ssh --accept-routes \
      || echo "[sinsera-blackbox] tailscale up failed"
    rm -f /tmp/ts.sh
  fi
fi

echo "[sinsera-blackbox] first-boot install complete $(date)"
BLACKBOX_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# ── Registry marker ──
printf '{"name":"sinsera-blackbox","version":"1","installed_at":"%s","profile":"sinsera-blackbox","strategy":"first-boot-install","components":["raspyjack","flipper-bridge"]}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-blackbox.json
ark_log "registered sinsera-blackbox"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Blackbox image baked."
ark_log "  Contents: RaspyJack standalone + Flipper bridge over USB"
ark_log "  Hardware: Pi Zero 2 W + 1.44\" LCD HAT + Flipper Zero (via USB)"
ark_log "  First boot: 10-15 min on Pi Zero 2 W. Reboots once."
ark_log "  Then: ssh root@SinseraBlackbox.local (key-based, no password)"
ark_log "================================================================"
exit 0
