#!/bin/bash
# Sinsera Flipper Companion — Ark install plan.

set -e
set -o pipefail
LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/registry
ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

BOOT_DIR=""
for cand in /boot/firmware /boot; do
  if [[ -d "$cand" ]] && [[ -f "$cand/cmdline.txt" || -f "$cand/dietpi.txt" || -f "$cand/config.txt" ]]; then
    BOOT_DIR="$cand"; break
  fi
done
[[ -z "$BOOT_DIR" ]] && { ark_log "ERROR: no boot partition"; exit 1; }
ark_log "boot partition: $BOOT_DIR"

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
  set_dp AUTO_SETUP_NET_HOSTNAME            'SinseraFlipper'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED        '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE   'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID           'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY            'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE                'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                  'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT         'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX        '-1'
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX  '1'
  set_dp AUTO_SETUP_AUTOSTART_LOGIN_USER    'root'
  set_dp SURVEY_OPTED_IN                    '0'
  set_dp AUTO_SETUP_ACCEPT_LICENSE          '1'
fi

ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

# Stage the bridge on /boot — first-boot script moves it.
cat > "$BOOT_DIR/flipper-bridge.py" <<'FLIPPER_PY'
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
    import serial   # pip install pyserial
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
ark_log "wrote $BOOT_DIR/flipper-bridge.py ($(stat --printf='%s' "$BOOT_DIR/flipper-bridge.py") bytes)"

ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'FLIPPER_FIRSTBOOT'
#!/bin/bash
set -e
exec > >(tee -a /var/log/sinsera-flipper-firstboot.log) 2>&1
echo "[sinsera-flipper] starting first-boot install $(date)"

BOOT=""
for cand in /boot/firmware /boot; do
  [[ -f "$cand/dietpi.txt" || -f "$cand/cmdline.txt" ]] && BOOT="$cand" && break
done
[[ -z "$BOOT" ]] && { echo "ERROR: no boot dir"; exit 1; }

apt-get update
apt-get install -y --no-install-recommends python3 python3-pip python3-serial

mkdir -p /opt/flipper
mv "$BOOT/flipper-bridge.py" /opt/flipper/flipper-bridge.py
chmod +x /opt/flipper/flipper-bridge.py
echo "[sinsera-flipper] bridge installed at /opt/flipper/flipper-bridge.py"

# udev rule — Flipper Zero VID:PID is 0483:5740. Create /dev/flipper symlink
# + open the device r/w to the dialout group.
cat > /etc/udev/rules.d/99-flipper.rules <<'UDEV'
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", GROUP="dialout", MODE="0660", SYMLINK+="flipper"
UDEV
udevadm control --reload-rules || true
echo "[sinsera-flipper] udev rule installed"

for user in dietpi pi; do
  if id "$user" >/dev/null 2>&1; then
    home=$(getent passwd "$user" | cut -d: -f6)
    install -d -o "$user" -g "$user" -m 700 "$home/.ssh"
    install -o "$user" -g "$user" -m 600 /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
    usermod -aG dialout "$user" || true
    echo "[sinsera-flipper] SSH key + dialout group → $user"
  fi
done

cat >> /etc/motd <<'EOF'

  Sinsera Flipper Companion
  Bridge: /opt/flipper/flipper-bridge.py
  Test:   python3 /opt/flipper/flipper-bridge.py info
  Drive from: https://sinsera.co/ark/#security/flipper
  Plug a Flipper Zero in — /dev/flipper appears automatically.
  READ-ONLY bridge. Transmit operations stay on the Flipper.

EOF
echo "[sinsera-flipper] first-boot install complete $(date)"
FLIPPER_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

printf '{"name":"sinsera-flipper","version":"1","installed_at":"%s","profile":"sinsera-flipper","strategy":"first-boot-install"}\n' "$INSTALLED_AT" \
  > /ark/registry/sinsera-flipper.json
ark_log "registered sinsera-flipper"

ark_log ""
ark_log "================================================================"
ark_log "  Sinsera Flipper Companion image baked."
ark_log "  Before flashing: edit /boot/dietpi.txt for your WiFi."
ark_log "  First boot ~2-3 min. Then: ssh root@SinseraFlipper.local"
ark_log "  Plug a Flipper Zero in, open Ark → CPH → Flipper."
ark_log "================================================================"
exit 0
