#!/bin/bash
# Claude CLI Pi — Ark install plan.
#
# Same first-boot-install strategy as sinsera-kiosk: the chroot
# writes a /boot/Automation_Custom_Script.sh that runs ON THE Pi at
# the end of DietPi's first-boot setup, after the rootfs has been
# expanded to fill the SD card. This avoids the ~1 GB base-partition
# disk-space ceiling (Node + npm + claude-code easily exceed that).
#
# After flashing and booting:
#   - DietPi runs first-boot setup (~60 s)
#   - DietPi expands rootfs to fill SD
#   - DietPi runs /boot/Automation_Custom_Script.sh below
#   - Node 20 LTS, tmux, vim, jq installed
#   - 'claude' system user created
#   - @anthropic-ai/claude-code installed globally
#   - systemd ark-claude.service registered (doesn't auto-start since
#     ANTHROPIC_API_KEY isn't in /etc/claude-cli.env yet)
#
# Post-flash setup:
#   ssh into the Pi, edit /etc/claude-cli.env to add your API key,
#   then `sudo systemctl enable --now ark-claude.service` to start
#   the always-on tmux session.

set -e
set -o pipefail

LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/builds /ark/registry
echo "[ark] install plan begin: claude-cli-pi" | tee -a "$LOG"

ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ── Detect boot partition ──
BOOT_DIR=""
for cand in /boot/firmware /boot; do
  if [[ -d "$cand" ]] && [[ -f "$cand/cmdline.txt" || -f "$cand/dietpi.txt" || -f "$cand/config.txt" ]]; then
    BOOT_DIR="$cand"; break
  fi
done
if [[ -z "$BOOT_DIR" ]]; then
  ark_log "ERROR: could not find boot partition in chroot"; exit 1
fi
ark_log "boot partition at: $BOOT_DIR"

# ── Write the first-boot installer to the boot partition ──
ark_log "writing $BOOT_DIR/Automation_Custom_Script.sh"
cat > "$BOOT_DIR/Automation_Custom_Script.sh" <<'CLAUDE_FIRSTBOOT'
#!/bin/bash
# Claude CLI Pi — DietPi Automation_Custom_Script.sh
# Runs ONCE at the end of DietPi first-boot setup, after partition
# expansion. Installs Node 20 + claude-code CLI + sets up the
# always-on systemd unit (kept disabled until the operator drops in
# their ANTHROPIC_API_KEY).
set -e
exec > >(tee -a /var/log/claude-cli-pi-install.log) 2>&1
echo "[claude-cli-pi] starting first-boot install $(date)"

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git tmux vim jq build-essential

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

# 'claude' system user
id claude >/dev/null 2>&1 || useradd -m -s /bin/bash claude
install -d -o claude -g claude -m 0755 /home/claude/.config /home/claude/.local

# Env file — operator drops the API key here post-flash
cat > /etc/claude-cli.env <<EOF
# Edit this file to add your Anthropic API key, then:
#   sudo systemctl enable --now ark-claude.service
ANTHROPIC_API_KEY=
EOF
chmod 0640 /etc/claude-cli.env
chown root:claude /etc/claude-cli.env

# Global CLI install
npm install -g @anthropic-ai/claude-code

# systemd unit — NOT auto-enabled (no API key yet)
cat > /etc/systemd/system/ark-claude.service <<'UNIT'
[Unit]
Description=Ark Claude CLI — always-on tmux session
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/etc/claude-cli.env.empty
ConditionEnvironment=ANTHROPIC_API_KEY=

[Service]
Type=forking
User=claude
EnvironmentFile=/etc/claude-cli.env
ExecStart=/usr/bin/tmux new-session -d -s claude -- /usr/bin/claude
ExecStop=/usr/bin/tmux kill-session -t claude
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

