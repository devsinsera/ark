# Ark Presets — composable device stack

Status: **Phase 2 spec** — not implemented yet. Captures the
"hardware + purpose + OS = stack" architecture from the user's
spec so it's not lost.

---

## Concept

A device is built from **three composable preset layers**:

```
  ┌─────────────────────┐
  │  HARDWARE PRESET    │  what the device IS
  │  - Pi Zero 2 W      │
  │  - Pi 4 / Pi 5      │
  │  - Headless node    │
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  PURPOSE PRESET     │  what the device DOES
  │  - Kiosk            │
  │  - Dashboard        │
  │  - Portable / RJack │
  │  - Signage          │
  │  - Service node     │
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  OS / IMAGE BASE    │  what it RUNS
  │  - DietPi (default) │
  │  - Pi OS Lite       │
  │  - Pi OS Desktop    │
  │  - Ubuntu Server    │
  │  - Ark Minimal      │
  └─────────────────────┘
             ↓
        DEVICE MANIFEST
             ↓
         BUILD PLAN
             ↓
            .img
```

Each preset is **immutable + versioned**. Pick `Pi Zero 2 W /
Kiosk / DietPi v1.2` — that exact combination is locked when the
build runs. Bumping any of the three creates a new manifest
version; the old build remains reproducible.

---

## Hardware Presets

### Pi Zero 2 W — "Light Edge"
- 512 MB RAM, low power, ARM v8 quad-core
- Use cases: kiosks, RaspberryJack portable nodes, light dashboards
- Default stack: lightweight OS (DietPi recommended), SSH, minimal services

### Pi 4 — "Standard Node"
- Balanced performance, GUI capable
- Use cases: kiosks, signage, dashboards

### Pi 5 — "High Performance"
- High compute, multi-service capable, needs official 5V/5A PSU
- Use cases: complex dashboards, local compute, container workloads

### Headless Node
- No display assumed, service-only
- Use cases: APIs, bridges (e.g. OBD bridge), background agents

## Purpose Presets

| Purpose | What it does |
|---|---|
| Kiosk Display | Chromium fullscreen, locked URL, autoreload, cursor hidden, blanking disabled |
| Dashboard Node | Web UI / admin panel, persistent session, optional local services |
| Portable Node (RaspberryJack) | Battery-aware (PiSugar), low-power mode, WiFi fallback, SSH, offline-first |
| Digital Signage | Timed content rotation, scheduled reboot, display calibration, watchdog |
| Service Node | No GUI, minimal OS, SSH + services, fast boot priority |

## OS / Image Base Layer

| OS | Notes | Best for |
|---|---|---|
| **DietPi** (default) | Minimal Debian; fast boot; lowest RAM | Pi Zero 2 W, kiosks, embedded |
| **Pi OS Lite** | Standard minimal Debian; high compatibility | General kiosks, stable production |
| **Pi OS Desktop** | Full GUI + Chromium + LXDE | Local UI systems, dev/test |
| **Ubuntu Server ARM** | Container-friendly, heavier | Backend nodes, future Docker |
| **Ark Minimal** | Stripped Linux base; Ark installs everything deterministically | Edge devices needing strict consistency |

Each OS implies different base-image fetch path, package manager,
and bootloader/`config.txt` patching strategy. The build engine
selects the correct one from a per-OS adapter.

---

## Versioning rules

**Presets are immutable once used in a build.**

- Changing any field creates a NEW preset version. The old version
  remains in the library.
- A manifest references presets by `<preset_id>@<version>` — e.g.
  `hw/pi-zero-2w@1.2`, `purpose/kiosk@2.0`, `os/dietpi@trixie-2026-05`.
- Builds are reproducible: re-running a build with the same
  manifest references should produce an identical image (modulo
  package-mirror timestamps).
- A "presets diff" view shows what changed between versions when a
  user is about to bump.

## UI integration model (per spec)

The device builder flow becomes a 5-step wizard (not strictly
linear — can be edited as a stack):

| Step | What |
|---|---|
| 1 | Hardware Selector — Pi model |
| 2 | Purpose Selector — kiosk / dashboard / portable / signage / service |
| 3 | OS Selector — DietPi / Pi OS Lite / Pi OS Desktop / Ubuntu / Ark Minimal |
| 4 | Configuration Layers — network / behaviour / kiosk / services (overrides) |
| 5 | Output — manifest, config bundle, .img build, cloneable template |

In the existing UI, this slots in by:
- Adding a "Presets" view (currently a stub) to the sidebar
- Rewriting the Identity layer to start from a `(hw, purpose, os)` triple
- Hardware layer / Software layer become preset-derived defaults that the user can override (delta tracking — see what's been customised from the preset)

---

## Why this isn't built yet

The current Phase 1 + 2 has:
- Flat manifest with hardcoded role-defaults (`applyRoleDefaults`
  in `manifest.js`)
- A single OS option (DietPi)
- No preset versioning

To honour the spec's reproducibility rule we need:
- A preset library (storage layer)
- Per-OS build adapters (DietPi vs. Pi OS vs. Ubuntu — different
  install paths, different config files)
- A preset-version pinning system

That's roughly the same scope as Phase 1 was. Realistic: Phase 2.

---

## Phase ordering

| Phase | What |
|---|---|
| 2.0 | This spec (now) |
| 2.1 | Preset data model + library storage |
| 2.2 | Hardware presets only — first wizard step |
| 2.3 | Purpose presets — combine with hardware to derive defaults |
| 2.4 | OS adapter pattern + DietPi/Pi OS Lite first two OSes |
| 2.5 | Pi OS Desktop + Ubuntu Server adapters |
| 2.6 | Ark Minimal Image — custom-built base |
| 2.7 | Versioning + diff view |
