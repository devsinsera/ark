# RaspyJack — Ark Build Module

Status: **Phase 2.x spec** + build profile stub. UI wiring + installer
execution = next session.

A dedicated Ark build profile that turns a stock Raspberry Pi into a
portable network-utility toolkit modelled on Hak5 Shark Jack-style
devices.

> **Authorization expectation (read first).**
> RaspyJack is a dual-use network toolkit. The Ark installer is
> generic — it executes whatever scripts the package contains. Use
> ONLY against devices you own and networks where you have written
> authorization to test (your own LAN, a client engagement, CTF
> infrastructure, lab environments). Ark logs every installer step
> and command run so the operator has an audit trail.

---

## Where it lives in Ark

```
ARK
└── BUILDS
    └── Raspberry Pi Devices
        ├── Kiosk            ← existing
        ├── Headless Node    ← existing
        ├── Portable Node    ← existing (covers PiSugar / RaspberryJack)
        └── RaspyJack        ← NEW (this doc)
```

Treated as a **first-class build profile**, NOT a script add-on or
plugin. It produces a complete deployable manifest just like Kiosk
or Headless does. The user picks "RaspyJack" the same way they pick
"Kiosk" in the Device Builder.

---

## Supported hardware

Any Pi model Ark's OS layer supports today:

| Model | Status |
|---|---|
| Pi Zero / Zero W | ✅ (32-bit DietPi or RPi OS Lite) |
| Pi Zero 2 W | ✅ (primary Ark target) |
| Pi 3 series | ✅ |
| Pi 4 series | ✅ |
| Pi 5 | ✅ (e.g. `SinseraCore`) |
| Other ARM64 Pi | ✅ if Ark's OS adapter accepts it |

Headless-by-default — display peripherals optional.

---

## Core function

RaspyJack provides:
- Automated installation of the user-supplied RaspyJack code package
- Hardware configuration (SPI / I2C optional, based on detected
  peripherals)
- Network-toolkit environment setup
- Optional LCD UI support when the hardware exists
- Headless CLI mode by default
- systemd service for auto-start on boot (configurable)

Default repository: `https://github.com/7h30th3r0n3/Raspyjack`
(can be overridden per-build).

---

## Build-tree integration

```
ark-root/
├── builds/
│   └── raspyjack/
│       ├── profile.json         ← build profile (this commit)
│       ├── install.sh           ← Ark's installer wrapper (next session)
│       ├── code/                ← user-supplied RaspyJack package
│       │   ├── install.sh       ← (or whatever entry point we resolve)
│       │   └── …
│       ├── config/              ← Ark-managed config overlay
│       ├── logs/                ← installer + runtime logs
│       └── exports/             ← backup + export bundles
└── manifests/
    └── raspyjack-<device>.json  ← manifest produced by this profile
```

On the Pi (after install):
```
/ark/builds/raspyjack/
├── code/                 ← exact mirror of the local builds/raspyjack/code/
├── config/
├── logs/
└── exports/
```

---

## Install flow diagram

```
       ┌────────────────────────────────────────────┐
       │   User picks "RaspyJack" in Device Builder │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   Code Package input field                 │
       │   one of:                                  │
       │     A. Git URL  (default: 7h30th3r0n3/…)   │
       │     B. ZIP upload                          │
       │     C. Local folder pick                   │
       │     D. Script bundle                       │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   Ark resolves entry point                 │
       │   priority order:                          │
       │     1. install.sh                          │
       │     2. setup.sh                            │
       │     3. install_*.sh   (latest dated)       │
       │     4. main.py                             │
       │     5. app.py                              │
       │   no match → fallback to manual            │
       │   multi-match → prompt select              │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   Manifest is rendered with RaspyJack      │
       │   layer overlay (packages, services,       │
       │   hardware enablement)                     │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   ark-builder render → boot-partition     │
       │   files written; Pi is flashed            │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   FIRST BOOT on Pi                         │
       │   Automation_Custom_Script.sh runs:       │
       │     - apt-get install git python3 pip     │
       │     - clone OR unpack code package        │
       │     - chmod +x scripts                    │
       │     - hardware detection                  │
       │       (SPI/I2C/LCD/USB-OTG/PiSugar)       │
       │     - run resolved entry point            │
       │     - install systemd unit (if profile    │
       │       wants auto-start)                   │
       │     - all output → /ark/builds/raspyjack/ │
       │       logs/install.log                    │
       └──────────────────┬─────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────────┐
       │   Device is online; agent (if enabled)    │
       │   reports back to the Hub                 │
       └────────────────────────────────────────────┘
```

