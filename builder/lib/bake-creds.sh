#!/bin/bash
# bake-creds.sh — render an install-template.sh into an install.plan.sh
# with the operator's personal credentials (SSH pubkey + WiFi SSID +
# WiFi password) substituted in.
#
# Reads from:
#   ~/.ssh/id_ed25519.pub             — operator's SSH public key
#   ~/.ark/wifi.env                   — WIFI_SSID=... + WIFI_KEY=...
#
# Both are operator-local; nothing committed to git.
#
# Usage:
#   bake-creds.sh <install-template.sh> <install.plan.sh>
#
# Placeholders the template can use:
#   __SSH_PUBKEY_PLACEHOLDER__        — replaced with the .pub contents
#   __WIFI_SSID_PLACEHOLDER__         — replaced with the SSID
#   __WIFI_KEY_PLACEHOLDER__          — replaced with the password
#
# If ~/.ark/wifi.env doesn't exist or doesn't define WIFI_SSID/KEY,
# the placeholders fall back to the original REPLACE_WITH_... strings
# so the image is still flashable (just needs the manual edit you
# wanted to avoid).

set -euo pipefail

SRC="${1:-}"
DST="${2:-}"
if [[ -z "$SRC" || -z "$DST" ]]; then
  echo "ERROR: bake-creds.sh <install-template.sh> <install.plan.sh>" >&2
  exit 2
fi
[[ -f "$SRC" ]] || { echo "ERROR: source not found: $SRC" >&2; exit 2; }

# ── SSH pubkey ──
SSH_PUBKEY=""
if [[ -f "$HOME/.ssh/id_ed25519.pub" ]]; then
  SSH_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")
fi
if [[ -z "$SSH_PUBKEY" ]]; then
  echo "WARN: no ~/.ssh/id_ed25519.pub — image will boot without SSH key access" >&2
fi

# ── WiFi creds ──
WIFI_SSID="REPLACE_WITH_YOUR_SSID"
WIFI_KEY="REPLACE_WITH_YOUR_WIFI_PASSWORD"
WIFI_ENV="$HOME/.ark/wifi.env"
if [[ -f "$WIFI_ENV" ]]; then
  # Source in a subshell + read back via env so we can use the values
  # even if wifi.env doesn't `export` them. Tolerant of `KEY=value`
  # and `KEY="value with spaces"`.
  set -a
  # shellcheck disable=SC1090
  source "$WIFI_ENV"
  set +a
  : "${WIFI_SSID:=REPLACE_WITH_YOUR_SSID}"
  : "${WIFI_KEY:=REPLACE_WITH_YOUR_WIFI_PASSWORD}"
  if [[ "$WIFI_SSID" == "REPLACE_WITH_YOUR_SSID" ]]; then
    echo "WARN: $WIFI_ENV present but WIFI_SSID not set — image will need /boot/dietpi.txt edit" >&2
  fi
else
  echo "WARN: $WIFI_ENV not found — image will need /boot/dietpi.txt edit" >&2
  echo "  Create it with:"                                                                  >&2
  echo "    mkdir -p ~/.ark && chmod 700 ~/.ark"                                            >&2
  echo "    cat > ~/.ark/wifi.env <<'EOF'"                                                  >&2
  echo "    WIFI_SSID='your-network-name'"                                                  >&2
  echo "    WIFI_KEY='your-password'"                                                       >&2
  echo "    EOF"                                                                            >&2
  echo "    chmod 600 ~/.ark/wifi.env"                                                      >&2
fi

# ── Substitute ──
# awk with literal-text gsub so passwords with shell metacharacters
# (&, |, $, /, etc.) don't get reinterpreted.
mkdir -p "$(dirname "$DST")"
awk -v ssh_key="$SSH_PUBKEY" -v ssid="$WIFI_SSID" -v pw="$WIFI_KEY" '
  function rep(line, needle, val,    i, n) {
    n = ""
    while ((i = index(line, needle)) > 0) {
      n = n substr(line, 1, i - 1) val
      line = substr(line, i + length(needle))
    }
    return n line
  }
  {
    $0 = rep($0, "__SSH_PUBKEY_PLACEHOLDER__", ssh_key)
    $0 = rep($0, "__WIFI_SSID_PLACEHOLDER__",  ssid)
    $0 = rep($0, "__WIFI_KEY_PLACEHOLDER__",   pw)
    # Backwards-compat: also rewrite the literal REPLACE_WITH_YOUR_*
    # strings the older templates used. Lets existing templates work
    # without modification.
    $0 = rep($0, "REPLACE_WITH_YOUR_SSID",          ssid)
    $0 = rep($0, "REPLACE_WITH_YOUR_WIFI_PASSWORD", pw)
    print
  }
' "$SRC" > "$DST"
chmod +x "$DST"

# Sanity check — confirm no placeholders linger
if grep -qE '__(SSH_PUBKEY|WIFI_SSID|WIFI_KEY)_PLACEHOLDER__' "$DST"; then
  echo "WARN: placeholders remain in $DST — check the template" >&2
fi

echo "[bake-creds] $SRC → $DST"
echo "  ssh:  $([ -n "$SSH_PUBKEY" ] && echo "baked (${SSH_PUBKEY:0:30}…)" || echo "MISSING")"
echo "  wifi: ssid=$([ "$WIFI_SSID" != "REPLACE_WITH_YOUR_SSID" ] && echo "$WIFI_SSID" || echo "MISSING")"
