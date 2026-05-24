# Ark — remaining work

Snapshot as of 2026-05-25 09:30 AEST. Read top-to-bottom; the order is
my honest recommendation for what to do next. Update or delete entries
as they ship.

---

## 🚦 Gated on real hardware (the four 🟡 from ARCHITECTURE.md)

Everything in Ark that's still 🟡 yellow comes down to **one thing**:
flash a Pi and let it phone home. Until then the Hub-side code can't
be validated end-to-end.

| 🟡 Marker | Unblocks once… |
|---|---|
| **Phase 4.2** Agent on Pi | A Pi running the Ark agent heartbeats `/api/devices/heartbeat` |
| **Phase 5.3** OTA self-update | Same Pi successfully pulls `/api/agent/download` and replaces itself |
| **Phase 6.2** Flash Node Agent | A Pi running `agent/install-flash-agent.sh` registers as a Flash Node |
| **Phase 7.3** Passive monitor | Pi-side `journalctl` tail reports defensive observations |

**The fastest unblock**: flash `~/Dev-Sinsera/Ark/builds/sinsera-installer/out/ark-built.img.xz` onto your spare SD card, boot the Pi, edit `/boot/dietpi.txt` for WiFi, run `flash-to-nvme` to write `sinsera-vanilla` onto the NVMe, set Pi 5 BOOT_ORDER=NVMe-first, reboot. ~20 min total.

---

## 🟡 Open features (named, not yet built)

### A — Network-layer device intelligence
**Status**: spec'd, not started. Three pieces:

1. **More columns in Network → Devices**: OS fingerprint (TTL + window size heuristic), open ports (TCP SYN scan on a small allow-list — 22/80/443/445/8080), vendor lookup expansion, IP-history per MAC.
2. **mDNS / Bonjour fingerprinting**: identify HomePods (`_airplay._tcp`, `_raop._tcp`, `_hap._tcp` for HomeKit), eero devices, Apple TVs, Chromecasts, network printers. Surface in the devices table as a "Discovered as" column.
3. **`new_device` alert → desktop notification**: Notifications API + user permission prompt in CPH Settings. Sound when severity ≥ warn.

**Effort**: A1 = 45 min, A2 = 45 min, A3 = 30 min. Can be shipped independently.

### B — Tailscale / mesh VPN in the sinsera-* images
**Status**: discussed, not started.

- Each `install-template.sh` gains a Tailscale install step + `tailscale up --auth-key=$TS_AUTH_KEY`
- Auth key per-image: operator drops `/boot/ark-tailscale-auth.key` before flashing
- Hub: SSH Runner accepts `*.ts.net` hostnames same as `*.local`
- New CPH tab "VPN" — shows which Pis are on the Tailnet, peers, last-seen status, read via `tailscale status --json` over SSH

**Effort**: ~1 hr end-to-end including a re-bake of all 5 image profiles.

### C — Cross-app "Send file to Pi" surface
**Status**: backend exists (`runner.pushFile()` in `hub/src/runner.mjs`), UI missing.

- New surface — most natural fit is inside SSH Runner page
- File picker → host picker → remote path → progress
- Wraps the existing `pushFile`; no Hub changes needed beyond a new POST endpoint that accepts multipart upload + forwards to `pushFile`

**Effort**: ~25 min. Currently the only way to push a non-build file is `scp` from terminal.

### D — Hardening baseline establishment
**Status**: 8 checks defined, 0 findings recorded — the weekly pulse can't be meaningful yet.

- Needs at least one SSH Runner host registered
- One-time: `POST /api/cph/hardening/run` for each of the 8 checks against that host
- Findings get stored; weekly CPH pulse compares against history going forward
- Operator job (or `/loop` automation): run weekly across all registered hosts

**Effort**: 5 min once a Pi is registered. Gated on the Pi-flash unblock above.

### E — Fleet hardware columns + "current image" tracking
**Status**: discussed, deferred.

