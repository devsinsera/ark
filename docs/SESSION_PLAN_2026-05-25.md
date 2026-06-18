# Ark + Sinsera session plan — 2026-05-25

Working snapshot of what shipped this session, what's running now, and what's queued. Update or delete when the work in flight lands.

## ✅ Shipped this session (live on sinsera.co/ark/)

| # | Feature | Commit |
|---|---|---|
| 1 | **Nav consolidation** — 13 sidebar items grouped into 4 sections (Discover / Imaging / Operate / Ops). Ark "Vault" renamed to **Secrets** to free the Vault name for Sinsera Core's media module. "Devices" → "Device editor" for clarity vs the Manifests list. | `f53b0cb` |
| 2 | **Hash-based deeplinks** — URL hash drives both top-nav + sub-views. `sinsera.co/ark/#security/raspyjack` opens Can't Phish Here directly on the RaspyJack tab. Browser back/forward + manual hash edits both work. | `e12f17f` |
| 3 | **Manifest description field** — `identity.description` textarea in Device editor. Propagates to Builds list cards. Old builds without a description show a friendly hint. | `3d84879` |
| 4 | **Delete-build button** — DELETE `/api/builds/<name>` endpoint + Trash2 button on every BuildCard. Path validation refuses traversal. | `3d84879` |
| 5 | **RaspyJack tab streaming** — NDJSON line-by-line stream from `/api/runner/hosts/<id>/exec/stream`. Stdout/stderr append live; Cancel button mid-flight. Last-20-runs sidebar fed by `/api/runner/log?reason=raspyjack`. | `ebd5d23` |
| 6 | **Flipper tab + image profile** — 8th view in CPH. Five READ-ONLY commands (device info / power / BLE scan / sub-GHz listen / NFC detect). Pi-side bridge script at `/opt/flipper/flipper-bridge.py` with hard allow-list. Image built locally; sha256 `04079d8c…`. | `c3be07c` |
| 7 | **Parts list with checkboxes** — RaspyJack + Flipper tabs both have a collapsible parts BOM. Each row has a localStorage-backed "got it" checkbox; header shows `N / total got`. | `c3be07c` |
| 8 | **Brutalist typography pass** in Sinsera Core — wordmark + h1/h2 use Cellotype (replaced Cormorant Garamond + Wall Hunter attempt). Stamp utility uses letter-spaced Outfit. All deployed to sinsera.co. | (Sinsera Core repo) |

## 🟡 Built but not pushed / not auto-registered

- **Flipper `.img.xz`** lives at `builds/sinsera-flipper/out/ark-built.img.xz` locally only. `.gitignore` excludes `builds/*/out/`. Will appear in the Hub's Flash Nodes → Images table on next Hub restart.
- **Hub restart needed** to pick up: the new DELETE-build endpoint, the manifest_summary.description field, and the new Flipper image in the flash registry.

```bash
# Restart the Hub
kill $(pgrep -f "hub/src/index.mjs")
cd ~/Dev-Sinsera/Ark && node hub/src/index.mjs
```

## 📦 Pre-built images (all DietPi RPi5 ARMv8 Trixie)

| Image | Size (.img.xz) | Hub ID | What it does |
|---|---|---|---|
| sinsera-vanilla | 192 MB | `img_zhaevtjwm3iq6b` | Plain DietPi + your SSH key + AU locale + hostname `SinseraCore`. WiFi placeholder. Boots to normal console login. |
| sinsera-kiosk | 192 MB | `img_oi138k54j1okux` | Auto-launches Chromium full-screen on `https://sinsera.co/` |
| claude-cli-pi | 192 MB | `img_4ynpgyhks5d6cd` | Headless Pi with Node 20 + claude-code CLI pre-installed |
| sinsera-raspyjack | 250 MB | `img_po7smw9ka5tfjt` | RaspyJack defensive recon (bundles `~/Downloads/Jack/` tarball, excludes wifi/credentials/Responder/DNSSpoof trees) |
| sinsera-flipper | 202 MB | (registers on next Hub restart) | Flipper Zero companion. Pi+Flipper over USB; READ-ONLY bridge for the CPH Flipper tab |

## 🟡 In flight

- **Habitat (Apple Home / HomeKit) app** — scheduled to start at **09:00 AM today**. Job ID `32d58a62`, session-only — DON'T close Claude before 9:00 or it'll be lost. The cron prompt has the full spec. When it fires, the build will confirm scope (standalone Next.js app at `/Users/petastockdale/Dev-Sinsera/Habitat/`, mirroring the Payroll pattern) before scaffolding.

## ⏳ Queued — will tackle after Habitat or when redirected

### A. More info on LAN devices + new-device alerts
The Hub already persists `devices` rows on first sight. Three pieces:
1. Add columns to Network Landscape → Devices table (OS fingerprint, open ports, vendor lookup, IP history, last-stable-seen)
2. Hook a "new MAC seen" alert into CPH alerts feed (~25 min — smallest piece)
3. Browser Notifications API for system-level pop-ups when an alert lands (~20 min)

### B. mDNS / Bonjour discovery
Identify Apple HomePods (`_airplay._tcp` / `_raop._tcp`), eero devices, the Flipper companion, etc. Hub gains a `mdnsScan()` function alongside the ARP sweep. Surfaces fingerprinted hits in the Network Landscape Devices table.

### C. Tailscale baked into the sinsera-* images
- Each `install-template.sh` gains a Tailscale install step + `tailscale up --auth-key=$TS_AUTH_KEY` block.
- Auth key per-image: operator drops `/boot/ark-tailscale-auth.key` before flashing.
- Ark Hub: SSH Runner accepts `*.ts.net` hostnames same as `*.local`.
- New CPH "VPN" tab — shows which Pis are on the Tailnet, their peers, last-seen status.
- ~1 hr work end-to-end.

## 🧹 Deferred maintenance (no rush)

- **Phase-2 nav consolidation**: actually merge Devices+Manifests pages, Network+Fleet pages, dedup Images vs Flash Nodes → Images. The current pass only grouped them visually.
- **Fleet hardware columns**: agent reports flashed-image sha256 + HATs detected on heartbeat → Fleet roster displays them. (Needs an agent release.)
- **Vault Phase 2 (Sinsera Core)**: role-based sharing, vault_collection_shares table, cross-module FKs (productions.vault_collection_id, performers.vault_collection_id, contracts.vault_asset_id).
- **The 5 "likely-stub" Sinsera Core pages** flagged earlier: `/production`, `/distribution`, `/casting`, `/studio`, `/compliance` — confirm what's real vs placeholder, decide consolidation strategy.

## ❓ Open questions

- After Habitat kicks off — do you want me to wait at 09:00 to confirm scope, or shall I just scaffold the `~/Dev-Sinsera/Habitat/` Next.js app and confirm via the running output?
- Do you actually own a Flipper Zero? (Asked earlier; you implied yes by saying "I have one of these" — but worth confirming before the next session uses the Flipper tab against real hardware.)
