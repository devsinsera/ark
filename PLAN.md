# Ark — Plan

Ark is a **deterministic device compiler** for Raspberry Pi (and
future ARM SBC) deployments. Manifest in, flashable image out.

> "Ark is not a kiosk config form. Ark is a device compiler."

This file is the canonical spec. Supersedes the earlier
"Sinsera Pi Kiosk Builder" doc.

---

## Architecture

```
┌──────────────────────── browser side ───────────────────────┐
│                                                              │
│   Device Stack UI    →    Manifest (JSON)                    │
│                                ↓                             │
│                      Validation Engine                       │
│                                ↓                             │
│                      Build Plan Generator                    │
│                                ↓                             │
│                          plan.json                           │
└──────────────────────────────│───────────────────────────────┘
                               │     (downloads + drops on Linux)
                               ↓
┌──────────────────────── Linux side ─────────────────────────┐
│                                                              │
│   ark-builder render    →    dietpi.txt + autostart.sh       │
│                                                              │
│   ark-builder build     →    ark-<name>-vN.img + sha256.xz   │
│                              (Phase 3 — chroot pipeline)     │
└──────────────────────────────────────────────────────────────┘
                               ↓
                         Flash SD with Imager
                               ↓
                         Boot Pi → kiosk live
                               ↓
                  (optional) Pi reports telemetry to Supabase
                               ↓
                          Fleet dashboard
```

The **plan.json** is the contract between sides. Same input → same
output, regardless of who's running the renderer. That's
determinism.

---

## Repo layout

```
Ark/
├── PLAN.md               ← this file
├── Os/                   ← gitignored, large .img files
│   └── DietPi_RPi5-*.img
├── app/                  ← browser-side UI (Vite + React)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── manifest.js   ← data model + storage + role defaults
│   │   ├── output.js     ← legacy renderer (kept for live preview)
│   │   ├── build_plan.js ← NEW: emits plan.json
│   │   └── lib/theme.js
│   └── scripts/deploy.sh
└── builder/              ← Linux-side image compiler (Node CLI)
    ├── ark-builder.mjs
    ├── lib/
    │   ├── render.mjs    ← Phase 1: plan → text files
    │   └── build.mjs     ← Phase 3 stub
    └── README.md
```

---

## The manifest

Every device is a manifest with six layers (per spec). See
`app/src/manifest.js` for the schema. Phase 1 in `emptyManifest()`:

| Layer | Owns |
|---|---|
| `identity` | name, role, version |
| `hardware` | Pi model, PiSugar, display, ethernet HAT, GPIO, power notes |
| `network` | hostname, WiFi, static IP, SSH, SSH keys, mDNS |
| `software` | OS (DietPi), packages, services, boot target, timezone, root password |
| `kiosk` | URL, fullscreen, auto-reload, hide cursor, blanking, rotation, fallback page |
| `behaviour` | watchdog, auto-reboot schedule, offline fallback, recovery rules |

---

## Roadmap

### ✅ Phase 0 — Scaffold
Vite + React standalone app at `Ark/app/`; deploy target
`sinsera.co/ark/` (HostGator); GitHub repo `devsinsera/ark`.

### ✅ Phase 1 — Manifest + config + browser UI (THIS BUILD)
- Manifest data model + defaults + role-aware autoconfig
- localStorage manifest library (named save / load / clone / delete)
- Validation engine — hardware-aware warnings, compatibility score
- Build plan generator (`build_plan.js`) — emits structured `plan.json`
- Live preview of dietpi.txt / autostart / plan.json
- Browser-side rendering for instant download
- **Builder CLI (`builder/ark-builder.mjs render`)** — parity rendering for CI
- SSH key injection, headless mode, screen rotation, auto-reload

### 🚧 Phase 2 — Builder UX + multi-device
- 3-pane workspace: Nav (Devices/Builds/Manifests/Presets/Fleet/Images/Logs) · Device Stack · Validation
- Build Output drawer (Config / Image / Manifest tabs)
- Clone-with-overrides workflow (already in data model — needs UI)
- Batch zip of N devices' files
- Manifest JSON import (currently export-only)
- Diff view between two manifests
- Compatibility-warning rules engine (a real graph, not a flat list)

### 🟡 Phase 3 — Image builder pipeline
The 11-step chroot pipeline in `Ark/builder/lib/build.mjs`. Linux
only. Requires:
- `qemu-user-static` + `binfmt-support`
- `losetup` / `kpartx`
- `parted`
- `xz-utils`
- `sudo`

Realistic execution surfaces:
- **GitHub Actions workflow** — committed plan triggers build,
  emits artefact + checksum
- **Local Linux box** (Pi runs Linux, anyone can build on a Pi)
- **macOS via Docker/OrbStack/Lima** — Linux container with the above

### 🔵 Phase 4 — Fleet runtime
Devices POST telemetry to a Supabase / edge function. UI subscribes
via Realtime. Per-device card with uptime / CPU temp / RAM / disk /
WiFi RSSI / PiSugar battery / service health / last reboot reason.
Fleet grid view + alerts.

### 🟣 Phase 5 — Discovery + drift
SSH-scan a network → import devices into Ark. Compare to manifests
→ flag drift (e.g. installed Chromium 121, manifest says "any").

---

## What's NOT in scope

- **Non-Pi hardware** — no general ARM SBC support, no x86 nodes.
- **OTA updates** to already-deployed devices.
- **Per-device DRM / vault secrets**.
- **Backend** for Phase 1 + 2. Everything is browser + localStorage
  + a separate Linux build host.

---

## How to use today (Phase 1)

### From the browser UI
1. Open `https://sinsera.co/ark/`
2. Build a manifest (Identity → Hardware → Network → … → Kiosk)
3. Right panel shows live validation
4. Bottom drawer → CONFIG tab → download `dietpi.txt` +
   `Automation_Custom_Script.sh`
5. Flash a stock DietPi image with Raspberry Pi Imager
6. Drop the two files onto the boot partition
7. Boot the Pi

### From the CLI (parity for CI)
1. From the UI → Bottom drawer → CONFIG tab → download `plan.json`
2. On a Linux machine:
   ```
   cd Ark/builder
   node ark-builder.mjs render --plan ~/Downloads/plan.json --out ./build/
   ```
3. `./build/dietpi.txt` + `./build/Automation_Custom_Script.sh` —
   byte-identical to what the browser would have emitted.

---

## How to use later (Phase 3 — when image builder lands)

```
node ark-builder.mjs build \
  --plan ~/Downloads/plan.json \
  --base Ark/Os/DietPi_RPi5-ARMv8-Trixie.img \
  --out  /tmp/ark-out/
```

Output: `ark-<device-name>-v1.img` + `.xz` + `.sha256`. Flash that
.img with Imager → boot → device is already fully configured.

---

## Realistic development rule

> Do not over-engineer fleet / telemetry first.
> Start with: manifest + config + image-builder pipeline.
> Then iterate based on real Pi boot results.
> Primary validation: flash SD → boot Pi → observe failure → refine.

(Verbatim from the user's Ark spec — kept here so it never gets
lost.)

---

## Reference

| | |
|---|---|
| Live app | `https://sinsera.co/ark/` |
| Repo | `https://github.com/devsinsera/ark` |
| Browser deploy | `cd app && npm run deploy` (lftp → HostGator `/ark/`) |
| Builder CLI | `cd builder && node ark-builder.mjs --help` |
| Local OS images | `Ark/Os/*.img*` (gitignored) |
