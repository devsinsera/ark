# Ark — Plan

Ark is a **device provisioning + manifest + fleet system** for
Raspberry Pi (and future ARM SBC) deployments.

This file is the canonical spec. It supersedes the original
"Sinsera Pi Kiosk Builder" module — that was the seed; Ark is the
expanded system.

---

## Vision

> **A reproducible deployment system for edge devices.**
> Every configuration is versioned, cloneable, portable,
> hardware-aware, and recoverable.

### Pipeline

```
Device Manifest  →  Ark Build Engine  →  Image / config bundle
                                            │
                                            ▼
                                          Flash
                                            │
                                            ▼
                                          Boot
                                            │
                                            ▼
                            Device reports back (optional)
                                            │
                                            ▼
                                       Fleet tracking
```

---

## The manifest — core data model

Every device is a manifest with **six layers**:

```jsonc
{
  "identity": {
    "name":  "ark-kiosk-01",         // unique slug
    "role":  "kiosk",                // kiosk | signage | portable | dashboard | headless
    "version": 1
  },

  "hardware": {
    "model":      "pi-zero-2-w",      // pi-zero-2-w | pi-4 | pi-5 | other
    "pisugar":    false,              // battery / UPS HAT present?
    "display":    "hdmi",             // hdmi | lcd-spi | dsi | headless
    "ethernet":   false,              // ethernet HAT?
    "gpio":       [],
    "power_note": ""
  },

  "network": {
    "hostname":      "ark-kiosk-01",
    "wifi_ssid":     "",
    "wifi_password": "",
    "wifi_security": "wpa2",          // wpa2 | wpa3 | enterprise (future)
    "static_ip":     null,
    "ssh_enabled":   true,
    "ssh_pubkeys":   [],              // authorized_keys lines
    "mdns":          true
  },

  "software": {
    "os":             "dietpi",
    "packages":       ["chromium","lxde"], // derived from role
    "boot_target":    "kiosk",        // kiosk | desktop | headless
    "timezone":       "Australia/Brisbane",
    "root_password":  "sinsera-kiosk"
  },

  "kiosk": {
    "url":               "https://sinsera.co",
    "fullscreen":        true,
    "auto_reload_min":   0,
    "hide_cursor":       true,
    "disable_blanking":  true,
    "rotation":          "normal",
    "fallback_html":     null
  },

  "behaviour": {
    "watchdog":             false,
    "auto_reboot_schedule": null,
    "offline_fallback":     false,
    "recovery_rules":       []
  }
}
```

---

## Output modes

### 1. **Config mode** — Phase 1 (shipping now)
Generates two text files:
- `dietpi.txt` — DietPi unattended install
- `Automation_Custom_Script.sh` — first-boot hook (kiosk service,
  cursor hide, blanking off, rotation, autoreload)

User flashes a stock DietPi image with Raspberry Pi Imager, drops
these two files onto the SD's boot partition, boots the Pi.

### 2. **Image mode** — Phase 3 (deferred)
Generates a full flashable `ark-device-<name>-vN.img`.

Browser-only is impossible (you can't mount + modify a multi-GB
image client-side). Realistic paths:
- A **Pi-side build script** the user runs once on a Linux box
- OR a **`pi-bridge`-style daemon** on a local machine that
  performs the mount + inject + emit
- OR a **GitHub Actions workflow** that builds the image on push

### 3. **Clone mode** — Phase 2 (shipping next)
Duplicate an existing manifest, override identity (new hostname /
keys), keep hardware + software + kiosk + behaviour the same.
Use case: deploy 5 identical kiosks across multiple rooms.

---

## Roadmap

### ✅ Phase 0 — Scaffold (in progress today)
- Vite + React standalone app at `Dev-Sinsera/Ark/app/`
- Deploy target: `sinsera.co/ark/` (HostGator FTP)
- GitHub repo: `devsinsera/ark`

### 🚧 Phase 1 — Manifest + Config Mode (tonight's target)
- Manifest data model + defaults
- Manifest editor UI (6 sections: identity, hardware, network,
  software, kiosk, behaviour)
- Save / load named manifests in localStorage
- Output: `dietpi.txt` + `Automation_Custom_Script.sh` (Blob
  download, same as the original Pi Kiosk Builder)
- SSH key injection (authorized_keys)
- Headless mode toggle (skip Chromium + LXDE)
- Live preview of generated files

### 🟡 Phase 2 — Multi-manifest + clone + library
- Sidebar showing all saved manifests
- Clone-with-overrides flow
- Batch-download (zip of 5 manifests' files)
- Manifest export / import as JSON
- Diff view between two manifests
- Hardware compatibility warnings system
  (e.g. "PiSugar HAT + headless → battery monitoring service
  pointless; consider enabling")

### 🟢 Phase 3 — Image builder (requires native tooling)
- Decide: Pi-side script vs. GitHub Actions vs. local daemon
- `ark-device-<name>-vN.img` output with configs pre-injected
- Versioning + reproducible builds

### 🔵 Phase 4 — Runtime feedback + fleet
- Devices POST telemetry to a Supabase / edge function
- Ark UI subscribes via Realtime
- Per-device status: uptime, CPU temp, RAM, disk, WiFi RSSI,
  PiSugar battery %, service health, last reboot reason
- "Fleet dashboard" — grid of all known devices, colour-coded
- Alerts: kiosk crashed, network lost, temp spike

### 🟣 Phase 5 — Discovery + auto-import
- SSH scan a network, find Pi devices, auto-generate manifest
  from observed state
- Compare existing fleet manifests to live state → flag drift

---

## What's NOT in scope (yet)

- **Provisioning anything other than Pi.** No general ARM SBC
  support, no x86 nodes. Pi-first.
- **Cloud-hosted backend.** Everything stays browser-side +
  localStorage in Phase 1 + 2. Telemetry needs a backend, comes
  in Phase 4.
- **OTA updates** to already-deployed devices. Out for now.
- **Pi DRM provisioning** (vault-level secrets per device).
  Out for now; can be added later via the systemd unit layer.

---

## Inheritance from "Sinsera Pi Kiosk Builder"

The Phase 1 deliverable subsumes the original kiosk builder. All
of these features carry over:
- Target URL input + presets (Garage / Core / DarkHaus / Payroll)
- WiFi SSID + password fields
- Hostname + timezone + root password
- Screen rotation, auto-reload interval, hide-cursor, no-blanking
- Live preview of both output files
- Client-side privacy (no upload)

New in Ark Phase 1:
- Named manifests + save/load (Library sidebar)
- SSH public-key injection
- Headless mode toggle
- Role selector (kiosk / signage / portable / dashboard / headless)
- Hardware-aware warnings (basic — e.g. headless + display setting
  mismatch → flag)

---

## Reference

| | |
|---|---|
| Live app | `https://sinsera.co/ark/` (TBD until first deploy) |
| Repo | `https://github.com/devsinsera/ark` (TBD) |
| Deploy | `cd app && npm run deploy` (lftp → HostGator `/ark/`) |
| Local OS images | `/Dev-Sinsera/Ark/Os/*.img*` (gitignored) |

---

## Realistic development rule

> Do not over-engineer telemetry or fleet features first.
> Start with: manifest + config generation + optional image builder.
> Iterate based on real Pi boot results.
> Primary validation: flash SD → boot Pi → observe → refine.

(Verbatim from the user's Ark spec — kept here so it never gets
lost.)
