# Ark Hub — LAN discovery + telemetry collector

A small always-on service that runs **somewhere on the LAN** and
acts as Ark's eyes on the network. The browser UI cannot ARP-scan,
mDNS-query, or accept inbound connections from Pis — but the Hub
can. The browser talks to the Hub; the Hub talks to the network.

Status: **Phase 4 / 5** — not implemented yet. This file is the spec.

---

## Topology

```
        ┌───────────────────────────────────────────┐
        │             Local Area Network            │
        │                                           │
        │  ┌─────────┐    ┌─────────┐   ┌─────────┐ │
        │  │  Pi 1   │    │  Pi 2   │   │  Pi N   │ │
        │  │ ark-    │    │ ark-    │   │ ark-    │ │
        │  │ agent   │    │ agent   │   │ agent   │ │
        │  └────┬────┘    └────┬────┘   └────┬────┘ │
        │       │              │             │      │
        │       │ mDNS broadcasts             │      │
        │       │ + outbound POSTs to Hub     │      │
        │       │              │             │      │
        │       ▼              ▼             ▼      │
        │  ┌──────────────────────────────────────┐ │
        │  │           Ark Hub                    │ │
        │  │  - arp-scan (sudoroot)               │ │
        │  │  - mdns query / dns-sd               │ │
        │  │  - REST: GET /devices                │ │
        │  │  - WS:   /events                     │ │
        │  └─────────────────┬────────────────────┘ │
        └────────────────────┼──────────────────────┘
                             │
                             ▼
                     ┌──────────────┐
                     │ Browser UI   │
                     │ Ark /network │
                     └──────────────┘
```

The Hub is the ONLY component on the LAN that needs root (for arp-scan).
The agent runs as the kiosk user. The browser runs as a regular tab.

---

## Where the Hub lives

Pick one:

1. **User's Mac (development)** — `npm run hub` in this repo. Hub
   binds to `http://localhost:7400` + advertises itself via mDNS as
   `_arkhub._tcp.local`. Only reachable from same machine, but
   useful for one-Pi-on-WiFi development.

2. **One of the Pis (production)** — install the Hub on a
   permanently-on Pi (probably whichever Pi runs the OBD bridge or
   a fileserver). Hub bound to `0.0.0.0:7400`. mDNS advertises
   so the browser UI can find it without hardcoded IP.

3. **A small NAS / home server** — same as option 2 if you have a
   Synology / Pi 4 / Mac mini sitting on the network 24/7.

Browser auto-discovery: UI tries `http://hub.local:7400` first
(common case — single Hub on LAN), then `http://<userTyped>:7400`
(advanced override).

---

## Hub API surface

### `GET /devices`

Returns the union of:
- Devices learned from ARP scans (raw LAN presence)
- Devices learned from mDNS browse (`_ark._tcp.local`)
- Devices that POSTed an agent report in the last `staleness_window` (default 60s)

Response shape (mirrors the manifest's identity / hardware / network /
behaviour layers + runtime fields):

```json
{
  "scanned_at": "2026-05-21T12:30:00Z",
  "hub_version": "0.1.0",
  "devices": [
    {
      "id":          "ark-kiosk-01",      // agent_id OR manifest_id OR hostname OR mac
      "source":      "agent",             // agent | mdns | arp
      "device_name": "ark-kiosk-01",
      "role":        "kiosk",
      "status":      "online",            // online | offline | degraded | unknown
      "ip":          "192.168.1.50",
      "mac":         "DC:A6:32:XX:YY:ZZ",
      "hostname":    "ark-kiosk-01.local",
      "os":          "DietPi",
      "uptime_s":    123456,
      "cpu_temp_c":  42.5,
      "auth_status": "key-based",         // key-based | password-based | unknown
      "manifest_id": "m_abc12345",
      "last_seen":   "2026-05-21T12:29:58Z",
      "services":    ["ssh", "kiosk"],
      "build_version": "0.1.0",
      "signal_dbm":  -54,
      "battery_pct": null
    },
    {
      "id":          "DC:A6:32:11:22:33",
      "source":      "arp",
      "device_name": "unknown",
      "role":        "unknown",
      "status":      "online",
      "ip":          "192.168.1.99",
      "mac":         "DC:A6:32:11:22:33",
      "auth_status": "unknown",
      "last_seen":   "2026-05-21T12:30:00Z"
    }
  ]
}
```