- Agent on Pi reports flashed-image sha256 + HATs detected (i2c probe) + boot-disk type (SD vs NVMe vs USB) on heartbeat
- Fleet roster gains columns: Hardware HATs · Boot from · Image SHA · Operator notes (editable)
- Lets you actually answer "which Pi has which image" without SSH-ing in

**Effort**: ~45 min, BUT touches the Agent which means every Pi needs to update. Worth a dedicated session after Pi 1 is live.

### F — "My Pis" inventory page (Devices + Manifests merge)
**Status**: discussed, deferred.

- Phase-2 nav consolidation: merge the current "Device editor" (LAYERS form) + "Manifests" (list) into one page with list-on-the-left, editor-on-the-right
- Same data, less context-switching, mirrors how every modern app does it
- Optionally bring Fleet into the same surface (manifest = spec, Fleet entry = physical Pi running that spec)

**Effort**: ~1.5 hr; substantial UI work. Lower priority than A or D.

---

## 🩹 Known UX rough edges (small, fix-when-noticed)

| Item | Severity | Notes |
|---|---|---|
| **Disabled flash button has no explanation** | annoying | Currently shows gray "flash →" with `cursor: not-allowed`. Should explain why (no flash node) + link to Nodes setup guide. ~10 min. |
| **Bundled-image registry doesn't auto-register installer** | minor | The new `sinsera-installer.img.xz` needs a Hub restart to appear in Flash Nodes → Images. ~5 min — add to the seed-on-startup scan. |
| **`/api/images` vs `/api/flash/images` confusion** | medium | The top-nav "Images" page reads `/api/images` (filesystem) while Flash Nodes → Images reads `/api/flash/images` (registered). Same concept, two endpoints. Either merge or rename the top-nav. |
| **TypeScript / type safety on the manifest model** | nice-to-have | `manifest.js` is plain JS. Mistakes there (wrong shape, missing field) bite at chroot-time. Could port to `.ts` like Habitat. ~30 min. |

---

## 🧪 Tests we don't have yet

- **Smoke build**: a CI job that runs the 5 image builds end-to-end weekly. Catches regressions like the Wall-Hunter / install.plan.sh-overwrite class of bugs before they hit you mid-session.
- **Hub integration test**: spin up the Hub, register a mock agent via the public API, run one flash-job dry-run, assert the job logs are sensible.
- **Flash-to-nvme dry-run flag**: `flash-to-nvme --dry-run` that prints the plan without `dd`-ing. Useful for first-time users.

---

## 📦 Currently in the world

For context, what's already live:

- **Live UI at https://sinsera.co/ark/** — 13-item sidebar grouped into Discover / Imaging / Operate / Ops
- **5 pre-built images** registered in the Hub: vanilla, kiosk, claude-cli-pi, raspyjack, flipper
- **1 installer image** that bundles all 5 — boot from SD, run `flash-to-nvme`, walk away
- **Can't Phish Here** with 7 sub-tabs (RaspyJack + Flipper companion tabs both ship)
- **Hash-routing deeplinks** — `sinsera.co/ark/#security/raspyjack` opens straight to that tab
- **Ghost-manifest fix** shipped this session — deleting now sticks across refresh

---

## 🧭 Suggested order

If you want one path forward without thinking about it:

1. **Flash a Pi from `sinsera-installer`** (20 min, manual). This single act unblocks Phase 4.2 + 5.3 + 6.2 + 7.3 + makes the hardening baseline meaningful.
2. **A1 (more device columns) + A3 (browser notifications)** — biggest visible win without new hardware. ~75 min.
3. **C (Send file UI)** — quick polish, common-need surface. ~25 min.
4. **B (Tailscale baking)** — once you've flashed once, you'll want every future flash to auto-join the mesh. ~1 hr; requires a re-bake.
5. **D (hardening baseline)** — easy on a registered host. 5 min.
6. **E (Fleet hardware columns)** — wait until you have 2+ Pis online. ~45 min.
7. **F (Devices+Manifests merge)** — last; touches more of the UI. ~1.5 hr.

Or just say "what's next" and I'll pick.
