# Ark Image Builder (Phase 3)

Pre-bakes apt + pip installs into a Pi `.img` file so first boot on
the Pi is near-instant. Without Phase 3, a freshly-flashed card takes
3–5 minutes on first boot (apt-get update + install). With Phase 3,
the same card boots ready-to-use in ~30 seconds.

Lives in `builder/`. Used by `node ark-builder.mjs build …`.

---

## How it works

```
┌───────────────────────┐
│ manifest.json         │  (from the device manifest UI)
└──────────┬────────────┘
           ↓ Installer Engine (Phase 2)
┌───────────────────────┐
│ install.plan.sh       │  (deterministic first-boot script)
└──────────┬────────────┘
           ↓
   ark-builder build
           │
   ┌───────┴───────┐
   ▼               ▼
┌──────────┐  ┌──────────────────────────────┐
│ base.img │  │ Dockerfile.arkbuild          │
│ DietPi/  │  │  + chroot-run.sh             │
│ Pi OS    │  └─────────────┬────────────────┘
└────┬─────┘                ↓
     │            ┌──────────────────────────┐
     └───────────▶│ Linux container (priv'd) │
                  │  losetup + mount + chroot│
                  │  → run install.plan.sh   │
                  │     inside the rootfs    │
                  └───────────┬──────────────┘
                              ↓
                  ┌──────────────────────────┐
                  │ ark-built.img            │
                  │ ark-built.sha256         │
                  │ ark-build.log            │
                  └──────────────────────────┘
                              ↓
                       dd to SD card → flash
```

The chroot pipeline runs in a Linux container so macOS hosts can drive
it without needing a Linux VM directly. Apple Silicon Macs run the
container as native arm64 (no emulation, full speed); Intel Macs and
x86 Linux hosts emulate arm64 via qemu-user-static (~3× slower but
identical result).

---

## File layout

```
builder/
├── ark-builder.mjs          ← CLI: render | build | check
├── Dockerfile.arkbuild      ← image-builder runtime (debian:bookworm-slim + tools)
├── lib/
│   ├── render.mjs           ← Phase 1 renderer (dietpi.txt + autostart)
│   ├── build.mjs            ← Phase 3 orchestrator (Node-side)
│   └── chroot-run.sh        ← runs INSIDE the container; does the actual work
├── package.json
└── README.md
```

---

## Prerequisites

A container runtime. Any one of:

| Option | Install (macOS)                                  | Pros / cons                                   |
|--------|--------------------------------------------------|-----------------------------------------------|
| Colima | `brew install colima docker && colima start --arch aarch64 --cpu 2 --memory 4` | Recommended: free, lightweight (~1 GB)        |
| Docker Desktop | https://docker.com/products/docker-desktop  | Heavier (~5 GB), GUI bundled                  |
| Podman | `brew install podman && podman machine init && podman machine start` | Daemon-less; needs `--runner podman` flag     |

Check whether your host is ready:

```sh
node builder/ark-builder.mjs check
```

Sample output on a clean Mac:

```
host:     darwin/arm64
docker:   ✗
podman:   ✗
colima:   ✗

✖ No container runtime found.
  Install one:
    brew install colima docker && colima start --arch aarch64 --cpu 2 --memory 4
```

---

## Building an image

End-to-end on the local Mac:

```sh
# 1) Generate a manifest in the browser UI (sinsera.co/ark/), then
#    export plan.json from the build-output drawer.
#
# 2) Run the engine to produce install.plan.sh:
node installer/bin/ark-install.mjs run \
  https://github.com/<your-package> \
  --as my-build --profile <profile>

# 3) Build the .img:
node builder/ark-builder.mjs build \
  --plan  builds/my-build/install.plan.sh \
  --base  Os/DietPi_RPi5-ARMv8-Trixie.img \
  --out   builds/my-build/out

# 4) Flash:
dd if=builds/my-build/out/ark-built.img of=/dev/diskN bs=4M status=progress
```

