#!/usr/bin/env bash
# Install the Can't Phish Here passive monitor on a Pi. Read-only;
# tails journalctl looking for failed-auth patterns.
#
# Required env:
#   HUB_URL — e.g. http://192.168.4.167:7400
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "ERROR: run as root" >&2; exit 1; fi
if [[ -z "${HUB_URL:-}" ]]; then echo "ERROR: HUB_URL required" >&2; exit 1; fi

SRC="$(cd "$(dirname "$0")" && pwd)/cant-phish-here-monitor.py"
[[ -f "$SRC" ]] || { echo "ERROR: $SRC not found" >&2; exit 1; }

install -m 0755 "$SRC" /usr/local/bin/cant-phish-here-monitor.py

cat > /etc/cant-phish-here.env <<EOF
ARK_HUB_URL=${HUB_URL}
CPH_AUTH_FAIL_THRESHOLD=${CPH_AUTH_FAIL_THRESHOLD:-5}
CPH_SUDO_FAIL_THRESHOLD=${CPH_SUDO_FAIL_THRESHOLD:-3}
EOF
chmod 0644 /etc/cant-phish-here.env

cat > /etc/systemd/system/cant-phish-here-monitor.service <<'EOF'
[Unit]
Description=Can't Phish Here — passive auth-failure monitor
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cant-phish-here.env
ExecStart=/usr/bin/python3 /usr/local/bin/cant-phish-here-monitor.py
Restart=on-failure
RestartSec=5
User=root

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# Reads journalctl + /var/log/auth.log; doesn't write anything.
ReadOnlyPaths=/

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cant-phish-here-monitor.service

sleep 2
if systemctl is-active --quiet cant-phish-here-monitor.service; then
  echo "✓ cant-phish-here-monitor running. Logs: journalctl -u cant-phish-here-monitor -f"
else
  echo "✗ failed to start"
  journalctl -u cant-phish-here-monitor -n 30 --no-pager
  exit 1
fi
