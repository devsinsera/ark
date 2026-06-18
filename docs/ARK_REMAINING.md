# Ark — remaining work

Snapshot as of 2026-05-25 10:30 AEST. Read top-to-bottom; the order is
my honest recommendation for what to do next. Update or delete entries
as they ship.

---

## ✅ Shipped this session (live + committed)

| # | What | Commit |
|---|---|---|
| 1 | Manifest ghost-resurrection fix (`ark.manifests.seeded.v1` flag) | `1d20523` |
| 2 | `sinsera-installer` image profile + build pipeline + image (1.2 GB xz) | `1ff48dd` |
| 3 | `docs/SESSION_PLAN_2026-05-25.md` + `docs/ARK_REMAINING.md` | `e42bcd5` / `3de2e75` |
| 4 | Auto-scan `builds/*/out/` for new images; `GET /api/builds/<name>/download`; ↓ download button on BuildCard; auto-rescan on Images tab mount | `611f739` |
| 5 | WiFi creds bake-in via `~/.ark/wifi.env` + `builder/lib/bake-creds.sh`; installer rebuilt with `Obi-Lan Kenobi` baked in (sha `a2b4f8c718c0…`) | `fce18df` |

---

## 🟡 HALF-DONE — pick up here in the next session

### Local "Flash SD from Ark" (UI side missing)

Hub side is **already wired and tested**:

| Endpoint | What it does | Status |
|---|---|---|
| `GET /api/local/disks` | Returns external Mac disks via `diskutil list -plist` | ✅ live |
| `POST /api/local/flash` | Runs `xz -dc <image> \| dd of=/dev/rdiskN` via `osascript with administrator privileges` (single Mac auth prompt). Validates target is in the external-disks list, refuses anything matching `/dev/disk0` (boot disk), uses `rdiskN` for speed | ✅ live |

The endpoints aren't committed yet — they're in `hub/src/index.mjs` locally but the file hasn't been `git add`'d. **First thing the next session should do**: `cd ~/Dev-Sinsera/Ark && git add hub/src/index.mjs && git commit + push`.

**UI side — not started.** What's needed:

1. New button on each row in **Flash Nodes → Images** table: `↗ Flash to Mac SD` (and probably also on the `Builds` cards)
2. Click → modal opens. Modal needs:
   - `GET /api/local/disks` on open → renders a list of external Mac disks (size, name, device path)
   - "Insert an SD card and click refresh" empty state when zero disks
   - User picks one disk
   - Big destructive-action warning: `ALL DATA ON /dev/diskN ("<name>") WILL BE DESTROYED`
   - "Type the disk name to confirm" input (matches `diskN`)
   - Flash button → calls `POST /api/local/flash` with `{image_id, target:'/dev/diskN'}`
   - Loading spinner with "macOS will prompt for your password. Flashing takes ~3-5 min — do not unplug."
   - On success: green checkmark + "Done. Eject the SD safely and insert it into your Pi."
   - On error: red text with the stderr from the endpoint

**Estimated effort**: 30-45 min. The Hub side is the hard part and it's done.

### Sinsera-installer ALSO needs the auto-install Flash Node Agent

So the workflow becomes truly zero-touch (no SSH, even ignoring the SD-from-Ark UI above):

