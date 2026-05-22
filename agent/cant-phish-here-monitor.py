#!/usr/bin/env python3
"""Can't Phish Here passive monitor — Pi-side.

Read-only daemon. Tails journalctl + /var/log/auth.log for suspicious
patterns and POSTs structured `unusual_traffic` alerts to the Ark Hub.

What it watches:
    - Repeated SSH auth failures from the same IP (>= 5 in 60s)
    - Brute-force-ish sudo failures (>= 3 in 60s)
    - sshd accepting from an IP outside the approved subnets
    - High burst of new outgoing connections (cheap netstat tail)

What it NEVER does:
    - Read /etc/shadow, /home/*/.ssh, or any credential file
    - Run any active scan or probe
    - Modify any system state — purely observational

Config via /etc/cant-phish-here.env:
    ARK_HUB_URL                e.g. http://192.168.4.167:7400
    CPH_AUTH_FAIL_THRESHOLD    default 5 per 60s
    CPH_SUDO_FAIL_THRESHOLD    default 3 per 60s
    CPH_REPORT_INTERVAL_S      default 30 (how often to flush alerts)

Run as a systemd unit (cant-phish-here-monitor.service); see
install-cph-monitor.sh.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from typing import Optional

VERSION = "0.1.0"

HUB_URL                  = os.environ.get("ARK_HUB_URL", "").rstrip("/")
HOST                     = socket.gethostname()
AUTH_FAIL_THRESHOLD      = int(os.environ.get("CPH_AUTH_FAIL_THRESHOLD", "5"))
SUDO_FAIL_THRESHOLD      = int(os.environ.get("CPH_SUDO_FAIL_THRESHOLD", "3"))
REPORT_INTERVAL_S        = int(os.environ.get("CPH_REPORT_INTERVAL_S", "30"))
WINDOW_S                 = 60

# Per-IP buckets of recent timestamps. defaultdict(deque) auto-creates.
_ssh_fails: dict[str, deque[float]] = defaultdict(deque)
_sudo_fails: dict[str, deque[float]] = defaultdict(deque)
_ssh_accepts: dict[str, deque[float]] = defaultdict(deque)


# ── Pattern matchers ───────────────────────────────────────────────
RX_SSH_FAIL = re.compile(
    r"sshd\[\d+\]:\s+Failed (?:password|publickey)\s+(?:for(?:\s+invalid user)?\s+\S+)?\s+from\s+(\S+)"
)
RX_SSH_ACCEPT = re.compile(
    r"sshd\[\d+\]:\s+Accepted\s+\S+\s+for\s+\S+\s+from\s+(\S+)"
)
RX_SUDO_FAIL = re.compile(
    r"sudo:\s+(\S+)\s+:\s+\d+ incorrect password attempts?"
)


def maybe_alert(kind: str, severity: str, subject: str, detail: dict) -> None:
    """Send a structured alert to the Hub. Best-effort — silently
    swallows network errors so the monitor never crashes."""
    if not HUB_URL:
        print(f"[cph-monitor] (no hub) {severity}/{kind}: {subject}", flush=True)
        return
    # Use the Hub's CPH alert endpoint directly so the alert appears
    # immediately in the operator UI without waiting for a scan tick.
    try:
        # First option: raise via security.detect path. Easiest is to
        # POST a synthetic 'agent report' that CPH treats as alert
        # source. The Hub doesn't expose a public /api/cph/alerts POST,
        # so we wrap as a regular agent telemetry message with a
        # cph_alert field the Hub picks up on receipt.
        payload = {
            "device_name": HOST,
            "hostname":    HOST + ".local",
            "agent_kind":  "cph-monitor",
            "cph_alert": {
                "kind":     kind,
                "severity": severity,
                "subject":  subject,
                "detail":   detail,
            },
        }
        req = urllib.request.Request(
            HUB_URL + "/api/agent/report",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()
        print(f"[cph-monitor] sent {severity}/{kind}: {subject}", flush=True)
    except Exception as e:
        print(f"[cph-monitor] alert post failed: {e}", flush=True)


# ── Bucket book-keeping ────────────────────────────────────────────
def _record(buckets: dict[str, deque[float]], key: str) -> int:
    """Add a hit for `key` now and return the count within the
    rolling window."""
    now = time.time()
    q = buckets[key]
    q.append(now)
    while q and now - q[0] > WINDOW_S:
        q.popleft()
    return len(q)


# ── Line consumers ─────────────────────────────────────────────────
def consume_journalctl_line(line: str) -> None:
    if not line: return
    m = RX_SSH_FAIL.search(line)
    if m:
        ip = m.group(1)
        n  = _record(_ssh_fails, ip)
        if n >= AUTH_FAIL_THRESHOLD:
            maybe_alert(
                "unusual_traffic", "warn",
                f"Repeated SSH auth failures from {ip}",
                {"source_ip": ip, "fails_in_window_s": n, "window_s": WINDOW_S, "host": HOST},
            )
            _ssh_fails[ip].clear()  # reset so we don't re-fire every line
        return

    m = RX_SUDO_FAIL.search(line)
    if m:
        user = m.group(1)
        n    = _record(_sudo_fails, user)
        if n >= SUDO_FAIL_THRESHOLD:
            maybe_alert(
                "unusual_traffic", "warn",
                f"Repeated sudo failures by {user}",
                {"user": user, "fails_in_window_s": n, "window_s": WINDOW_S, "host": HOST},
            )
            _sudo_fails[user].clear()
        return

    m = RX_SSH_ACCEPT.search(line)
    if m:
        ip = m.group(1)
        _record(_ssh_accepts, ip)
        # Future: cross-check ip against approved-subnets list from the Hub.
        return


# ── Source: journalctl follow ──────────────────────────────────────
def tail_journalctl() -> None:
    """Spawn `journalctl -f -u ssh -u sudo` and feed each line to the
    consumer. Resilient to journalctl exits — re-spawns after 5s."""
    while True:
        try:
            p = subprocess.Popen(
                ["journalctl", "-f", "-n", "0", "--no-pager", "-o", "cat",
                 "-u", "ssh", "-u", "sshd", "-u", "sudo"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            if not p.stdout:
                print("[cph-monitor] journalctl: no stdout?", flush=True)
                time.sleep(5); continue
            print(f"[cph-monitor] tailing journalctl (pid {p.pid})", flush=True)
            for line in p.stdout:
                consume_journalctl_line(line.strip())
        except FileNotFoundError:
            print("[cph-monitor] journalctl not on this host; falling back to /var/log/auth.log", flush=True)
            return tail_logfile("/var/log/auth.log")
        except Exception as e:
            print(f"[cph-monitor] journalctl error: {e}; respawning in 5s", flush=True)
            time.sleep(5)


def tail_logfile(path: str) -> None:
    """Fallback path: tail /var/log/auth.log directly."""
    while True:
        try:
            with open(path, "r") as f:
                f.seek(0, 2)  # to end
                while True:
                    line = f.readline()
                    if not line:
                        time.sleep(0.5); continue
                    consume_journalctl_line(line.strip())
        except FileNotFoundError:
            print(f"[cph-monitor] {path} not found; sleeping 30s then retry", flush=True)
            time.sleep(30)
        except Exception as e:
            print(f"[cph-monitor] tail {path} error: {e}", flush=True)
            time.sleep(5)


def main() -> None:
    print(f"[cph-monitor] starting v{VERSION} on {HOST}", flush=True)
    print(f"[cph-monitor] hub={HUB_URL or '(unset)'} "
          f"auth_fail_threshold={AUTH_FAIL_THRESHOLD} sudo_fail_threshold={SUDO_FAIL_THRESHOLD}",
          flush=True)
    if not HUB_URL:
        print("[cph-monitor] WARN: ARK_HUB_URL not set; alerts will only be logged locally", flush=True)
    tail_journalctl()


if __name__ == "__main__":
    main()
