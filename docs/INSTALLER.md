# Ark Installer Engine (ARK-CORE)

Universal deployment engine for Ark Pi builds. Required core
subsystem — every build (including RaspyJack) flows through it.
Not a plugin, not a script runner; a **deterministic compiler** that
turns a build package into a reproducible first-boot install plan.

Implementation lives in `../installer/`. CLI: `node installer/bin/ark-install.mjs`.

> **Compiler, not remote runner.**
> The engine runs on the operator's machine, produces a `install.plan.sh`,
> and the Pi executes that script at first boot via DietPi's
> `Automation_Custom_Script.sh` hook. No SSH runner needed for v1 —
> matches Ark's existing render-then-flash flow exactly.

---

## Folder structure (Ark system)

```
Ark/
├── app/                          ← browser UI (sinsera.co/ark/)
├── hub/                          ← LAN discovery + agent collector (Node service)
├── builder/                      ← image render CLI (Phase 1) + chroot pipeline (Phase 3, stub)
├── installer/                    ← ★ NEW: ARK-CORE Installer Engine
│   ├── bin/
│   │   └── ark-install.mjs       ← CLI entry
│   ├── src/
│   │   ├── ingest.mjs            ← Input layer (git/zip/folder/bundle/raw)
│   │   ├── detect.mjs            ← Detection layer (entry-points/deps/hardware/arch)
│   │   ├── manifest.mjs          ← Manifest schema + auto-gen + reconcile
│   │   ├── compile.mjs           ← Pipeline (INIT→VALIDATE→PREPARE→INSTALL→CONFIGURE→FINALISE)
│   │   └── backup.mjs            ← tar.gz / zip export
│   ├── package.json
│   └── README.md
├── builds/                       ← every compiled build lives here
│   └── <build_name>/             ← normalised structure (mandatory)
│       ├── src/                  ← ingested package contents
│       ├── scripts/              ← engine-generated installer scripts
│       ├── config/               ← Ark-managed config overlay
│       ├── manifest.json         ← build manifest (auto-generated)
│       ├── install.log           ← engine log (compile-time)
│       ├── install.plan.json     ← machine-readable plan (audit + diff)
│       ├── install.plan.sh       ← rendered first-boot script
│       └── exports/              ← backup archives (.tar.gz / .zip)
├── docs/
│   ├── ARCHITECTURE.md           ← Ark v2 system spec
│   ├── INSTALLER.md              ← (this file)
│   ├── RASPYJACK.md              ← first concrete build profile
│   ├── HUB.md, AGENT.md, EXPORT.md, NETWORK_LANDSCAPE.md, PRESETS.md
└── Os/                           ← cached base images (DietPi, RPi OS, etc.)
```

---

## Three-layer core architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  ARK INSTALLER ENGINE                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ① INPUT LAYER  (ingest.mjs)                                │
│     git URL / ZIP / folder / bundle / raw file              │
│        ↓ normalise → builds/<name>/src/                     │
│                                                              │
│  ② DETECTION LAYER  (detect.mjs)                            │
│     entry-points  • apt + pip deps                          │
│     hardware needs (SPI/I2C/GPIO/LCD)                       │
│     architecture (armv6/armv7/arm64)                        │
│        ↓ detection report                                    │
│                                                              │
│  ③ EXECUTION PIPELINE  (compile.mjs)                        │
│     INIT → VALIDATE → PREPARE → INSTALL → CONFIGURE → FIN  │
│        ↓ install.plan.json + install.plan.sh                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
            Pi first boot runs install.plan.sh
            (via DietPi Automation_Custom_Script.sh)
```

---

## Standard build structure (mandatory)

Every build is normalised into this exact layout. Engine refuses to
proceed if a stage's prerequisite is missing.

```
/ark/builds/<build_name>/
    src/             ← normalised package contents (no .git/)
    scripts/         ← engine-generated installer scripts
    config/          ← Ark-managed config overlay
    manifest.json    ← build manifest (REQUIRED; auto-generated)
    install.log      ← human-readable engine log
    install.plan.json ← machine-readable plan
    install.plan.sh  ← first-boot bash script (the artefact the Pi runs)
