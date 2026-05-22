# Ark Flash Node

A Raspberry Pi (5 preferred) + USB SD reader / SSD becomes a network
imaging appliance. The Ark UI on a laptop sends image-write jobs to
the Flash Node Agent; the agent performs the write, verifies, and
reports progress back over WebSocket + REST.

Distinct from the Phase 3 image builder:
- **Image builder** (`builder/`) = compiles a `.img` from a manifest
- **Flash Node** (`agent/ark-flash-agent.py`) = burns a `.img` onto removable media

The two compose: build → register image → flash.

---

## Architecture

```
Laptop (browser at sinsera.co/ark/ → Flash Nodes tab)
    │
    │  HTTPS → HTTP on localhost
    ▼
Ark Hub (Node, ~/.ark/ark-hub.db SQLite)
    │  - flash_nodes  (registered Pis)
    │  - flash_images (image registry)
    │  - flash_jobs   (queue + state machine)
    │
    │  HTTP REST
    ▼
Flash Node Agent (FastAPI on the Pi, port 7410)
    │  - lsblk-based disk detection
    │  - hard safety layer (system disk / mounted / read-only blocks)
    │  - bmaptool preferred; chunked Python copy fallback
    │  - sha256 verify before AND sample-verify after
    │  - readable mount-test before reporting completed
    │  - WebSocket progress stream
    ▼
USB SD reader / SSD attached to the Pi
```

The browser talks to the Hub for orchestration (queueing, registry,
multi-network safety). For disk listings + WebSocket job streams the
browser talks **directly** to the Flash Agent at its `agent_url`
(faster + simpler than proxying through the Hub).

---

## Files added in this commit

```
hub/src/flash.mjs                 Storage layer: nodes / images / jobs tables,
                                  enqueue / update / cancel job lifecycle,
                                  early-bail safety validator.
hub/src/index.mjs                 + /api/flash/* endpoints (nodes / images /
                                  jobs / heartbeat / update / cancel / constants).
agent/ark-flash-agent.py          FastAPI service. Disk listing, write engine,
                                  safety, WebSocket progress, sha256 verify,
                                  mount-test.
agent/install-flash-agent.sh      One-shot installer: apt → python venv → pip
                                  fastapi + uvicorn → systemd unit → enable.
app/src/FlashNodes.jsx            4-tab UI panel (Nodes / Storage / Jobs /
                                  Clone-placeholder).
app/src/App.jsx                   Nav entry + route wiring.
docs/FLASH_NODE.md                This file.
```

---

## How the Flash Node Agent works

### Startup
1. Persistent `node_id` loaded from `/var/lib/ark-flash/node-id` (auto-
   generated on first run).
2. Calls `POST /api/flash/nodes/register` on the Hub with its
   `node_id`, name, hardware model, capabilities (`sd_write`,
   `ssd_write` when bmaptool is installed, `verify`), and `agent_url`.
3. Starts a heartbeat loop (every 30s).

### Disk detection
`lsblk -bJ` parsed into one record per top-level block device with:
- `path`, `name`, `size`, `model`, `vendor`, `transport`
- `removable` (kernel flag)
- `mounted` (recursive partition check)
- `readonly`
- `is_root_disk` (compared to `findmnt -n -o SOURCE /` walked back to the device)
- `safe_to_write` = removable AND NOT readonly AND NOT mounted AND NOT root

### Job lifecycle
States flow in this order (subset for any given job):
```
queued → preparing → writing → syncing → verifying → mount_test → completed
                                                                ↘ failed
                                                                ↘ cancelled
```

- `preparing`: sha256 of the staged image is computed and compared
  against `job.sha256`. Mismatch → `failed` (we never write a bad
  image, period).
- `writing`: bmaptool if available, else chunked Python copy with
  `fsync` at the end. Progress is pushed every ~1s (pct, bytes_written,
  speed, ETA).
- `syncing`: explicit `sync` after the write returns.
- `verifying`: sample-based — 8 random 1 MB segments of the target
  are compared to the source. Catches catastrophic write corruption
  without ballooning the verify time to "as long as the write".
- `mount_test`: mounts the first partition read-only, lists its
  contents, unmounts.
- `completed`: only after all the above succeeded.

### Safety layer (`assert_safe_target`)
Before writing, the agent re-checks the target (the Hub also did this
on enqueue — defense in depth):
- Disk must be in the current `lsblk` listing
- Must NOT be the root disk (unless `allow_root_override=true`,
  intended for emergency reflash-self workflows)
- Must NOT have a mounted partition
- Must NOT be read-only
- Must be removable (or `allow_root_override`)

All four conditions are HTTP-403 hard refusals.

---

## How jobs flow