---

## Supported entry-point formats

In strict priority order. If multiple are present, the higher-
priority one wins UNLESS the user explicitly picks otherwise in
the UI.

| Priority | Filename pattern | Interpreter | Notes |
|---|---|---|---|
| 1 | `install.sh` | bash | Canonical Ark/Hak5 convention |
| 2 | `setup.sh` | bash | Common Python-project install pattern |
| 3 | `install_*.sh` | bash | Glob — newest mtime wins if multiple |
| 4 | `main.py` | python3 | App-style packages |
| 5 | `app.py` | python3 | Flask/CLI patterns |
| 6 | `Makefile` (target: `install`) | make | Fallback if scripts absent |
| 7 | `requirements.txt` alone (no script) | pip3 | Bare lib install |
| 8 | none | manual | Open the file tree in Ark file-explorer mode |

Pre-execution rules (applied to every entry-point script):
- `chmod +x` for shell scripts
- Run as root inside the systemd unit context (Pi is single-user)
- Capture stdout + stderr to `logs/install.log`
- Capture exit code → manifest's `build_status`
- Inactive on second boot unless `auto_reinstall: true` in profile

---

## Hardware detection layer

Runs after the install, before any service-enable step. Each check
sets a flag the next step reads.

| Detector | What it checks | Action |
|---|---|---|
| SPI need | profile says `needs_spi: true` OR detected SPI device tree node | `raspi-config nonint do_spi 0` |
| I2C need | profile says `needs_i2c: true` OR /dev/i2c-* present | `raspi-config nonint do_i2c 0` |
| LCD attached | I2C addresses 0x27, 0x3C, 0x3D, 0x3F (common SSD1306/PCD8544) | enable display driver service |
| PiSugar | I2C 0x57 | install pisugar-server |
| USB OTG | Pi Zero / Zero 2 W with `dwc2` in config.txt | enable gadget mode if profile requests |
| No display | no HDMI/DSI/SPI displays present | force headless mode in manifest |
| Ethernet HAT | check `ip link` for eth1+ | adjust network config |

Detection results live in `/ark/builds/raspyjack/config/hardware.json`
so the runtime knows what's available.

---

## Build profile JSON

`Ark/builds/raspyjack/profile.json` — committed in this commit as a
stub. The Ark UI reads this to know what to expose in the
Device Builder.

```jsonc
{
  "profile_id":   "raspyjack",
  "version":      1,
  "category":     "raspberry-pi-devices",
  "name":         "RaspyJack",
  "description":  "Portable network-utility toolkit modelled on Hak5 Shark Jack.",
  "supported_hardware": [
    "pi-zero", "pi-zero-w", "pi-zero-2-w",
    "pi-3", "pi-3b+", "pi-3a+",
    "pi-4", "pi-4b",
    "pi-5",
    "pi-arm64-other"
  ],
  "default_role":   "portable_node",
  "default_boot":   "headless",
  "default_os":     "dietpi",
  "default_code_package": "https://github.com/7h30th3r0n3/Raspyjack",

  "code_package_inputs": [
    { "kind": "git",    "label": "Git repository URL" },
    { "kind": "zip",    "label": "Upload .zip" },
    { "kind": "folder", "label": "Pick local folder" },
    { "kind": "bundle", "label": "Script bundle (.tar.gz)" }
  ],

  "entry_point_priority": [
    "install.sh",
    "setup.sh",
    "install_*.sh",
    "main.py",
    "app.py",
    "Makefile",
    "requirements.txt"
  ],

  "hardware_detection": [
    "spi", "i2c", "lcd", "pisugar", "usb-otg",
    "display-present", "ethernet-hat"
  ],

  "base_packages": [
    "git", "python3", "python3-pip", "python3-venv",
    "build-essential", "libssl-dev"
  ],

  "optional_packages": {
    "lcd_present":    ["python3-luma.lcd"],
    "wifi_tools":     ["aircrack-ng", "iw", "wireless-tools"],
    "network_tools":  ["nmap", "tcpdump", "arp-scan"]
  },

  "services": {
    "auto_start_on_boot": false,
    "systemd_unit_name":  "raspyjack",
    "user":               "root",
    "restart_policy":     "on-failure"
  },

  "logs_dir":  "/ark/builds/raspyjack/logs",
  "install_dir": "/ark/builds/raspyjack/code",
  "exports_dir": "/ark/builds/raspyjack/exports",

  "backup_export": {
    "formats": ["zip", "tar.gz"],
    "includes": [
      "code/",
      "config/",
      "logs/",
      "system/pip-freeze.txt",
      "system/apt-list-installed.txt"
    ]
  },

  "authorization_notice":
    "RaspyJack is a network-utility toolkit with dual-use capabilities. By selecting this profile you confirm you are deploying it on hardware you own and networks where you have written authorization to test."
}
```

