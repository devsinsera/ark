# Ark Builder — Linux-side image compiler

The browser-side Ark UI emits a deterministic **build plan** (JSON).
This directory holds the **executor** — a Node CLI that reads a
build plan and produces a flashable `.img` file.

The executor MUST run on Linux. The 11-step pipeline mounts loop
devices, chroots into the ARM image (via `qemu-user-static`), runs
`apt-get install` inside the chroot, patches boot files, and
re-packages the result. None of that is possible on macOS native
(no loop devices, no chroot) or from a browser.

---

## The 11-step pipeline (per Ark spec)

```
MANIFEST                                  ← src input
  ↓
VALIDATION ENGINE                          (browser-side; rejects bad input)
  ↓
BUILD PLAN GENERATOR                       (browser-side; emits plan.json)
  ↓
─── boundary: plan.json crosses to Linux box ───
  ↓
BASE IMAGE FETCH         (Ark/Os/DietPi_*.img)
  ↓
IMAGE MOUNT + CHROOT     (losetup + mount + qemu-arm)
  ↓
CONFIG INJECTION         (dietpi.txt, autostart, services)
  ↓
SERVICE INSTALLATION     (apt-get install inside chroot)
  ↓
BOOT CONFIG PATCH        (config.txt, cmdline.txt)
  ↓
FIRST BOOT SCRIPT        (Automation_Custom_Script.sh)
  ↓
SANITISATION             (logs, temp files, build credentials)
  ↓
IMAGE EXPORT             (.img + sha256 + xz)
```

---

## Status

| Stage | Phase 1 (now) | Phase 3 (image builder) |
|---|---|---|
| Validation | ✅ browser-side | ✅ same |
| Build plan generation | ✅ browser-side | ✅ same |
| dietpi.txt / autostart text | ✅ browser-side | ✅ via `ark-builder render` |
| Image mount | ❌ | 🚧 to do |
| Chroot apt-install | ❌ | 🚧 to do |
| Image export | ❌ | 🚧 to do |

**Phase 1 deliverable** (which lives here): the `render` subcommand —
takes a `plan.json`, writes `dietpi.txt` + `Automation_Custom_Script.sh`
to a directory. Equivalent to what the browser already produces, but
runnable from CI / a Pi-side script.

**Phase 3 deliverable** (deferred): the `build` subcommand. Mounts
the base image, runs the chroot, exports the flashable .img.

---

## Usage (Phase 1)

```bash
# 1. Export a plan from the browser UI (Build Output → CONFIG → build-plan.json)
# 2. Save plan.json locally
# 3. Render the config files:
node ark-builder.mjs render --plan ./plan.json --out ./build/

# Output:
#   ./build/dietpi.txt
#   ./build/Automation_Custom_Script.sh
```

## Usage (Phase 3, planned)

```bash
node ark-builder.mjs build --plan ./plan.json \
                           --base /path/to/DietPi_RPi5-ARMv8-Trixie.img \
                           --out /tmp/ark-output/

# Output:
#   /tmp/ark-output/ark-<device-name>-v1.img
#   /tmp/ark-output/ark-<device-name>-v1.img.xz
#   /tmp/ark-output/ark-<device-name>-v1.img.sha256
```

### Phase 3 requirements (Linux only)

System packages:
- `qemu-user-static`  (chroot into ARM rootfs from x86 host)
- `binfmt-support`    (binfmt registration for `qemu-arm`)
- `parted`            (read partition table of the base .img)
- `kpartx` or `losetup` (set up loop devices)
- `xz-utils`          (compress output)
- Privilege: `sudo` access for loop / chroot / mount

On a Raspberry Pi running ARM Linux natively: most of those except
qemu-user-static (which isn't needed — you're already on ARM).

On a Mac: use a Linux container (Docker / OrbStack / Lima) with the
above packages installed.

On GitHub Actions: `ubuntu-latest` runner + a setup step that
apt-installs the above. Privilege should be available.

---

## Files

| File | Phase | Purpose |
|---|---|---|
| `ark-builder.mjs` | 1 | Node CLI entry point; `render` subcommand works today |
| `lib/render.mjs` | 1 | Pure rendering — takes a plan, writes text files. No chroot. |
| `lib/build.mjs` | 3 | Image-build executor. Skeleton present, returns "not implemented" today. |
| `lib/pipeline.mjs` | 3 | The 11-step orchestration. Skeleton. |
| `lib/util.mjs` | 1 | Tiny helpers (shell exec, path joins, hashes). |
| `package.json` | 1 | Pure-stdlib Node — no deps |

---

## Why no dependencies

The builder uses only Node's stdlib (`fs`, `path`, `crypto`, `child_process`).
The render path is filesystem + string templating. The build path
shells out to native binaries (`losetup`, `mount`, `chroot`,
`qemu-arm-static`) and reads their output — no npm packages buy us
anything there, and zero deps means no supply-chain risk for code
that runs as root on the build host.
