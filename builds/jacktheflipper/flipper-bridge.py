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
    print(json.dumps({"ok": False, "error": "pyserial not installed. run: sudo apt-get install -y python3-serial"}))
    sys.exit(2)

def find_flipper():
    for p in ['/dev/flipper', '/dev/ttyACM0', '/dev/ttyACM1']:
        if os.path.exists(p):
            return p
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
