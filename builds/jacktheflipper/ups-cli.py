#!/usr/bin/env python3
"""ups — auto-detect Pi UPS HAT and print battery status.

Scans I2C bus 1 for known UPS-HAT chip addresses and dispatches to
the right driver. Supports:
  - Waveshare UPS HAT (B / C / D variants) — INA219 @ 0x43
  - PiSugar 2 / 3 — IP5306 @ 0x75

Output is JSON when called with --json, plain text otherwise.

Usage:
  ups            # plain text summary
  ups --json     # machine-readable
  ups --watch    # refresh every 2 s

Requires python3-smbus (already on the JackTheFlipper image).
"""
import argparse, json, sys, time

try:
    import smbus2 as smbus
except ImportError:
    try:
        import smbus
    except ImportError:
        print(json.dumps({"ok": False, "error": "python3-smbus not installed. sudo apt-get install -y python3-smbus2"}))
        sys.exit(2)

# ── Waveshare UPS HAT (INA219 @ 0x43) ─────────────────────────
INA219_ADDR = 0x43
INA219_REG_BUSVOLTAGE  = 0x02
INA219_REG_POWER       = 0x03
INA219_REG_CURRENT     = 0x04
INA219_REG_CALIBRATION = 0x05

def read_ina219(bus):
    # Calibrate (default for Waveshare B/C: 32V / 2A range)
    bus.write_word_data(INA219_ADDR, INA219_REG_CALIBRATION, _swap16(4096))
    bus.write_word_data(INA219_ADDR, 0x00, _swap16(0x199F))
    # Bus voltage (V): top 13 bits of raw * 4 mV
    raw_v = _swap16(bus.read_word_data(INA219_ADDR, INA219_REG_BUSVOLTAGE))
    bus_v = ((raw_v >> 3) * 4) / 1000.0
    # Current (A): raw / 10 (calibration-derived scale)
    raw_c = _swap16(bus.read_word_data(INA219_ADDR, INA219_REG_CURRENT))
    if raw_c > 32767: raw_c -= 65536  # signed
    current_a = raw_c / 10000.0
    # Power (W): raw * 0.002
    raw_p = _swap16(bus.read_word_data(INA219_ADDR, INA219_REG_POWER))
    power_w = raw_p * 0.002
    # SOC estimate: linear from 3.0V (0%) to 4.2V (100%) per cell ×2 → 6.0-8.4V
    soc = max(0, min(100, round((bus_v - 6.0) / 2.4 * 100)))
    return {
        "chip": "INA219",
        "model_hint": "Waveshare UPS HAT (B/C/D)",
        "voltage_v": round(bus_v, 3),
        "current_a": round(current_a, 3),
        "power_w":   round(power_w, 3),
        "soc_pct":   soc,
        "charging":  current_a > 0.05,
    }

# ── PiSugar 2/3 (IP5306 @ 0x75) ───────────────────────────────
IP5306_ADDR = 0x75

def read_ip5306(bus):
    soc_raw = bus.read_byte_data(IP5306_ADDR, 0x78)
    soc = 0
    if soc_raw & 0x80: soc += 25
    if soc_raw & 0x40: soc += 25
    if soc_raw & 0x20: soc += 25
    if soc_raw & 0x10: soc += 25
    status = bus.read_byte_data(IP5306_ADDR, 0x71)
    charging = (status & 0x08) != 0
    return {
        "chip": "IP5306",
        "model_hint": "PiSugar 2/3",
        "soc_pct":   soc,
        "charging":  charging,
    }

def _swap16(v):
    return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF)

def detect(bus):
    """Try each known address. Return (handler, addr) or (None, None)."""
    for addr, handler in [(INA219_ADDR, read_ina219), (IP5306_ADDR, read_ip5306)]:
        try:
            bus.read_byte(addr)
            return handler, addr
        except OSError:
            continue
    return None, None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json",  action="store_true", help="JSON output")
    ap.add_argument("--watch", action="store_true", help="refresh every 2 s")
    args = ap.parse_args()
    try:
        bus = smbus.SMBus(1)
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "/dev/i2c-1 not present. Enable I2C: dtparam=i2c_arm=on in config.txt, then reboot."}))
        sys.exit(1)

    def one_shot():
        handler, addr = detect(bus)
        if not handler:
            return {"ok": False, "error": "no known UPS HAT chip found at 0x43 or 0x75 on /dev/i2c-1. `i2cdetect -y 1` to see what's present."}
        try:
            data = handler(bus)
            data["ok"] = True
            data["i2c_addr"] = hex(addr)
            return data
        except Exception as e:
            return {"ok": False, "error": f"read failed: {e}"}

    if args.watch:
        try:
            while True:
                d = one_shot()
                if args.json:
                    print(json.dumps(d), flush=True)
                else:
                    _print_pretty(d)
                    print("─" * 40, flush=True)
                time.sleep(2)
        except KeyboardInterrupt:
            pass
        return

    d = one_shot()
    if args.json:
        print(json.dumps(d, indent=2))
    else:
        _print_pretty(d)

def _print_pretty(d):
    if not d.get("ok"):
        print(f"  [error] {d.get('error')}")
        return
    print(f"  chip:     {d['chip']} ({d.get('model_hint','?')}) @ {d.get('i2c_addr','?')}")
    if "voltage_v" in d: print(f"  voltage:  {d['voltage_v']} V")
    if "current_a" in d: print(f"  current:  {d['current_a']:+.3f} A")
    if "power_w"   in d: print(f"  power:    {d['power_w']} W")
    if "soc_pct"   in d: print(f"  SOC:      {d['soc_pct']} %")
    print(f"  charging: {'yes' if d.get('charging') else 'no'}")

if __name__ == "__main__":
    main()