```

---

## Manifest system

Every build MUST have a `manifest.json` at the build's root. If the
ingested package ships one, the engine reconciles operator values
with detection (operator wins for top-level fields, detection fills
gaps). If absent, the engine auto-generates a complete one.

Schema (v1):
```jsonc
{
  "schema_version": 1,
  "name":           "<build_name>",
  "version":        "auto-detected",
  "type":           "pi-build",
  "entry_points":   ["install.sh", "setup.sh", "main.py"],
  "dependencies": {
    "apt": ["git", "python3-pip"],
    "pip": ["RPi.GPIO", "luma.lcd"]
  },
  "hardware": {
    "spi":  false,
    "i2c":  false,
    "gpio": true,
    "lcd":  false
  },
  "architecture": ["armv6", "armv7", "arm64"]
}
```

Validation runs at VALIDATE stage. Failures abort with a structured
error list (never a stack trace) so the UI can render them.

---

## Detection rules

### Step 1 — File scan
Walk `src/`, skip `node_modules/`, `.git/`, `__pycache__/`. Collect
every file path.

Entry-point priority (single source of truth in `detect.mjs`):

| # | Pattern        | Notes                                  |
|---|----------------|----------------------------------------|
| 1 | `install.sh`   | Canonical                              |
| 2 | `setup.sh`     | Common Python convention               |
| 3 | `install_*.sh` | Glob — sorted lexicographically        |
| 4 | `main.py`      | App-style                              |
| 5 | `app.py`       | CLI/Flask                              |
| 6 | `Makefile`     | Fallback with `make install` target    |

The compiler picks `entry_points[0]` to execute. The rest are
recorded for the operator to see in the UI.

### Step 2 — Dependency extraction

- `requirements.txt` → `pip` deps
- `apt-get install <pkgs>` (any `.sh` / `.bash` / `Makefile`) → `apt` deps
- `pip3? install <pkgs>` (any shell script) → `pip` deps
- `package.json` → captured for future Node deps (Phase 2.x)

Versions are stripped; pip resolves the rest.

### Step 3 — Hardware detection (keyword scan)

| Flag | Trigger keywords                                    |
|------|-----------------------------------------------------|
| spi  | `\bspi\b`, `spidev`, `do_spi`                       |
| i2c  | `\bi2c\b`, `smbus`, `do_i2c`                        |
| gpio | `\bgpio\b`, `RPi.GPIO`, `gpiozero`, `libgpiod`      |
| lcd  | `\blcd\b`, `ssd1306`, `luma.lcd`, `framebuffer`,    |
|      | `st7735`, `ili9341`, `pcd8544`                      |

Scanned files: `.py`, `.sh`, `.cfg`, `.conf`, `.ini`, `.md`, `.txt`,
`.json`, `.yaml`, `.yml`. GPIO defaults true (almost every Pi build
imports it) — others default false.

### Step 4 — Architecture detection

Default `[armv6, armv7, arm64]` (most Python/shell builds run
everywhere). Narrowed only when:
- `package.json` `cpu` field excludes arm/arm64
- Future: ELF inspection of precompiled `.so` files

---

## Execution pipeline

Strict ordering. Same input → same output (deterministic).

```
INIT      build_dir exists; src/ populated; manifest read/generated; reconciled
   ↓
VALIDATE  manifest schema valid; entry-point exists OR fallback flagged;
          architecture compatible OR override required
   ↓
PREPARE   apt-get update; install base packages (git, python3, pip, curl,
          ca-certificates); install detected apt + pip deps
   ↓
INSTALL   execute chosen entry-point (bash / python3 / make);
          output → /var/log/ark-install.log (on Pi)
   ↓
CONFIGURE raspi-config SPI/I2C if needed; chmod +x scripts;
          optional systemd unit if profile requests auto-start
   ↓
FINALISE  write /ark/registry/<name>.json so the Agent reports the
          new build at next telemetry tick
