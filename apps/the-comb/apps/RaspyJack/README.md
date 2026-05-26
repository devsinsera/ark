# RaspyJack

Slot reserved for [RaspyJack](https://github.com/lamehackerwhocodes/RaspyJack)
integration inside The Haunted Broccoli.

RaspyJack is a Pi-based pentesting toolkit (LAN attacks, captive-portal
phishing, network recon, BadUSB). The plan is to bundle a managed
install when THB runs on a Pi, so the Haunted Broccoli kiosk becomes a
single console for both iOS work AND LAN reconnaissance.

Intended scope:
- One-click install of RaspyJack into `/opt/raspyjack`
- THB `/apps/raspyjack` route exposing RaspyJack's web UI in an iframe
  (RaspyJack already runs on its own local port)
- Auth bridging — THB cookie gates the iframe access
- Logs viewer surfacing RaspyJack's capture output in the THB theme

Current state: empty stub.

Out of scope (deliberate): we are not redistributing RaspyJack binaries.
The install pulls from upstream. Use only on networks you own.
