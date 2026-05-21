# Ark Network Landscape — multi-network observability

Status: **Phase 4.x spec** — Wi-Fi scan endpoint in Hub MVP works
(`POST /api/wifi/refresh`, `GET /api/wifi`). 4-tab UI in `App.jsx`
not yet built.

Expands Ark from a single-LAN device discovery tool into a
multi-network observability + mapping system.

## What this is NOT

- It does not bypass network security.
- It does not scan or inspect devices on networks you aren't on.
- It does not retrieve credentials.

## What it IS

- A visibility layer over **nearby Wi-Fi SSIDs** (passive listen)
- A device map of **networks you are currently connected to**
- A historical record of every network you've connected to
- A graph linking networks → devices → manifests → telemetry

---

## Data model — a graph

```
NETWORK ──────► DEVICE ──────► MANIFEST ──────► TELEMETRY (over time)
   │              │                                  ▲
   │              └──── current state ───────────────┘
   │
   └──── historical (first_seen / last_seen)
```

### Network
```jsonc
{
  "network_id":  "wifi:HomeNet:34:fc:b9:11:22:33",  // ssid + bssid prefix
  "ssid":        "HomeNet",
  "type":        "wifi" | "ethernet" | "mobile_hotspot",
  "subnet":      "192.168.4.0/22",
  "gateway":     "192.168.4.1",
  "security":    "open" | "wpa2" | "wpa3" | "enterprise",
  "first_seen":  "2026-01-12T08:30:00Z",
  "last_seen":   "2026-05-21T12:00:00Z"
}
```

### Device (now scoped to a network)
```jsonc
{
  "device_id":   "dc:a6:32:11:22:33",         // MAC, stable across IP changes
  "network_id":  "wifi:HomeNet:34:fc:b9:...",
  "ip":          "192.168.4.50",
  "mac":         "dc:a6:32:11:22:33",
  "hostname":    "ark-kiosk-01.local",
  "role":        "kiosk",
  "os":          "DietPi",
  "status":      "online",
  "uptime":      123456,
  "cpu_temp":    42.5,
  "last_seen":   "2026-05-21T12:05:00Z",
  "manifest_id": "m_abc12345"
}
```

The same MAC across networks creates **multiple device-on-network
edges** in the graph. The Hub's `/api/devices` shape stays
backward-compatible — Phase 4 adds a `network_id` field but
existing fields stay where they are.

---

## Discovery layers

### A. Wi-Fi scan (NEW — implemented in Hub)
**Visibility only — does not connect.**
- Returns SSID, signal (RSSI), channel, encryption, vendor (if BSSID
  prefix matches a known OUI).
- macOS: `system_profiler SPAirPortDataType -json`
- Linux: `nmcli -t -f SSID,SIGNAL,SECURITY,CHAN dev wifi list`

### B. LAN discovery (already implemented)
**Connected networks only.**
- ARP scan: IP + MAC
- mDNS: hostnames + services

### C. Ark Agent (Phase 4.2 — spec'd in AGENT.md)
**Best source.** When installed, Pis report manifest_id + role +
uptime + CPU temp + status + network_id directly.

---

## UI — Network Landscape (4 tabs)

### Tab 1 — Nearby Networks (Wi-Fi radar)

Spreadsheet of visible SSIDs. **Visibility only, no interaction.**

| SSID | Signal | Security | Channel | Type | Last Seen |

Per-row actions: `Connect` (opens system Wi-Fi picker), `Save Profile` (track in Ark history), `Mark as Trusted`.

### Tab 2 — Active Networks

Currently-connected networks (usually one, but ethernet + Wi-Fi or
VPN can coexist).

| Network Name | Subnet | Gateway | Device Count | Status |

Click → opens Tab 3 filtered to that network.

### Tab 3 — Device Table (primary operational view)

Spreadsheet view, the most-used tab.

| Device | Role | Status | IP | MAC | Hostname | OS | Uptime | CPU Temp | Auth Status | Notes | Manifest | Last Seen | Network | Actions |

- Sortable any column
- Filter by status / role / network / Ark-managed-only
- Live updates (polling every 3-5s OR WebSocket)
- Highlight changes — flash a new row when a device appears,
  fade-out an offline row before removing

### Tab 4 — Network Graph

Visual graph: networks as parent nodes, devices clustered under
them, manifest links as cross-connections.

```
HomeNetwork (192.168.4.0/22)
   ├── ark-kiosk-01 ──► m_abc12345
   ├── peta-mbp
   ├── peta-iphone
   ├── espressif-iot-1
   └── (15 more)

OfficeNetwork (10.0.10.0/24)   ← if you ever connect to it
   ├── ark-signage-02 ──► m_def67890
   └── (laptops, printers)
```

