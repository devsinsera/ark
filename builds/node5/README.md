# Node 5 — GR86 in-car Pi (Ark build recipe)

A **Pi 5 (2GB), HEADLESS** in-car hub for the GR86. No HDMI/X/chromium/display
stack — you view the dashboard via a URL on the iPad/phone (over the Pi's own AP
or the cloud HUD). Node 5 logs OBD and ties the car into the Sinsera fleet.

This is the **bake-ready recipe**; the actual bake needs Docker up (or run it on
Node 3). The Pi hasn't arrived, so it's **unverified on hardware** — expect on-Pi
tuning (USB-dongle drivers, which radio hosts the AP, OBDLink BLE pairing).

## What's baked

| Area | What | Where |
|------|------|-------|
| OBD logger | `garage-pi-bridge` (venv) → `garage-obd-bridge.service` (Restart=always) | `/opt/garage-pi-bridge` |
| Radios | onboard WiFi + **TP-Link AX1300 USB** (2 WiFi); onboard BT + **Ugreen BT 6.0 USB** (2 BT). Ugreen BT → OBDLink MX+. Firmware pkgs + rfkill-unblock service | `node5-wifi-unblock.service` |
| AP | `Sinsera-GR86` (WPA2, `method=shared` 192.168.42.1/24) — iPad connects **direct**, HUD works offline | `ap-sinsera-gr86.nmconnection` |
| Uplink | NetworkManager autoconnect priority **home(100) > iPhone-hotspot(50) > car(20)** | `uplink-*.nmconnection` |
| Local HUD | `gr86-hud.service` on **:8080** — redirects to `sinsera.co/garage/<car>/obd?hud=1` when online, placeholder page offline | `/opt/gr86-hud` |
| Fleet | `node-status-reporter` + `node-command-runner` → shows as **node5** on the Nodes page; reboot/poweroff from Kiosks | `/opt/sinsera-node` |
| Store-and-forward | `gr86-store-forward.timer` (5 min) rsyncs `/var/lib/garage-obd/buffer` → `peta@192.168.4.182:/opt/garage-obd/node5` **when Node 3 is reachable (home)**. Copy-only + idempotent (Node-4 archive pattern) | `/opt/gr86/store-forward.sh` |
| Run mode | `gr86-idle-shutdown.timer` **STUB** — on with ignition, ~15–30 min parked window, then clean poweroff (needs supercap/UPS-hat wiring) | `/opt/gr86/idle-shutdown.sh` |
| Tailscale | installed on **first boot** (network up); **no authkey baked** | `gr86-tailscale-install.service` |
| SD guard | clean-shutdown-on-power-loss stub + documented overlayfs read-only-root toggle (**left OFF**) | `/opt/gr86/enable-overlayfs.sh` |
| SSH | `peta` user, **key-only**, NOPASSWD sudo, fleet key baked; `gpu_mem=16` (headless) | — |

## Placeholders YOU must fill (nothing real is baked)

1. **OBD** — over SSH, edit `/opt/garage-pi-bridge/.env`:
   - `OBDLINK_MAC=` — pair once (`sudo bluetoothctl`) then paste the MX+ MAC
   - `CAR_ID=` — the GR86's UUID from `garage_cars`
   - `SUPABASE_PASSWORD=` — owner password (blank by default → cloud push off, like Vigil)
   then `sudo systemctl restart garage-obd-bridge`
2. **WiFi** — edit `/etc/NetworkManager/system-connections/*.nmconnection`:
   - `ap-sinsera-gr86` → real **AP passphrase** (`psk=`)
   - `uplink-home-wifi`, `uplink-iphone-hotspot`, `uplink-car-wifi` → real **SSIDs + psks**
   (or supply them at bake time via `~/.ark/node5.conf` — see the bake script header)
3. **Tailscale** — post-boot: `sudo tailscale up --ssh --hostname node5`
4. **Store-and-forward key** — the bake generates `/home/peta/.ssh/id_ed25519`
   (`node5-store-forward`); add its `.pub` to **Node 3's** `peta` authorized_keys, and
   ensure `/opt/garage-obd/node5` exists on Node 3 (`chown peta:peta`).

## How to bake

Base image: `Os/raspios_lite_arm64_latest.img.xz` (Pi 5 Bookworm, headless).

```bash
# with Docker up (needs the ark-builder:0.1 image), or run it on Node 3:
bash builder/lib/node5-bake.sh
# output → Dev-Sinsera/Builds/node5.img   (flash to the Pi's SD/USB SSD)
```

Optional bake-time creds (else placeholders remain): `~/.ssh/sinsera_fleet.pub`
(fleet key), `Sinsera Core/.env.production` (anon key), `~/.ark/vigil.env` (camera
account for the fleet reporters), `~/.ark/node5.conf` (AP/uplink/OBD values).

## Known gaps (need the physical Pi + iteration)

- **Real gauge HUD** — the HUD server is a stub that proxies the cloud dashboard /
  shows a placeholder. The real gauges come from the Garage kiosk editor's output;
  bundle them into `/opt/gr86-hud/static` and feed live OBD values locally.
- **Store-and-forward buffer** — plumbing is wired (dir + timer + rsync + home
  guard), but `bridge.py` doesn't yet also append JSONL to the buffer; it needs a
  small local-log extension. Cloud push (online) already works via the bridge.
- **Idle-shutdown** — stub only; wire the supercap/UPS-HAT "power good" GPIO so it
  cleanly powers down ~15–30 min after ignition off (protects the 12V battery + SD).
- **USB-dongle drivers** — firmware pkgs are installed best-effort; verify the
  TP-Link AX1300 (mt76/rtl88xx-class) and Ugreen BT 6.0 come up, and pin the AP to
  the dongle's interface so onboard stays free for uplink.
- **Phase 2** (not in this bake): USB SSD for camera/local buffer, interior USB
  webcam + wifi dashcam pull, LiveKit camera publish, 4G dongle + SIM for
  remote-while-away.