# Helpful login MOTD
cat > /etc/motd <<'EOF'

  ┌─────────────────────────────────────────────────────────┐
  │  Claude CLI Pi                                          │
  │                                                         │
  │  1. Edit /etc/claude-cli.env and add ANTHROPIC_API_KEY  │
  │  2. sudo systemctl enable --now ark-claude.service      │
  │  3. tmux attach -t claude                               │
  │                                                         │
  │  Ctrl-b d to detach; the session keeps running.         │
  └─────────────────────────────────────────────────────────┘

EOF

# ── Tailscale (optional) — joins tailnet so you can SSH from anywhere.
# Authkey baked at build time by bake-creds.sh from ~/.ark/tailscale.env.
TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
if [ -n "$TS_AUTHKEY" ]; then
  echo "[claude-cli-pi] installing Tailscale + joining tailnet"
  for i in 1 2 3 4 5 6; do
    curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts.sh && break
    echo "[claude-cli-pi] tailscale fetch retry $i…"; sleep 10
  done
  if [ -f /tmp/ts.sh ]; then
    sh /tmp/ts.sh
    tailscale up --auth-key="$TS_AUTHKEY" --hostname="claude-cli-pi" --ssh --accept-routes \
      || echo "[claude-cli-pi] tailscale up failed"
    rm -f /tmp/ts.sh
  fi
fi

echo "[claude-cli-pi] install complete — drop the API key into"
echo "[claude-cli-pi] /etc/claude-cli.env and start the service."
CLAUDE_FIRSTBOOT
chmod +x "$BOOT_DIR/Automation_Custom_Script.sh"

# Tune dietpi.txt for headless boot + WiFi + SSH key
if [[ -f "$BOOT_DIR/dietpi.txt" ]]; then
  ark_log "tuning $BOOT_DIR/dietpi.txt for headless"
  set_dp() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$BOOT_DIR/dietpi.txt"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$BOOT_DIR/dietpi.txt"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$BOOT_DIR/dietpi.txt"
    fi
  }
  set_dp AUTO_SETUP_NET_HOSTNAME           'ClaudeCli'
  set_dp AUTO_SETUP_NET_WIFI_ENABLED       '1'
  set_dp AUTO_SETUP_NET_WIFI_COUNTRY_CODE  'AU'
  set_dp AUTO_SETUP_NET_WIFI_SSID          'REPLACE_WITH_YOUR_SSID'
  set_dp AUTO_SETUP_NET_WIFI_KEY           'REPLACE_WITH_YOUR_WIFI_PASSWORD'
  set_dp AUTO_SETUP_TIMEZONE               'Australia/Sydney'
  set_dp AUTO_SETUP_LOCALE                 'en_AU.UTF-8'
  set_dp AUTO_SETUP_KEYBOARD_LAYOUT        'au'
  set_dp AUTO_SETUP_SSH_SERVER_INDEX       '-1'
  set_dp AUTO_SETUP_ACCEPT_LICENSE         '1'
  set_dp AUTO_SETUP_AUTOSTART_TARGET_INDEX '1'
  set_dp SURVEY_OPTED_IN                   '0'
fi

# ── SSH public key (root) — baked by bake-creds.sh ──
ark_log "installing SSH public key for root"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'PUBKEY'
__SSH_PUBKEY_PLACEHOLDER__
PUBKEY
chmod 600 /root/.ssh/authorized_keys

mkdir -p /ark/registry
printf '{"name":"claude-cli-pi","version":"1","installed_at":"%s","profile":"claude-cli-pi","strategy":"first-boot-install"}\n' "$INSTALLED_AT" \
  > /ark/registry/claude-cli-pi.json
ark_log "registered claude-cli-pi"

ark_log ""
ark_log "================================================================"
ark_log "  Claude CLI Pi image baked. Next steps:"
ark_log "    1. Flash + boot. First boot ~5-7 min (Node + npm install)."
ark_log "    2. SSH in. Edit /etc/claude-cli.env to add API key."
ark_log "    3. sudo systemctl enable --now ark-claude.service"
ark_log "    4. tmux attach -t claude  (Ctrl-b d to detach)"
ark_log "================================================================"
exit 0