### `GET /events` (WebSocket)

Pushes device state changes in real-time:
```
{"type":"online",      "id":"ark-kiosk-01","at":"...","ip":"..."}
{"type":"offline",     "id":"ark-kiosk-02","at":"..."}
{"type":"telemetry",   "id":"ark-kiosk-01","at":"...","cpu_temp_c":68}
{"type":"new_device",  "id":"DC:A6:...","at":"...","ip":"..."}
```

### `POST /agent/report` (called by the agent on each Pi)

The agent POSTs telemetry here every 30s. Auth via shared secret
in `X-Ark-Agent-Token` header (configured at agent install time
from a hub-generated token).

Body shape:
```json
{
  "device_name": "ark-kiosk-01",
  "manifest_id": "m_abc12345",
  "role":        "kiosk",
  "uptime_s":    123456,
  "cpu_temp_c":  42.5,
  "memory_used_mb": 380,
  "disk_used_pct":  18,
  "wifi_rssi":   -54,
  "battery_pct": null,
  "services":    {"kiosk": "healthy", "ssh": "running"},
  "last_boot":   "2026-05-20T08:00:00Z",
  "build_version": "0.1.0",
  "auth_status": "key-based"
}
```

### `POST /devices/:id/action`

Browser-initiated actions:
- `reboot`           — sends SSH reboot to the device (if key-based auth configured)
- `assign_manifest`  — links a discovered device to a manifest
- `tag`              — set notes/labels
- `rename`           — change device_name
- `forget`           — remove from the Hub's device cache

---

## Implementation outline

```
hub/
├── package.json
├── src/
│   ├── index.mjs         # http + ws server
│   ├── scan/
│   │   ├── arp.mjs       # spawn `arp -a` or `arp-scan`; parse output
│   │   ├── mdns.mjs      # dns-sd browse for _ark._tcp.local
│   │   └── merge.mjs     # unify all sources by id
│   ├── agent.mjs         # POST /agent/report handler + token auth
│   ├── actions.mjs       # POST /devices/:id/action handlers
│   └── store.mjs         # in-memory state + sqlite snapshot
└── README.md
```

Pure Node + a few thin deps (sqlite, ws). Should fit in ~500 lines.

---

## Security rules — non-negotiable per spec

**Never display, store, or transmit plaintext device passwords.**
The Hub MUST NOT:
- Show passwords in the API response
- Store agent SSH keys unencrypted on disk
- Accept inbound agent reports without a shared-secret token

The Hub MAY:
- Store SSH **public** keys (they're already public by definition)
- Store a token used by browser UI to call the action endpoints
- Cache discovered MAC → device-name mappings

The browser UI MUST NOT:
- Render a "password" column in the device table
- Accept a typed password in any form

`auth_status` is an enum, not a credential.

---

## Phase ordering

| Phase | What |
|---|---|
| 4.0 | Hub spec written (this file) |
| 4.1 | Hub MVP — arp-scan only, no agent, no actions. Browser shows discovered IPs + MACs. |
| 4.2 | Agent v0 — Pi-side script that POSTs reports. Hub renders agent data in `/devices` response. |
| 4.3 | mDNS discovery added (devices announce via `_ark._tcp.local`). |
| 4.4 | Actions: reboot, assign-manifest, tag. |
| 4.5 | WebSocket event stream, browser auto-discovery via mDNS, multi-Hub support. |