Phase 4.x.3: simple force-directed graph; Phase 4.x.4: drag/zoom +
clickable nodes.

---

## Hub API additions (Phase 4.x)

| Method | Path | Status |
|---|---|---|
| `GET /api/wifi` | Cached nearby Wi-Fi scan | ✅ implemented |
| `POST /api/wifi/refresh` | Force a fresh Wi-Fi scan (~5–10s) | ✅ implemented |
| `GET /api/networks` | List of networks the Hub has seen | 🚧 |
| `GET /api/devices?network=<id>` | Device list filtered to a network | 🚧 |
| `GET /api/graph` | Network + device + manifest graph JSON | 🚧 |
| `GET /api/wifi/history` | Visible-SSID history (with first/last seen) | 🚧 |

---

## TODO from the Hub MVP smoke-test

When I tested the Wi-Fi scan tonight against the user's actual
LAN, two parser polish items showed up:

1. **Clean up macOS `spairport_*` enum strings** — currently the
   API returns `security: "spairport_security_mode_wpa2_personal"`.
   Should be normalised to `"wpa2"` / `"wpa3"` / `"open"` /
   `"enterprise"` per the spec's network-object shape. Same for
   `type: "spairport_network_type_station"` → `"infrastructure"`.

2. **Some nearby SSIDs have null RSSI** — system_profiler reports
   `spairport_signal_noise` (signal:noise format like `"-49:-92"`)
   for the active network but only `spairport_network_rssi` for
   some nearby. Need to parse both and prefer whichever is present.

3. **Vendor lookup on BSSID** — when `spairport_network_bssid` is
   populated, run it through `oui.mjs vendorForMac()` to surface
   "Likely Apple AirPort" / "Likely Eero" / etc. The macOS
   command doesn't always include BSSID — only when allowed by
   Location privacy permission. Worth surfacing the no-BSSID
   case in the UI with a "Grant Location access for richer
   Wi-Fi data" note.

---

## Multi-network persistence

Phase 4 introduces the FIRST persistent state in Ark. Today the
Hub is in-memory only — restart loses everything. For the
historical network database the user wants:

| Option | Where | Trade-off |
|---|---|---|
| **SQLite via better-sqlite3** | One file on the Hub box | Zero deps, fast, single-machine. Easy backup. |
| **Supabase** | Cloud, shared across hubs | Multi-device sync; requires auth; cost. |
| **flat JSON snapshots** | `Ark/hub/state/` dir | Simplest, version-controllable, but slow at scale. |

Recommendation: **SQLite**. Tracks networks, devices, manifests,
telemetry samples. Hub starts with a single `ark-hub.db` file in
`~/.ark/`. Backup = copy the file.

Schema (Phase 4.x.2 work):
```sql
CREATE TABLE networks (
  id           TEXT PRIMARY KEY,
  ssid         TEXT,
  type         TEXT,
  subnet       TEXT,
  gateway      TEXT,
  security     TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE TABLE devices (
  id           TEXT,
  network_id   TEXT REFERENCES networks(id),
  ip           TEXT,
  mac          TEXT,
  hostname     TEXT,
  role         TEXT,
  os           TEXT,
  status       TEXT,
  uptime       INTEGER,
  cpu_temp     REAL,
  last_seen    INTEGER NOT NULL,
  manifest_id  TEXT,
  PRIMARY KEY (id, network_id)
);
CREATE TABLE telemetry (
  device_id    TEXT,
  network_id   TEXT,
  ts           INTEGER NOT NULL,
  cpu_temp     REAL,
  cpu_load_1   REAL,
  memory_used  INTEGER,
  wifi_rssi    INTEGER,
  battery_pct  REAL
);
CREATE INDEX telemetry_recent ON telemetry (device_id, ts);
```

---

## Phase ordering

| Phase | What |
|---|---|
| 4.x.0 | This spec (now) |
| 4.x.1 | Wi-Fi scan in Hub (`/api/wifi`) ✅ done |
| 4.x.2 | SQLite persistence — networks + devices tables |
| 4.x.3 | Network Landscape UI Tab 3 (Device Table) — live polling against Hub |
| 4.x.4 | Tab 1 (Wi-Fi radar) + Tab 2 (Active networks) |
| 4.x.5 | Telemetry capture (Hub records each /api/agent/report into SQLite) |
| 4.x.6 | Tab 4 (Network Graph view) |
| 4.x.7 | Export modes (CSV / JSON bundle / single device / fleet snapshot) — see EXPORT.md |