The `--plan` argument can be either `install.plan.sh` (the bash form;
what the Pi executes at first boot) or `install.plan.json` (the typed
form). The chroot script takes the bash one.

### Flags

| Flag             | Purpose                                                        |
|------------------|----------------------------------------------------------------|
| `--plan <path>`  | Install plan from the Engine                                   |
| `--base <path>`  | Base `.img` to start from (DietPi / Pi OS / Ubuntu Server)     |
| `--out <dir>`    | Where to write `ark-built.img` + `ark-built.sha256` + log      |
| `--runner <cmd>` | `docker` (default), `podman`, etc. — override runtime detection|
| `--skip-install` | Mount + bind only; don't run the plan inside the chroot. Use for debugging the pipeline itself. |

---

## What lands in the output

```
<outDir>/ark-built.img       — final image, ready to flash
<outDir>/ark-built.sha256    — sha256 of the .img
<outDir>/ark-build.log       — every line stdout/stderr from the pipeline
```

The .img is the same size as the base (the chroot doesn't grow the
filesystem; it just pre-populates it). Some images include unused
space that can be reclaimed with `qemu-img convert` post-build — left
out of scope for v1.

---

## The chroot pipeline (chroot-run.sh)

Exactly 9 steps, each idempotent, all wrapped in an EXIT trap that
unwinds mounts + loop devices even on partial failure:

1. **Copy** base → output (reflink where supported; doesn't mutate source)
2. **losetup** the output image with `--partscan`; partprobe to settle
3. **Mount** boot partition (`p1`) + root partition (`p2`)
4. **Bind** `/dev`, `/dev/pts`, `/proc`, `/sys` into the rootfs
5. **Cross-arch** prep: copy `qemu-aarch64-static` into `<root>/usr/bin/` when host ≠ image arch
6. **DNS**: copy `/etc/resolv.conf` so apt inside the chroot can reach mirrors
7. **Stage** the install plan to `<root>/ark/install.plan.sh`
8. **chroot** + execute the plan (or skip if `ARK_SKIP_INSTALL=1`)
9. **Sanitise** apt cache, machine-id, logs, bash history — same outcome regardless of host

The script exits with the chroot's exit code; the orchestrator surfaces
non-zero codes as `ok: false` with the log path for debugging.

---

## Security expectations

- The container runs `--privileged` (required for loop devices + mount).
  Operators must trust the Dockerfile + chroot-run.sh.
- The base `.img` is whatever the operator chooses. No implicit fetch
  from the network — supplying a malicious base is operator's call.
- The install plan is the same plan the Pi would have run at first
  boot. No new attack surface introduced by pre-baking it.
- Output `.img` files NEVER contain secrets unless the operator
  explicitly put them in the install plan. The sanitisation step
  wipes `apt-get clean`, machine-id, `~/.bash_history`, logs.

---

## Limitations + missing assumptions

Honest list — Phase 3 ships v1; refinements come later:

1. **Output compression not done.** v1 writes raw `.img`. xz compression
   to match the upstream DietPi tarball shape is a Phase 3.1 follow-up.
2. **No image-size shrinking.** Some bases ship with ~6 GB unused
   space. `qemu-img convert` or `resize2fs` could shrink before xz
   compression; not in v1.
3. **Single partition layout assumed.** `p1` = FAT32 boot, `p2` = ext4
   root. Works for DietPi, Pi OS, Ubuntu Server; would fail on a custom
   layout with extra partitions.
4. **No signing.** The output `.sha256` is content integrity only,
   not provenance. GPG signing is Phase 3.2.
5. **No remote build runner.** The pipeline runs locally. CI builds
   (GitHub Actions) need a workflow file — not in v1.
6. **Privileged container required.** Some corporate Docker setups
   block `--privileged`. Rootless podman with `--userns=keep-id` and
   `--device /dev/loop-control` is theoretically possible but not
   tested.
7. **arm64 host preferred.** Cross-arch builds work on x86 hosts but
   are 3× slower because every binary inside the chroot runs through
   qemu emulation. For frequent builds, a small ARM box (or Apple
   Silicon) is recommended.