---

## Error handling matrix

| Failure | Detection | Auto-fix |
|---|---|---|
| `git` missing | `which git` empty | `apt-get install -y git` |
| `python3` missing | `which python3` empty | `apt-get install -y python3` |
| `pip3` missing | `python3 -m pip --version` errors | `apt-get install -y python3-pip` |
| Code-package URL unreachable | clone returns non-zero | prompt user for ZIP upload fallback |
| No entry-point script found | priority list exhausts | open Ark file-explorer mode (next-session UI) |
| Hardware mismatch (e.g. needs_spi=true, no SPI on this Pi) | detector returns false | log warning + run in degraded mode |
| systemd unit fails to start | `systemctl is-active` ≠ active | revert auto-start; record failure in `build_status` |
| Disk full during install | apt / pip exit 100 | abort + surface in install.log + manifest's build_status |

---

## Backup + export

From the Ark UI: `Build → RaspyJack → Export`

Includes:
- `code/` — exact copy of the installed package
- `config/` — Ark-managed config overlay (hardware.json, etc.)
- `logs/` — install + runtime logs
- `system/pip-freeze.txt` — `pip freeze` snapshot
- `system/apt-list-installed.txt` — `dpkg -l` snapshot

Output: single `.zip` or `.tar.gz`. SHA256 emitted alongside.
Excludes everything redaction-marked per Ark's universal security
rules — no creds, no SSH private keys, no Wi-Fi passwords.

---

## Assumptions + missing dependencies

These are real and worth flagging:

1. **The default repo URL hasn't been audited.** Ark blindly clones
   `https://github.com/7h30th3r0n3/Raspyjack`. The user is
   responsible for trusting that source. Recommend pinning to a
   specific commit hash in the profile once a known-good revision
   is verified.

2. **Ark UI doesn't have a file-upload control yet.** The "ZIP
   upload" + "Pick local folder" inputs in `code_package_inputs`
   require new components in the Device Builder. Phase 2.x work.

3. **No SSH runner exists yet.** The installer needs an
   "execute commands on a remote Pi" surface. Two options:
   - Run install at first-boot via `Automation_Custom_Script.sh`
     (file-based; works today)
   - Add `Ark/runner/` — a Node service on the user's Mac that
     SSHs into the Pi and runs commands interactively (better UX
     but a new sub-system to build)

4. **Hardware detection requires the Pi to be online before any
   detection runs.** First-boot detection happens AFTER apt
   install, AFTER WiFi joins. Order of operations matters.

5. **systemd auto-start needs the unit file template.** Not
   in this commit — write next session, based on a known
   RaspyJack entry-point shape.

6. **Backup export to the Mac.** Right now `exports_dir` is on
   the Pi. Pulling it back to the Mac needs either rsync from the
   Hub (Phase 4 work) or manual scp.

7. **Multi-profile coexistence.** What if a Pi has BOTH RaspyJack
   AND another build profile active (e.g. PortableNode + RaspyJack)?
   Manifest layering rules not defined yet. Avoid by treating
   build profiles as mutually exclusive in Phase 2.x.

---

## Phase ordering

| Phase | What |
|---|---|
| 2.x.0 | This spec (now) |
| 2.x.1 | Build profile JSON committed (now) |
| 2.x.2 | UI: "Builds → Pi → RaspyJack" tile in the Builds section of the Ark sidebar (when the Builds nav-stub is replaced) |
| 2.x.3 | First-boot installer wrapper (`builds/raspyjack/install.sh`) — uses Automation_Custom_Script.sh hook |
| 2.x.4 | Entry-point resolver + execution logging |
| 2.x.5 | Hardware detection layer |
| 2.x.6 | systemd unit template + service enable |
| 2.x.7 | ZIP upload control in the UI |
| 2.x.8 | Backup + export bundle |
| 2.x.9 | Verify end-to-end on `SinseraCore` Pi 5 — REAL boot |
