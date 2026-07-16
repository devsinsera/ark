#!/bin/bash
# tailscale-firstboot.sh — Node 5. Install tailscaled on first boot (network up).
# NO authkey is baked, so we do NOT `tailscale up` here — the user joins the
# tailnet post-boot:  sudo tailscale up --ssh --hostname node5
set +e
for i in 1 2 3 4 5 6; do
  if curl -fsS -m 10 https://tailscale.com/install.sh -o /tmp/ts-install.sh; then break; fi
  echo "[node5][tailscale] retry $i (waiting for network)…"; sleep 10
done
if [ -f /tmp/ts-install.sh ]; then
  sh /tmp/ts-install.sh
  rm -f /tmp/ts-install.sh
  systemctl enable --now tailscaled 2>/dev/null || true
  echo "[node5][tailscale] installed. Join with: sudo tailscale up --ssh --hostname node5"
else
  echo "[node5][tailscale] could not fetch install script — will retry next boot"
fi
exit 0
