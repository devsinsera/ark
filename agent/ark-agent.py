#!/usr/bin/env python3
"""Ark Agent — Pi-side telemetry reporter.

Posts safe telemetry to the Hub every ARK_AGENT_INTERVAL_S seconds.
Reads system metrics from /proc and /sys; never reads secrets.

Configuration (environment variables):
    ARK_HUB_URL          required. e.g. http://192.168.4.124:7400
    ARK_AGENT_INTERVAL_S optional. default: 30
    ARK_MANIFEST_ID      optional. attached if set; lets the Hub link
                         this device to its build manifest.

NEVER reads / transmits:
    - WiFi passwords
    - SSH private keys
    - device admin passwords
    - any /etc/shadow / /home/<user>/.ssh contents

Stdlib-only (urllib + socket + os). Runs on the system python3
shipped with DietPi / Pi OS / Ubuntu Server.
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

AGENT_VERSION   = "0.2.0"
HUB_URL         = os.environ.get("ARK_HUB_URL", "").rstrip("/")
INTERVAL        = int(os.environ.get("ARK_AGENT_INTERVAL_S", "30"))
MANIFEST_ID     = os.environ.get("ARK_MANIFEST_ID") or None
# OTA self-update — disabled by default. Set ARK_AGENT_OTA=1 in
# /etc/ark-agent.env to opt in. When enabled, the agent compares its
# AGENT_VERSION to the Hub's /api/agent/latest on each report; if the
# Hub reports a newer one, the agent downloads, verifies sha256,
# atomically swaps /usr/local/bin/ark-agent.py, and exits non-zero so
# systemd restarts it on the new version.
OTA_ENABLED     = os.environ.get("ARK_AGENT_OTA", "0") == "1"
OTA_BIN_PATH    = os.environ.get("ARK_AGENT_BIN", "/usr/local/bin/ark-agent.py")


# ── Read-only system probes ──────────────────────────────────────────
def hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


def uptime_s():
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return None


def cpu_temp_c():
    # Standard thermal zone on Pi 3/4/5
    for path in ("/sys/class/thermal/thermal_zone0/temp",
                 "/sys/class/thermal/thermal_zone1/temp"):
        try:
            with open(path) as f:
                return round(int(f.read().strip()) / 1000.0, 1)
        except Exception:
            continue
    return None


def load_1m():
    try:
        with open("/proc/loadavg") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def memory_used_pct():
    try:
        meminfo = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                meminfo[k.strip()] = int(v.strip().split()[0])
        total = meminfo.get("MemTotal", 0)
        avail = meminfo.get("MemAvailable", 0)
        if total > 0:
            return round((total - avail) / total * 100, 1)
    except Exception:
        pass
    return None


def disk_used_pct():
    try:
        s = os.statvfs("/")
        if s.f_blocks > 0:
            return round((s.f_blocks - s.f_bfree) / s.f_blocks * 100, 1)
    except Exception:
        pass
    return None


def primary_ip():
    # Trick: ask the kernel which IP it would use to reach 8.8.8.8.
    # Doesn't actually send anything; just resolves the routing table.
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 53))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def primary_mac():
    for ifname in ("eth0", "wlan0", "end0", "enp0s31f6"):
        try:
            with open(f"/sys/class/net/{ifname}/address") as f:
                mac = f.read().strip()
                if mac and mac != "00:00:00:00:00:00":
                    return mac
        except Exception:
            continue
    return None


def os_release():
    info = {}
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    info[k] = v.strip('"')
    except Exception:
        pass
    return f"{info.get('NAME','linux')} {info.get('VERSION','')}".strip() or "linux"


def list_active_services():
    """Best-effort list of declared Ark services. Reads
    /ark/registry/*.json which the installer engine writes at finalise."""
    out = []
    reg_dir = "/ark/registry"
    if not os.path.isdir(reg_dir):
        return out
    try:
        for fname in sorted(os.listdir(reg_dir)):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(reg_dir, fname)) as f:
                    j = json.load(f)
                out.append({
                    "name":         j.get("name"),
                    "version":      j.get("version"),
                    "installed_at": j.get("installed_at"),
                    "entry_point":  j.get("entry_point"),
                    "profile":      j.get("profile"),
                })
            except Exception:
                continue
    except Exception:
        pass
    return out


# ── Report payload ───────────────────────────────────────────────────
def build_report():
    return {
        "device_name":      hostname(),
        "hostname":         hostname() + ".local",
        "mac":              primary_mac(),
        "ip":               primary_ip(),
        "uptime_s":         uptime_s(),
        "cpu_temp_c":       cpu_temp_c(),
        "memory_used_pct":  memory_used_pct(),
        "disk_used_pct":    disk_used_pct(),
        "load_1m":          load_1m(),
        "os":               os_release(),
        "services":         list_active_services(),
        "manifest_id":      MANIFEST_ID,
        "agent_version":    AGENT_VERSION,
    }


# ── POST loop ────────────────────────────────────────────────────────
def post(payload):
    """Send the telemetry payload. Returns the parsed response body so
    the caller can react to OTA hints, or None on failure."""
    if not HUB_URL:
        print("[agent] ARK_HUB_URL unset; cannot report", flush=True)
        return None
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        HUB_URL + "/api/agent/report",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
        try:
            return json.loads(body)
        except Exception:
            return {"ok": True}
    except urllib.error.URLError as e:
        print(f"[agent] post failed: {e.reason}", flush=True)
        return None
    except Exception as e:
        print(f"[agent] post error: {e}", flush=True)
        return None


def maybe_self_update(hub_response):
    """If the Hub reports an OTA update available AND we're allowed to
    apply it, fetch + verify + swap in the new binary, then exit. The
    systemd unit has Restart=on-failure so we come back up on the new
    version. Atomic-rename keeps the on-disk binary always-valid."""
    if not OTA_ENABLED:
        return
    if not isinstance(hub_response, dict):
        return
    update = hub_response.get("update")
    if not update or not update.get("available_version"):
        return
    if update["available_version"] == AGENT_VERSION:
        return

    print(f"[agent][ota] new version {update['available_version']} available "
          f"(current {AGENT_VERSION}); applying", flush=True)
    try:
        url = HUB_URL + update.get("url", "/api/agent/download")
        with urllib.request.urlopen(url, timeout=15) as resp:
            new_body = resp.read()
        import hashlib
        actual_sha = hashlib.sha256(new_body).hexdigest()
        expected_sha = update.get("sha256")
        if expected_sha and actual_sha != expected_sha:
            print(f"[agent][ota] sha256 mismatch — refusing update "
                  f"(expected {expected_sha}, got {actual_sha})", flush=True)
            return
        tmp = OTA_BIN_PATH + ".new"
        with open(tmp, "wb") as f:
            f.write(new_body)
        os.chmod(tmp, 0o755)
        os.replace(tmp, OTA_BIN_PATH)
        print(f"[agent][ota] swapped {OTA_BIN_PATH}; exiting so systemd restarts on new code",
              flush=True)
        # exit non-zero to trigger systemd Restart=on-failure
        sys.exit(75)
    except Exception as e:
        print(f"[agent][ota] update failed: {e}", flush=True)


def main():
    print(f"[agent] ark-agent {AGENT_VERSION} starting", flush=True)
    print(f"[agent] hub={HUB_URL or '(unset)'} interval={INTERVAL}s "
          f"ota={'on' if OTA_ENABLED else 'off'}", flush=True)
    if not HUB_URL:
        print("[agent] FATAL: ARK_HUB_URL must be set", flush=True)
        sys.exit(2)
    while True:
        r = build_report()
        resp = post(r)
        if resp:
            print(f"[agent] reported {r['device_name']} @ {r['ip']} · "
                  f"{r['cpu_temp_c']}°C · uptime {r['uptime_s']}s", flush=True)
            maybe_self_update(resp)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