```
1. Operator: Hub UI → Flash Nodes → pick image + node + target disk
2. UI:       POST /api/flash/jobs { node_id, image_id, target_disk_path }
3. Hub:      flash.enqueueJob() — early-bail validator + insert row
             returns job_id
4. (Future) The Hub pushes the job to the Flash Agent via:
               POST <agent_url>/jobs { hub_job_id, image_url, sha256,
                                        target_disk_path }
            For v1 the operator is expected to call the Flash Agent
            directly with the same payload. v2: Hub→Agent dispatcher.
5. Agent:    runs the lifecycle above. On each state change posts
               POST <hub>/api/flash/jobs/<hub_job_id>/update
             so the Hub's row stays current and the UI sees progress.
6. UI:       polls /api/flash/jobs every 4s and renders progress bars.
             (Optional: connects to <agent_url>/jobs/<id>/stream
             WebSocket for sub-second updates.)
```

---

## How disk safety works

Multiple gates between operator intent and a real write:

1. **UI side**: drop-down only lists disks the agent reported as
   `safe_to_write=true`. Locked disks show in the table with a
   padlock and can't be selected.
2. **Hub enqueue**: `flash.mjs::validateJobInput` refuses obviously
   dangerous targets (`/dev/sda` / `/dev/nvme0n1` / `/dev/mmcblk0`)
   without `confirm_root_disk_ok=true`. These names sometimes happen
   to be SD readers, but on most Pis they're the OS disk.
3. **Agent receive**: `assert_safe_target` re-runs all checks at the
   moment of dispatch. Disks come and go (USB unplug), so a target
   that was safe at enqueue may be unsafe now.
4. **Agent pre-write**: sha256 of the staged image is verified before
   one byte hits the disk.
5. **Agent post-write**: 8-sample read-back verification + read-only
   mount test before declaring success.

---

## What still needs building (honest)

The agent code is **untested against a real Pi** in this commit.
Before relying on it for production flashes:

1. **Validate on SinseraCore.** Install the Flash Agent
   (`sudo HUB_URL=… bash agent/install-flash-agent.sh`), plug in a
   USB SD reader with a spare SD card, and run an end-to-end flash
   of a small test image. The full flow (register → disks → enqueue
   → write → verify → mount-test) needs at-least-once confirmation.

2. **Hub → Agent dispatcher.** Right now the Hub stores the job but
   doesn't push it to the Agent automatically. Either:
   - the operator calls the Agent's `POST /jobs` directly with the
     same payload (v1), OR
   - the Hub polls for `queued` jobs and dispatches them (v2,
     simpler from the UI but adds a worker loop on the Hub).

3. **Chunked / resumable upload.** Large images (~1-2 GB)
   uploaded over the LAN can fail mid-transfer. Agent's `/upload`
   endpoint currently uses FastAPI's UploadFile which buffers in
   chunks but doesn't resume on failure.

4. **bmaptool path validated.** The agent prefers bmaptool when
   present; needs a real run-through to confirm progress parsing
   works against bmaptool's stderr format.

5. **Clone / Capture (Tab 4).** Source-side reads (SD → image, SSD →
   image, live-Pi golden-image) are placeholder. Schema + UI exist;
   agent endpoints don't yet.

6. **WebSocket from the browser.** UI currently uses 4 s REST polling
   of `/api/flash/jobs`. Wiring the browser to the Agent's
   `/jobs/<id>/stream` WebSocket gives sub-second progress at the
   cost of a second-network-path complexity.

7. **Multi-node job balancer.** If two flash nodes are registered
   with the same capabilities, there's no auto-selection yet.

8. **Image upload from the laptop.** The Hub's image registry stores
   metadata; physical bytes are expected to already exist somewhere
   the Flash Agent can fetch (Hub-hosted, or staged locally). A
   browser-side upload UI is missing.

9. **Job retry / re-queue.** The schema supports `cancelled` and
   `failed` states but there's no "retry this job" UI button yet.

---

## Future scaling paths

- **Flash farm**: multiple Pis on a switch, each with N USB SD
  readers. The Hub auto-selects an idle node + an idle reader.
  Schema already supports `node_id` + `target_disk_path` separation.
- **Image CDN**: large images served from a NAS / S3, with each Flash
  Agent caching by sha256. Image registry already records hashes; CDN
  layer plugs in at the Agent's `_fetch_image` call.
- **Parallel provisioning**: bulk-cut N cards at once from one image,
  each card mounting fresh with a different manifest_id.
- **Bring-your-own writer**: bmaptool is the default; the Agent can
  shell out to anything that writes a block device, e.g. `pv | dd`
  for prettier progress, or `etcher-cli` for cross-platform UX.
