# Ark Architecture v2 — unifying spec

> Ark is no longer a kiosk builder.
> Ark is a **deterministic device compiler + network intelligence
> system + fleet manager**.

This file is the index. Each sub-system has its own spec file
linked below. Implementation phases are scattered across them but
roll up to one timeline at the end of this doc.

---

## The four subsystems

```
┌────────────────────────────────────────────────────────────────┐
│                          ARK                                   │
├────────────────┬─────────────────┬─────────────────┬───────────┤
│  1. DEVICE     │  2. IMAGE       │  3. NETWORK     │ 4. FLEET  │
│     BUILDER    │     BUILDER     │     LANDSCAPE   │  + EXPORT │
│                │     PIPELINE    │                 │           │
├────────────────┼─────────────────┼─────────────────┼───────────┤
│ Hardware       │ manifest →      │ LAN discovery   │ device    │
│  presets       │  build plan     │  (ARP + mDNS)   │  table    │
│ Purpose        │ chroot pipeline │ Wi-Fi scan      │  (live)   │
│  presets       │ image export    │  (nearby SSIDs) │ CSV /     │
│ OS / image     │ DietPi / Pi OS  │ Ark agents      │  JSON     │
│  selection     │  / Ubuntu       │  (telemetry)    │  export   │
│ Configuration  │ deterministic   │ Multi-network   │ import +  │
│  stack         │  reproducible   │  graph DB       │  restore  │
│ Manifest       │ outputs         │ 4-tab UI        │ drift     │
│  generation    │                 │  view           │  detection│
└────────────────┴─────────────────┴─────────────────┴───────────┘
```

| Subsystem | Spec file | Implementation status |
|---|---|---|
| 1. Device Builder | `PRESETS.md` | Phase 1 partial (flat manifest live; presets stack Phase 2) |
| 2. Image Builder Pipeline | `../builder/README.md` | Phase 1 render works; Phase 3 chroot stub |
| 3. Network Landscape | `NETWORK_LANDSCAPE.md` + `HUB.md` + `AGENT.md` | Hub MVP works (arp + Wi-Fi); UI not built |
| 4. Fleet + Export | `EXPORT.md` | Spec only |

---

## Cross-cutting models

### Device identity + trust hierarchy

Every device has a stable identity. **Source of identity ranks**:

1. **Ark Agent reports** — highest trust. Self-attesting, manifest-linked.
2. **Manifest match** — Hub-side rule that looks up a manifest by name / hostname pattern.
3. **Hostname** — mDNS name (e.g. `SinseraCore.local`).
4. **MAC** — stable across IP changes; survives reboots.
5. **Passive discovery (ARP only)** — lowest trust; just "something with an IP".

Identity record:

```jsonc
{
  "device_id":            "dev_<uuid>",
  "hardware_fingerprint": "<sha of mac + serial if available>",
  "manifest_id":          "m_abc12345" | null,
  "trust_state":          "trusted" | "unverified" | "unknown",
  "network_origin":       "<network_id>"
}
```

Trust elevates downward when sources agree, e.g. Agent-reports = `trusted` automatically; Manifest+MAC match = `trusted`; bare MAC = `unverified`.

### Health score

Each device computes a health state from:

| Signal | Healthy when |
|---|---|
| heartbeat freshness | last Agent report < 60s |
| uptime stability | no unexpected reboots in last hour |
| CPU temperature | < 70°C |
| service availability | declared services all `running` |
| network consistency | IP stable across last 5 scans |

States: `HEALTHY` / `DEGRADED` / `OFFLINE` / `UNKNOWN`.

### Drift detection

Every Agent report is compared to the device's manifest. Flag drift when:
- Service declared in manifest is no longer running
- Kiosk URL has changed
- Package set diverged from manifest packages
- OS version mismatch with the build's base image

UI banner: `⚠ CONFIG DRIFT DETECTED — <count> deviations from manifest.`

Phase 4.5 work — depends on agent telemetry being persistent
(Hub SQLite is the storage layer).

---

## Multi-network — first-class

Networks are now top-level objects (per Network Landscape spec):

```jsonc
{
  "network_id":  "wifi:HomeNet:34:fc:b9:...",
  "ssid":        "HomeNet",
  "type":        "wifi" | "ethernet" | "mobile_hotspot",
  "subnet":      "192.168.4.0/22",
  "gateway":     "192.168.4.1",
  "security":    "wpa2",
  "first_seen":  "2026-01-12T08:30:00Z",
  "last_seen":   "2026-05-21T12:00:00Z"
}
```

A device-on-network is the unit of telemetry; the same MAC across
two networks creates two graph edges. The graph data model is
fully spec'd in `NETWORK_LANDSCAPE.md`.

---

## Security rules (non-negotiable across every subsystem)

NEVER expose, store, or transmit:
- Plaintext device passwords
- WiFi credentials beyond the build-time injection point
- SSH private keys
- API tokens

ALWAYS replace with one of:
- `auth_status` enum (`key-based` / `password-based` / `unknown`)
- `credential_ref` opaque reference (Phase 5: encrypted vault)
- `***REDACTED***` placeholder in exports
- `vault_id` (Phase 5)

Exports respect this even when "include sensitive fields" is checked
— that flag only flips redaction markers ON; never the real values.

---

## Concrete state, end of 2026-05-21 session

| | |
|---|---|
| Browser app live | `https://sinsera.co/ark/` (3-pane redesign) |
| Hub MVP | works on user's Mac. Discovers 25 devices including the Pi 5 (`SinseraCore`, dual-interface, `88:a2:9e:*`) tagged as Raspberry Pi vendor. Wi-Fi nearby scan works (4 SSIDs visible from user's location). |
| Builder CLI | `render` works; `build` Phase 3 stub |
| Specs captured | PRESETS · HUB · AGENT · EXPORT · NETWORK_LANDSCAPE · this ARCHITECTURE |
| First Pi flashed | not yet (next session priority) |
| Agent on Pi | not built (Phase 4.2 spec only) |
| Network View UI | not built (Tab 3 spec'd) |
| SQLite persistence | not added (Hub is in-memory still) |
| Export feature | not built |

---

## Roll-up roadmap

```
PHASE 1     manifest + config + browser UI + Hub MVP + Builder render
            ✅ DONE 2026-05-21

PHASE 2     PRESETS — hardware + purpose + OS stack
            🚧 spec ready, build later

PHASE 3     IMAGE BUILDER — chroot + apt + image export
            🚧 spec ready; needs Linux + qemu-user-static

PHASE 4     NETWORK LANDSCAPE + FLEET
   4.1 ✅   Hub MVP (ARP scan + Wi-Fi scan + REST API)
   4.2     Agent on Pi
   4.3     SQLite persistence (FIRST persistent state in Ark)
   4.4     Network Landscape UI (4 tabs) + Network/Device DB
   4.5     Drift detection
   4.6     Health score computation
   4.7     Export (CSV / JSON bundle / single device / fleet snapshot)
   4.8     Import + restore

PHASE 5     Discovery + drift across multiple networks; encrypted
            credential vault; OTA agent updates
```

Today's realistic next move: flash a card with the existing
DietPi image + a `dietpi.txt` exported from the UI, boot the Pi,
see what the Hub now reports about a real Ark-style first boot.
That's the only thing that turns the spec into evidence.