1. Flash SD with sinsera-installer (via Ark UI → SD button OR via Pi Imager)
2. Insert SD, power on
3. Pi joins WiFi (already baked in ✓)
4. Pi auto-installs Flash Node Agent on first boot (← **not done yet**)
5. Pi registers itself with the Hub (Hub needs to be reachable at the Pi's network — see "Hub bind" below)
6. Pi appears in Ark → Flash Nodes → Nodes tab
7. Operator opens Ark → picks an image → picks the attached NVMe → click Flash
8. Hub dispatches flash job to the Pi via HTTP
9. Pi runs flash, reports back complete
10. Operator power-cycles the Pi (or sends `poweroff` via Ark)

**What's needed**:
- Modify `builds/sinsera-installer/install-template.sh` to auto-install the flash agent in the first-boot script (run `bash /opt/ark-extras/agent/install-flash-agent.sh` if present, with `HUB_URL` baked in)
- Bake the Hub URL into the install plan: take `lanIpHint()` from the Hub at build time (or the user's choice) and pass into the template as `__HUB_URL_PLACEHOLDER__`. Update `bake-creds.sh` to substitute it.
- Make the Hub bind to `0.0.0.0` (currently `127.0.0.1` only — Pi can't reach it). Set `ARK_HUB_BIND_HOST=0.0.0.0` before starting the Hub. **Note this exposes the Hub to your LAN — fine for a home LAN but think about it.**

**Estimated effort**: 30 min.

---

## 🚦 Hardware-gated phases (the four 🟡 from ARCHITECTURE.md)

All unblocked by flashing the first Pi. The workflow is now ~4 manual steps:

1. Hard-refresh sinsera.co/ark/, go to Imaging → Builds, click `↓ download` on `sinsera-installer`
2. Open Raspberry Pi Imager, write the downloaded .img.xz to an SD card (**don't** open the OS Customisation dialog — image has everything baked in already)
3. Insert SD into Pi 5, power on, wait ~60 s
4. SSH in: `ssh root@SinseraInstaller.local`, run `sudo flash-to-nvme`, pick `sinsera-vanilla` (or whatever), pick the NVMe, confirm, walk away ~3 min, `sudo poweroff`, pull SD, power on

| 🟡 Marker | Unblocks once… |
|---|---|
| **Phase 4.2** Agent on Pi | A Pi running the Ark agent heartbeats `/api/devices/heartbeat` |
| **Phase 5.3** OTA self-update | Same Pi successfully pulls `/api/agent/download` and replaces itself |
| **Phase 6.2** Flash Node Agent | A Pi running `agent/install-flash-agent.sh` registers as a Flash Node |
| **Phase 7.3** Passive monitor | Pi-side `journalctl` tail reports defensive observations |

---

## 🟡 Open features (named, not yet built)

### A — LAN device intelligence
3 pieces:
1. More columns in Network → Devices (OS fingerprint, open ports, vendor lookup, IP history per MAC) — ~45 min
2. mDNS / Bonjour fingerprinting — identify HomePods, eero devices, the Flipper companion, Apple TVs, printers — ~45 min
3. Browser notifications when new_device alerts fire — Notifications API + permission prompt — ~30 min

### B — Tailscale baked into images
Each Pi auto-joins your Tailnet. ~1 hr.

### C — Send-file-to-Pi UI surface
Backend already has `runner.pushFile()`. UI surface missing — most natural fit inside SSH Runner page. ~25 min.

### D — Hardening baseline
Run 8 checks once against a registered host. ~5 min on a registered Pi.

### E — Fleet hardware columns
Agent reports flashed-image sha + HATs detected + boot-disk-type on heartbeat. ~45 min, touches Agent code.

### F — Devices+Manifests merge
Phase-2 nav consolidation. ~1.5 hr.

---

## 🩹 Known UX rough edges

| Item | Severity | Notes |
|---|---|---|
| Disabled "flash →" button has no explanation when nodes.length === 0 | annoying | Should explain why + link to Nodes setup |
| `/api/images` vs `/api/flash/images` confusion | medium | Same concept, two endpoints |
| TypeScript on manifest model | nice-to-have | `manifest.js` is plain JS |

---

## 📦 Local state worth knowing for the next session

**Built images on disk** (gitignored — `builds/*/out/`):

| Build | Size (.img.xz) | sha256 (first 12) |
|---|---|---|
| sinsera-vanilla | 192 MB | (check via `/api/flash/images`) |
| sinsera-kiosk | 192 MB | `c007f8f99668` |
| claude-cli-pi | 192 MB | `435597ce…` |
| sinsera-raspyjack | 256 MB | `b5f21d18…` |
| sinsera-flipper | 208 MB | `04079d8c…` |
| **sinsera-installer** (latest, WiFi baked) | **1.2 GB** | **`a2b4f8c718c0…`** |

**Hub state**:
- Running locally at `http://localhost:7400` (PID changes; check via `pgrep -lf hub/src/index.mjs`)
- Currently binding to 127.0.0.1 only — needs `ARK_HUB_BIND_HOST=0.0.0.0` to be reachable from Pis
- Auto-rescans `builds/*/out/` on startup (logs `[hub] flash image scan: …`)
- Approved hosts: 35 (24 added via this session's weekly CPH pulse)
- Open alerts: 27 warn / 3 info, 10 of them are the "real MAC, no OUI match" unknowns Cluster 3 still needs the operator's eye

**Files in `~/.ark/`**:
- `wifi.env` — `Obi-Lan Kenobi` + password (mode 600, owner-only)
- `ark-hub.db` — Hub SQLite store
- `vault.master.key` — vault encryption key
- `flash-images/` — content-addressable .img stash

---

## 🧭 Suggested order for the next session

1. **First minute**: `git status` in `~/Dev-Sinsera/Ark` — the new `/api/local/disks` + `/api/local/flash` endpoints in `hub/src/index.mjs` are uncommitted. Commit + push them so the work survives a clean clone.
2. **First 30 min**: Build the UI for "Flash SD from Mac" (modal triggered from Images table). Hub side is done — just wire the React.
3. **Next 30 min**: Auto-install Flash Node Agent in the installer image + bake Hub URL. Rebuild installer.
4. **Then**: Flash a real Pi end-to-end. That single act unblocks the 4 🟡 phases above.

Or say "what's next" and I'll pick.
