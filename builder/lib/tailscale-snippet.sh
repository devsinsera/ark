# tailscale-snippet.sh — copy-paste block for image templates.
#
# Append this block (or its core lines) to a template's
# Automation_Custom_Script.sh first-boot heredoc. It installs
# Tailscale and joins the operator's tailnet using a baked-in
# authkey. The authkey is substituted at build time by
# bake-creds.sh via __TAILSCALE_AUTHKEY_PLACEHOLDER__.
#
# Behaviour:
#   - If no authkey was baked (empty placeholder), the block is a no-op.
#   - If the authkey is present, installs tailscale, joins the tailnet,
#     enables Tailscale SSH for the easy-SSH-from-anywhere experience.
#
# Hostname:
#   Each image template should pass its preferred hostname via the
#   TS_HOSTNAME env var BEFORE sourcing this snippet, e.g.:
#     export TS_HOSTNAME=sinsera-kiosk
#     # ... then the snippet body below
#
# Requirements:
#   - WiFi (or Ethernet) connected on first boot
#   - curl + sh present (DietPi default)

set +e

TS_AUTHKEY="__TAILSCALE_AUTHKEY_PLACEHOLDER__"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"

if [ -z "$TS_AUTHKEY" ]; then
  echo "[ark][tailscale] no authkey baked — skipping Tailscale install"
else
  echo "[ark][tailscale] installing Tailscale and joining tailnet as $TS_HOSTNAME"
  # The official install script handles distro detection (debian/rpi/etc).
  # Wait up to 60 s for network — first boot may still be settling.
  for i in 1 2 3 4 5 6; do
    if curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts-install.sh; then break; fi
    echo "[ark][tailscale] retry $i (waiting for network)…"
    sleep 10
  done
  if [ -f /tmp/ts-install.sh ]; then
    sh /tmp/ts-install.sh
    rm -f /tmp/ts-install.sh
    tailscale up \
      --auth-key="$TS_AUTHKEY" \
      --hostname="$TS_HOSTNAME" \
      --ssh \
      --accept-routes \
      || echo "[ark][tailscale] tailscale up returned non-zero"
    echo "[ark][tailscale] status:"
    tailscale status || true
  else
    echo "[ark][tailscale] could not fetch tailscale install script — skipping"
  fi
fi

set -e
