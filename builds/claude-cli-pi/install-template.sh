#!/bin/bash
# Claude CLI Pi — install-template.sh
#
# The Ark Installer Engine renders the REAL install.plan.sh from this
# template + the build profile + the operator's manifest. Lives here
# for reference + so the profile is self-documenting.
#
# Steps the engine bakes in:
#   1. apt update + install base + nodejs + npm + tmux
#   2. Create system user 'claude' (no sudo, no shell history kept)
#   3. npm install -g @anthropic-ai/claude-code  (via $HOME for claude)
#   4. Write /etc/claude-cli.env with ANTHROPIC_API_KEY from the vault
#   5. Install systemd unit ark-claude.service
#   6. Enable + start
#
# The actual install.plan.sh produced by `ark-install compile` will
# look something like below (with the real packages and env wiring
# substituted in).

set -e
set -o pipefail
LOG=/var/log/ark-install.log
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p /ark/builds /ark/registry
ark_log() { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
ark_run() { ark_log "RUN: $*"; "$@" 2>&1 | tee -a "$LOG"; }

# ── PREPARE ──
ark_run apt-get update -y
ark_run apt-get install -y ca-certificates curl git tmux vim jq build-essential

# Node 20.x LTS via NodeSource — newer than apt's bundled version
ark_run bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
ark_run apt-get install -y nodejs

# ── CONFIGURE: user, key, npm package ──
ark_run useradd -m -s /bin/bash claude || true
ark_run install -d -o claude -g claude -m 0755 /home/claude/.config /home/claude/.local

# ARK_VAULT_ANTHROPIC_API_KEY is interpolated by the Installer Engine
# from a vault ref the operator provided when selecting this profile.
# If unset at install time, the file is created empty and `claude`
# will prompt on first run.
cat > /etc/claude-cli.env <<EOF
ANTHROPIC_API_KEY=${ARK_VAULT_ANTHROPIC_API_KEY:-}
EOF
chmod 0640 /etc/claude-cli.env
chown root:claude /etc/claude-cli.env

# Install the CLI globally so all users can invoke 'claude'
ark_run npm install -g @anthropic-ai/claude-code

# ── systemd unit ──
cat > /etc/systemd/system/ark-claude.service <<'UNIT'
[Unit]
Description=Ark Claude CLI — always-on tmux session
After=network-online.target
Wants=network-online.target

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
ark_run systemctl daemon-reload
ark_run systemctl enable --now ark-claude.service

# ── FINALISE ──
printf '{"name":"claude-cli-pi","version":"1","installed_at":"%s","profile":"claude-cli-pi"}\n' "$INSTALLED_AT" \
  > /ark/registry/claude-cli-pi.json && ark_log "registered claude-cli-pi"

ark_log ""
ark_log "================================================================"
ark_log " Claude CLI Pi ready."
ark_log "  ssh claude@\$(hostname).local"
ark_log "  tmux attach -t claude"
ark_log "  (Ctrl-b d to detach; session survives logout)"
ark_log "================================================================"
exit 0
