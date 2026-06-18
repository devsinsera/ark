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

## Pre-built images (current builds with flashable .img output)

| Build | Purpose | Size (.img.xz) | Hub registry id |
|---|---|---|---|
| **sinsera-vanilla** | Plain DietPi with personal config (hostname `SinseraCore`, SSH key, AU locale + timezone, OpenSSH enabled, normal console login). One-line WiFi edit before flashing. | 183 MB | `img_zhaevtjwm3iq6b` |
| **sinsera-kiosk** | Boots straight into Chromium full-screen on `https://sinsera.co/` | 183 MB | `img_oi138k54j1okux` |
| **claude-cli-pi** | Pi 5 boots into headless DietPi with Node 20 + claude-code CLI pre-installed. Operator drops API key into `/etc/claude-cli.env`, then `systemctl enable --now ark-claude.service`. | 183 MB | `img_4ynpgyhks5d6cd` |
| **sinsera-raspyjack** | Bundles the operator's local `~/Downloads/Jack/` (RaspyJack defensive-recon subset — DNSSpoof / payloads/wifi / payloads/credentials / Responder + culture loot all excluded). First boot extracts + runs upstream `install_raspyjack.sh`. | 250 MB | `img_po7smw9ka5tfjt` |

All four use the same first-boot-install strategy (write
`/boot/Automation_Custom_Script.sh` from the chroot rather than
apt-installing in chroot) which avoids the 1 GB base-partition
ceiling. RaspyJack additionally uses the **chroot extras pipeline**
(`builder/lib/chroot-run.sh` now copies any sibling `.tar.gz` of
`install.plan.sh` into the rootfs at `/opt/ark-extras/`) so large
source bundles ride along with the image.

---

## Roll-up roadmap (current as of 2026-05-24)

```
PHASE 1     manifest + config + browser UI + Hub MVP + Builder render
            ✅ DONE 2026-05-21

PHASE 2     PRESETS — hardware × purpose × OS composable stack
            ✅ DONE 2026-05-22

PHASE 3     IMAGE BUILDER — chroot + apt + image export
            ✅ DONE 2026-05-22 (verified end-to-end via Colima
            arm64 container + DietPi base; markers survived)
   3.1 ✅   xz compression of output (--compress flag)
   3.2 ✅   GPG signing of output (--sign / --sign-key FPR)
   3.3 ✅   Image-size shrinking via resize2fs (--shrink)
   3.4 ✅   Commit-SHA pinning in profiles (ref / url@ref)
   3.5 ✅   Per-build pip venv (--venv flag)
   3.6 ✅   ELF-based arch detection
   3.7 ✅   GitHub Actions runner (.github/workflows/build-image.yml)

PHASE 4     NETWORK LANDSCAPE + FLEET
   4.1 ✅   Hub MVP (ARP scan + Wi-Fi scan + REST API)
   4.2 🟡   Agent on Pi  (code shipped; untested vs real Pi)
   4.3 ✅   SQLite persistence (~/.ark/ark-hub.db)
   4.4 ✅   Network Landscape UI (Devices / Wi-Fi / Networks live;
            Graph tab still placeholder)
   4.5 ✅   Drift detection (manifest_missing / os / service /
            kiosk_url / packages / network)
   4.6 ✅   Health score (heartbeat / cpu_temp / uptime / mem /
            disk / network consistency)
   4.7 ✅   Export (CSV / JSON bundle / single device / fleet snapshot)
   4.8 ✅   Import (POST /api/import/snapshot)

PHASE 5     Discovery + drift across multiple networks
   5.1 ✅   Encrypted credential vault (AES-256-GCM)
   5.2 ✅   Multi-network drift detection (sightings-based)
   5.3 ✅   OTA agent self-update (opt-in via ARK_AGENT_OTA=1)

PHASE 6     FLASH NODE — network imaging appliance
   6.1 ✅   Hub-side flash subsystem (nodes / images / jobs)
   6.2 🟡   Pi-side Flash Agent (FastAPI; untested vs real Pi)
   6.3 ✅   UI: 5-tab Flash Nodes panel
   6.4 ✅   Hub → Agent dispatcher (auto-push every 4 s)
   6.5 ✅   Browser-side WebSocket subscription to job stream
   6.6 ✅   Image upload UI from the laptop
   6.7 ✅   Clone / Capture source-side reads

PHASE 7     SECURITY — Can't Phish Here
   7.1 ✅   Alert engine + approved-host registry + 8 hardening checks
   7.2 ✅   UI: 6-view defensive panel
   7.3 🟡   Pi-side passive monitor (journalctl tail; untested vs Pi)
   7.4 ✅   Webhook / email surface for alerts (slack/discord/generic)
   7.5 ✅   MAC / IP / port change diff logic
   7.6 ✅   Scheduled hardening runs (per-host cron via SSH Runner)

PHASE 8     UI POLISH + LAST-MILE
   ✅       Collapsible left + right panes
   ✅       Vault UI panel
   ✅       Drift detail modal (replaces raw-JSON click)
   ✅       Manifest registration UI → Hub
   ✅       Tab 4 Graph view in Network Landscape
   ✅       SSH runner subsystem + UI
   ✅       Online-Pi update (scp install.plan.sh + exec)
   ✅       Installer browser surface (git URL + ZIP upload + folder)
   ✅       Flash Node install guide in Nodes tab (5 steps + troubleshooting)
   ✅       Pre-built images (sinsera-vanilla / -kiosk / -raspyjack +
            claude-cli-pi) with Hub-registered download buttons

GATED ON A FLASHED Pi (physical-world)
        🟡  Phase 4.2 end-to-end validation
        🟡  Phase 5.3 OTA validation
        🟡  Phase 6.2 Flash Agent validation
        🟡  Phase 7.3 passive-monitor validation
```

The single remaining bottleneck is **flashing a card and booting
SinseraCore**. Four prebuilt images are ready to flash — pick
sinsera-vanilla for plain DietPi, sinsera-kiosk for the public
site as a kiosk, claude-cli-pi for an always-on Claude tmux, or
sinsera-raspyjack for the recon toolkit. Once one Pi reports
telemetry, the four 🟡 entries flip to ✅ together.
