---
name: verify
description: Verify Ark Pi-image recipes (builds/<profile>/install.sh + app/) by actually running the changed provisioning code on real aarch64 hardware, without owning the target Pi or baking a full image.
---

# Verifying an Ark recipe

Ark builds Raspberry Pi images: `builds/<profile>/install.sh` runs inside an
arm64 chroot during the bake and provisions the node. The obvious problem is
that **the target Pi usually doesn't exist yet** (recipes are written ahead of
hardware), and a full bake is slow and needs a Linux host with loop mounts.

## The unlock: Docker on Node 3

**Node 3 (`peta@192.168.4.182`) is a Pi 5 running Debian trixie aarch64 with
Docker and ~1.8 TB free.** A `debian:trixie` container there is the same arch
and OS family as the chroot the recipe actually runs in — close enough to run
the real provisioning code and observe it.

```bash
# stage the recipe
cd builds/<profile> && tar czf /tmp/r.tgz install.sh app/
scp /tmp/r.tgz peta@192.168.4.182:/tmp/verify/ && ssh ... 'cd /tmp/verify && tar xzf r.tgz'

# run the REAL block out of install.sh — extract it, don't retype it
ssh peta@192.168.4.182 "docker run --rm -v /tmp/verify:/src:ro debian:trixie bash -c '
  apt-get update -qq && apt-get install -y -qq curl ca-certificates tar
  APPSRC=/src/app; step(){ echo \"== \$* ==\"; }
  awk \"/^step \\\"<your step>/,/^step \\\"<next step>/\" /src/install.sh | sed \\\$d > /tmp/block.sh
  source /tmp/block.sh'"
```

Extracting the block with `awk` between `step "..."` markers means you run the
committed code, not a transcription that can drift from it.

## Running a service the recipe installs

Start it in a container with **ports remapped on the host side only**, so the
config file stays byte-identical to what gets baked and Node 3's own services
are untouched:

```bash
docker run -d --name t -p 21935:1935 -p 28888:8888 -p 28889:8889 ... 
```

Then drive it from the Mac against `192.168.4.182:2xxxx`. Node 3 already runs
mediamtx on 1935/8554/8888/8889/9997 and an eufy bridge — never bind those.

## Gotchas that cost time

- **Node 3's `ffmpeg-guard` reaps ffmpeg processes with PPID=1.** Test
  publishers must run under a bash parent:
  `sudo systemd-run --unit=x --collect -p RuntimeMaxSec=240 bash -c 'ffmpeg ...'`
- **mediamtx HLS does a cookie handshake** — `curl` needs `-c/-b` a cookie jar
  or you loop on `302 ?cookieCheck=1`. Safari handles it natively.
- **mediamtx rejects unknown config keys** (`ERR: json: unknown field`), so
  "configuration loaded" is real proof the keys are valid. Verify a setting
  actually applied via `curl /v3/config/global/get`, not by reading the yaml.
- **`nmcli --offline` is NOT supported** on trixie's NetworkManager, so you
  cannot validate a `.nmconnection` keyfile without installing it. Do **not**
  `nmcli connection load` an AP profile on Node 3 — `autoconnect=true` could
  make it try to start an access point and disrupt the node.
- **`sed` replacement strings**: `&` means "the whole match" and `\` escapes.
  Any user-supplied SSID/passphrase substituted with `sed` must be escaped
  (`sedesc()` in node5/install.sh) or it is silently corrupted — you get an AP
  whose password isn't the one you set, with no error. Always probe with
  `&`, `|`, `/` and `\` in the value.
- Recipes run under `set -euo pipefail`. If a step is meant to be non-fatal
  (an optional download), probe it by forcing the failure and checking the
  block still exits 0 and later steps are reached.

## Always clean up

`docker rm -f <name>`, `systemctl stop/reset-failed` any transient units, and
`rm -rf /tmp/verify` on Node 3 — it is a production node (kiosk + mediamtx +
eufy bridge + vigil archive), not a scratch box.
