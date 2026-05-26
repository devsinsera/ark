# Tor

Slot reserved for Tor / onion-services integration inside The Haunted Broccoli.

Intended scope:
- Launch a local Tor circuit (via `tor` daemon on the Pi)
- Expose key ports through a `.onion` address (e.g. THB hub itself
  reachable via .onion when away from home network)
- Onion routing for Beacon scrape requests (route the share-URL fetch
  through Tor so Uber doesn't see your home IP)
- Tor Browser launcher on the kiosk

Current state: empty stub.

When implemented, this folder will hold:
- `torrc` — the Tor daemon config
- `service.sh` — start/stop helpers
- A THB `/apps/tor` route surfacing circuit status + the .onion address