```

Each stage emits **typed step records**. The renderer turns records
into the actual bash. Step types live in `compile.mjs::renderStep`:

| Type              | Renders to                                       |
|-------------------|--------------------------------------------------|
| `apt.install`     | `apt-get install -y …`                           |
| `pip.install`     | `pip3 install --break-system-packages …`         |
| `exec.bash`       | `cd ... && chmod +x ... && bash ./entry`         |
| `exec.python`     | `cd ... && python3 ./entry`                      |
| `exec.make`       | `cd ... && make install`                         |
| `raspi-config`    | `raspi-config nonint do_spi 0` (etc.)            |
| `chmod.recursive` | `find ... -name '*.sh' -exec chmod +x {} +`      |
| `systemd.unit`    | heredoc unit file + `systemctl daemon-reload` + `enable --now` |
| `register`        | `echo {...} > /ark/registry/<name>.json`         |
| `fallback.manual` | logs the situation; operator handles manually    |
| `note`            | log-only annotation                              |

Renderer guarantees:
- `set -e` + `set -o pipefail` at the top
- Every command logged to `/var/log/ark-install.log`
- `ark_log` / `ark_run` helpers for consistent output
- Shell-safe quoting for all operator-supplied strings

---

## Build lifecycle diagram

```
   ┌────────────────────────┐
   │  Operator picks build  │
   │  + source input        │
   └────────────┬───────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ INPUT (ingest.mjs)                         │
   │   normalise → builds/<name>/src/           │
   └────────────┬───────────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ DETECTION (detect.mjs)                     │
   │   entry-points • deps • hardware • arch    │
   │   → detection report                       │
   └────────────┬───────────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ PIPELINE (compile.mjs)                     │
   │   INIT       validates dirs, reads/gens    │
   │              manifest, reconciles shipped  │
   │   VALIDATE   schema, arch, entry-point     │
   │   PREPARE    typed apt/pip install steps   │
   │   INSTALL    typed exec step (bash/py/make)│
   │   CONFIGURE  raspi-config, chmod, systemd  │
   │   FINALISE   register in /ark/registry/    │
   │   → install.plan.json + install.plan.sh    │
   └────────────┬───────────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ FLASH (builder/ render — existing)         │
   │   write install.plan.sh as                 │
   │   Automation_Custom_Script.sh on SD card   │
   └────────────┬───────────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ Pi FIRST BOOT                              │
   │   DietPi runs install.plan.sh              │
   │   → apt → pip → entry-point → raspi-config │
   │   → systemd → register → online            │
   └────────────┬───────────────────────────────┘
                │
                ▼
   ┌────────────────────────────────────────────┐
   │ Ark Agent reports build to Hub             │
   │ (existing Phase 4.2 spec)                  │
   └────────────────────────────────────────────┘
```

---

## Supported input types

| Type      | Detection                              | Implementation                  |
|-----------|----------------------------------------|---------------------------------|
| `git`     | `^https?://` / `^git@` / ends `.git`   | `git clone --depth 1`           |
| `zip`     | ends `.zip`                            | `unzip -q`                      |
| `bundle`  | ends `.tar.gz` / `.tgz` / `.tar`       | `tar -xzf`                      |
| `folder`  | path is a directory                    | `cp -R src/. dest/`             |
| `raw`     | path is a single file                  | `cp src dest/`                  |

All inputs end up under `builds/<name>/src/` with a flat tree (the
engine collapses a single top-level directory when GitHub zip/tar
archives include one).

---

## Error handling matrix

| Failure                          | Detection                              | Engine response                            |
|----------------------------------|----------------------------------------|--------------------------------------------|
| `git` missing on operator host   | `git clone` exits non-zero             | Engine error — operator must install git   |
| `git` missing on Pi              | (handled in plan)                      | PREPARE installs git via apt-get           |
| `python3` / `pip3` missing on Pi | (handled in plan)                      | PREPARE installs them                      |
| Broken repo URL                  | clone exits non-zero                   | Quarantine src/; operator can retry with ZIP fallback |
| No entry-point found             | detection returns empty `entry_points` | `fallback.manual` step recorded; plan emits explicit FALLBACK_MANUAL line |
| Architecture mismatch            | `targetArch` ∉ `manifest.architecture` | WARN logged; operator must pass `--force` (Phase 2.x) |
| Hardware referenced but absent   | (Pi-side; detected post-boot)          | Plan logs NOTE; entry-point should self-handle |
| systemd unit start fails         | `systemctl is-active` ≠ active         | Logged; doesn't abort install              |
| Disk full during install         | apt/pip exits 100                      | `set -e` aborts; install.log surfaces      |

---

## Integration

Builds → Raspberry Pi Devices → **all builds** (including RaspyJack)
flow through this engine. RaspyJack is NOT special-cased — it's just
the first concrete package to use the pipeline:

```sh
node installer/bin/ark-install.mjs run \
  https://github.com/7h30th3r0n3/Raspyjack \
  --as raspyjack-build \
  --profile raspyjack
```

`--profile raspyjack` loads `builds/raspyjack/profile.json` and
applies it during CONFIGURE (e.g. whether to enable `systemd` auto-
start, which optional packages to add).

---

## Missing assumptions + risks

Honest list — these are real gaps the engine doesn't paper over:

1. **No remote execution surface.** v1 produces `install.plan.sh`;
   the Pi runs it at first boot. If a Pi is already online and
   the operator wants to push a new build, we need either:
   - Re-flash (works today, slow)
   - SSH runner (`Ark/runner/`, not built — Phase 2.x)

2. **Hardware detection is keyword-based, not semantic.** A README
   mentioning "SPI is not used" still triggers the SPI flag. Operators
   can override flags by shipping a `manifest.json` in the package's
   `src/` root — the reconciler honours their values.

3. **Architecture detection is weak.** Without ELF inspection of
   `.so` files we can't reliably narrow from `[armv6, armv7, arm64]`.
   Operators should set `architecture` explicitly when the package
   has compiled artifacts.

4. **No sandbox.** Entry-point scripts run as root on the Pi at first
   boot. Source trust is the operator's call. The engine logs every
   command but does NOT block dangerous patterns.

5. **`apt-get update -y` runs unconditionally** in the bootstrap. On
   metered connections this hurts. Future flag: `--skip-apt-update`.

6. **pip uses `--break-system-packages`.** Modern Debian / Pi OS
   block system-wide pip installs without this flag. A cleaner
   long-term answer is per-build venvs at
   `/ark/builds/<name>/venv/`; not done in v1.

7. **No multi-profile coexistence.** If two builds both want
   systemd unit named `raspyjack` the second overwrites the first.
   Profile validator should reject collisions (Phase 2.x).

8. **No rollback.** Once `install.plan.sh` runs and apt-installs
   things, undoing it requires re-flashing. We don't snapshot the
   pre-install state. A cheap improvement: store
   `apt-mark showmanual` before install so we can compute the diff.

9. **`fallback.manual` is honest but not interactive.** When there's
   no entry-point the plan logs a clear message and exits. The
   operator must SSH in. A future UI affordance (file-browser
   exploration of `src/`) is spec'd but not built.

10. **Default repo URLs in profiles aren't pinned.** RaspyJack's
    profile points at `main` of `7h30th3r0n3/Raspyjack`. Builds are
    only reproducible if profiles pin to commit SHAs. Phase 2.x
    work: add `default_commit` field; engine clones at that SHA.

---

## Phase ordering

| Phase  | What                                                 |
|--------|------------------------------------------------------|
| 2.0    | Engine code (this commit) — ingest/detect/compile/backup CLI working locally |
| 2.1    | Wire into Ark UI: "Build → Pi → \<profile\>" runs the engine via the Hub |
| 2.2    | UI file-upload control for ZIP / folder / bundle inputs |
| 2.3    | Commit-SHA pinning in profiles (reproducible builds) |
| 2.4    | Per-build pip venv (no `--break-system-packages`)    |
| 2.5    | Architecture detection via ELF inspection            |
| 2.6    | First end-to-end Pi boot using a real plan           |
| 3.x    | SSH runner (`Ark/runner/`) for online-Pi updates     |
