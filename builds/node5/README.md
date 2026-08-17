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
| Radios | onboard WiFi (`wlan0`, uplink) + **BrosTrend AX900 / MT7921AU USB** (`wlan1`, AP); onboard BT + **Ugreen BT 6.0 USB** (`hci1` → OBDLink MX+). `mt7921u` is in-kernel — no driver install | `node5-wifi-unblock.service` |
| AP | `Undercover Surveillance Van 5` (WPA2, `method=shared` 192.168.42.1/24) — iPad connects **direct**, HUD works offline | `ap-sinsera-gr86.nmconnection` |
| Uplink | NetworkManager autoconnect priority **home(100) > iPhone-hotspot(50) > car(20)** | `uplink-*.nmconnection` |
| Local HUD | `gr86-hud.service` on **:8080** — redirects to `sinsera.co/garage/<car>/obd?hud=1` when online, placeholder page offline | `/opt/gr86-hud` |
| Drone relay | **mediamtx v1.20.0** (`mediamtx.service`) — DJI Fly RTMP in, **WebRTC/HLS out for the iPad**; also pulls the Thinkware as a `dashcam` path. In-car field media server. `rtmp://192.168.42.1:1935/drone` → `http://192.168.42.1:8889/drone` | `/opt/mediamtx` |
| Fleet | `node-status-reporter` + `node-command-runner` → shows as **node5** on the Nodes page; reboot/poweroff from Kiosks | `/opt/sinsera-node` |
| Store-and-forward | `gr86-store-forward.timer` (5 min) rsyncs `/var/lib/garage-obd/buffer` → `peta@<Node 1/Core>:/opt/garage-obd/node5` **when Core is reachable (home)**. Tries `.5.54` → `.5.61` → `sinsera-core.local`. Copy-only + idempotent (Node-4 archive pattern) | `/opt/gr86/store-forward.sh` |
| Run mode | `gr86-idle-shutdown.timer` **STUB** — on with ignition, ~15–30 min parked window, then clean poweroff (needs supercap/UPS-hat wiring) | `/opt/gr86/idle-shutdown.sh` |
| Tailscale | installed on **first boot** (network up); **no authkey baked** | `gr86-tailscale-install.service` |
| SD guard | clean-shutdown-on-power-loss stub + documented overlayfs read-only-root toggle (**left OFF**) | `/opt/gr86/enable-overlayfs.sh` |
| SSH | `peta`, **key-only** (`~/.ssh/sinsera_fleet`, fp `SHA256:vosk+ukg…`), NOPASSWD sudo; `gpu_mem=16` | `ssh node5` |

## Networks — who joins what

Node 5 has **two WiFi radios**, and that is the whole design constraint:

| Radio | Role | Detail |
|-------|------|--------|
| BrosTrend AX900 (MT7921AU) USB | **hosts the AP** | `Undercover Surveillance Van 5` · WPA2 · `192.168.42.1/24` · `method=shared` (NATs clients out through the uplink) |
| onboard | **uplink** | autoconnect priority: `Obi-Lan Kenobi` (100) > iPhone hotspot (50) > car WiFi (20) |

So: **iPad, RC2 and the dashcam all join Node 5's AP.** Node 5 itself joins the
iPhone hotspot (or home WiFi) for internet, and shares it with everything on the AP.

⚠ **Only two radios, three networks wanted.** Both are committed (one hosts the
AP, one uplinks), so there is no radio free to go and join a dashcam's own AP.

**Thinkware U1000 — parked, needs a 3rd radio.** It hosts its own `Thinkware_…`
AP, talks to the proprietary DASH CAM LINK app, and has no documented RTSP or
station mode (default WiFi password `123456789`, though BT-equipped units
authenticate over Bluetooth instead). So it cannot come to Node 5, and Node 5
has no spare radio to go to it. **The fix is a second USB WiFi dongle** dedicated
to joining the dashcam's AP — then set `DASHCAM_RTSP` and the mediamtx path
lights up. Before buying: confirm the stream actually opens in VLC
(`rtsp://<dashcam-ip>:554/`) while joined to its AP. If VLC can't play it, no
dongle will help — there'd be no stream to pull.

## Every URL

There are **two phases**, because the car AP only exists once a working USB WiFi
dongle is fitted (the Pi's single onboard radio is taken by the uplink).

### Phase 1 — no AP yet: on the home network (works today)

Use the **mDNS name, not the IP** — `node5`'s home address is a DHCP lease
(`ipv4.method: auto`) and will move. `node5.local` follows it. Verified working.

| What | URL |
|------|-----|
| Drone in (DJI Fly → RTMP) | `rtmp://node5.local:1935/drone` |
| Drone on the iPad (WebRTC) | `http://node5.local:8889/drone` |
| Drone on the iPad (HLS) | `http://node5.local:8888/drone/index.m3u8` |
| OBD HUD | `http://node5.local:8080` |
| Relay health | `http://node5.local:9997/v3/paths/list` |
| SSH | `ssh node5-home` |

Everything must be on `Obi-Lan Kenobi`. Away from home this phase does nothing —
that is exactly what the dongle fixes.

### Phase 2 — with the AP dongle: ONE URL, anywhere

The AP is **Node 5's own network** — it travels with the car and does not depend on
your location, an uplink, or the internet. So once the dongle is fitted this is the
single RTMP URL to put in DJI Fly and never change:

```
rtmp://192.168.42.1:1935/drone
```

The RC2 just always joins `Undercover Surveillance Van 5`. Home, driveway, paddock —
same SSID, same URL, no internet required.

| What | URL |
|------|-----|
| **Drone in** (DJI Fly → Transmission → Live Streaming → RTMP) | `rtmp://192.168.42.1:1935/drone` |
| **Drone on the iPad** (WebRTC, ~1 s) | `http://192.168.42.1:8889/drone` |
| Drone on the iPad (HLS, ~2–4 s) | `http://192.168.42.1:8888/drone/index.m3u8` |
| **Dashcam** (once `DASHCAM_RTSP` is set) | `http://192.168.42.1:8889/dashcam` |
| **OBD HUD** | `http://192.168.42.1:8080` |
| Relay health (`ready:true` = stream live) | `http://192.168.42.1:9997/v3/paths/list` |
| SSH | `ssh node5` |

`192.168.42.1` is fixed (`method=shared`), so unlike phase 1 it never moves.

**Radios are PINNED so this stays true:** `ap-sinsera-gr86` → `wlan1` (USB dongle),
all three uplinks → `wlan0` (onboard). Without pinning, NetworkManager can swap which
radio hosts the AP between boots and the single-URL promise breaks. Applied to the
recipe and to the running node 2026-08-17.

The iPad **cannot play RTMP or RTSP** — WebRTC/HLS is what makes this work on iOS.
A `302` from the WebRTC URL is normal (mediamtx sets a cookie); Safari handles it.
HLS returns `404` until something is actually publishing — that is not a fault.

## Connecting, in order

**Prerequisite for steps 3–4:** a working USB WiFi dongle must be fitted, or there
is no AP. Verified 2026-08-17 that the `35bc:0108` "Realtek 802.11ax" adapter binds
**no driver** (`mt7921u` and `mt7925u` both fail `-22`) — it produces no interface at
all. Replace it with a MediaTek MT7921AU/MT7612U (e.g. BrosTrend AX900); the
`mt7921u`/`mt76x2u` modules already ship with Pi OS, so it should come up as `wlan1`
and NetworkManager hands it the AP profile automatically. Until then use the phase-1
URLs above.

1. **Power on** Node 5 (ignition). Give it ~40 s.
2. **iPhone**: Settings → Personal Hotspot → **on**. Node 5 joins it automatically
   (priority 50) and NATs the AP clients out through it.
3. **iPad**: WiFi → `Undercover Surveillance Van 5` → passphrase → open the URLs above.
4. **RC2**: Settings → WiFi → `Undercover Surveillance Van 5`, then
   DJI Fly → Transmission → **Live Streaming → RTMP** → `rtmp://192.168.42.1:1935/drone` → Start.
   *(RC2 Bluetooth (`QCOM-BTD`) cannot carry video — ~1–3 Mbps vs 2–4 Mbps needed,
   and DJI Fly only streams over IP. WiFi is the only path.)*
5. **Thinkware**: put it in WiFi **station mode** and join it to the AP. Find its IP
   (`ssh peta@192.168.42.1 'ip neigh'`), confirm the RTSP URL in VLC, then set
   `DASHCAM_RTSP` in `~/.ark/node5.conf` and re-bake — or add the path live:
   ```yaml
   # /opt/mediamtx/mediamtx.yml, BEFORE all_others:
     dashcam:
       source: rtsp://192.168.42.x:554/<path>
       sourceOnDemand: yes
   ```
   then `sudo systemctl restart mediamtx`.
6. **OBD**: pair the OBDLink MX+ once (`sudo bluetoothctl` → `scan on` → `pair <MAC>`),
   put the MAC in `/opt/garage-pi-bridge/.env`, `sudo systemctl restart garage-obd-bridge`.

## Dashcam → the Vigil camera wall

Two ways, depending on where you want it visible:

- **At home (simplest).** The eufy/RTSP bridge on **Node 3** feeds the wall. Add to
  `/opt/eufy/.env` on Node 3 and restart it:
  ```
  RTSP_CAM_GR86=Dashcam · GR86|rtsp://<node5-home-ip>:8554/dashcam|GR86
  ```
  This only works while the car is home and on `Obi-Lan Kenobi` — Node 5's home IP
  is DHCP, so give it a reservation on the eero or the URL rots.
- **Anywhere (needs work).** Run the `vigil_cam.py` frame-poster on Node 5 so it
  pushes JPEGs to Supabase over the hotspot, exactly like Node 4. **Not baked yet** —
  it needs the cloud password and a bandwidth cap so it doesn't eat mobile data.

## Archive → Node 1 (Core) when you get home

`gr86-store-forward.timer` (every 5 min) rsyncs `/var/lib/garage-obd/buffer` →
`peta@<Core>:/opt/garage-obd/node5`, copy-only and idempotent. It tries
`192.168.5.54`, then `192.168.5.61`, then `sinsera-core.local`, and is a silent
no-op when none answer (i.e. away from home). Core has ~1.7 TB free.

**One-time setup on Node 1 (Core):**
```bash
sudo mkdir -p /opt/garage-obd/node5 && sudo chown -R peta:peta /opt/garage-obd
# then add Node 5's pubkey (printed at the end of the bake) to Core's authorized_keys
```

## What's pre-filled vs what you must still supply

`~/.ark/node5.conf` (outside the repo, chmod 600) is read at bake time. **Already set:**
AP SSID + passphrase, home WiFi (`Obi-Lan Kenobi`, read from the existing fleet nodes),
iPhone hotspot passphrase.

**Still needed — the image bakes fine without them, these just stay inert:**

| Value | Where | Why it matters |
|-------|-------|----------------|
| `IPHONE_SSID` | `~/.ark/node5.conf` | ⚠ **VERIFY THIS.** It is the iPhone's *device* name (Settings → General → About → Name), exactly. Wrong = no uplink away from home, and it fails **silently** — Node 5 just never associates. |
| `DASHCAM_RTSP` | `~/.ark/node5.conf` | blank = no dashcam path in mediamtx (everything else still works) |
| `OBDLINK_MAC` | `/opt/garage-pi-bridge/.env` | pair once via `sudo bluetoothctl` |
| `CAR_ID` | `/opt/garage-pi-bridge/.env` | the GR86's UUID from `garage_cars` |
| `SUPABASE_PASSWORD` | `/opt/garage-pi-bridge/.env` | blank → local logging only, no cloud push (same default as Vigil) |
| Tailscale authkey | post-boot | `sudo tailscale up --ssh --hostname node5` |
| Store-forward key | Node 1 | bake prints `/home/peta/.ssh/id_ed25519.pub` — add it to **Core's** `peta` authorized_keys |

## How to bake

Base image: `Os/raspios_lite_arm64_latest.img.xz` (Pi 5 Bookworm, headless).

```bash
# with Docker up (needs the ark-builder:0.1 image), or run it on Node 3:
bash builder/lib/node5-bake.sh
# output → Dev-Sinsera/Builds/sinsera-node-5-pi5-2gb.img  (flash to the Pi's SD/USB SSD)
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
  BrosTrend AX900 comes up as `wlan1` (the `mt7921u` module is already installed and
  carries the matching device ID, so it should be plug-and-play). The AP is already
  pinned to `wlan1` and the uplinks to `wlan0`.
  **Do NOT use the `35bc:0108` "Realtek 802.11ax" dongle** — verified 2026-08-17 to
  bind no driver at all (`mt7921u`/`mt7925u` both probe-fail `-22`, firmware present,
  and it first enumerates as USB mass storage — the Windows driver-CD trick). It is
  almost certainly AIC8800-class: no mainline driver, and AP mode unlikely even with
  the out-of-tree one.
- **Dashcam on the wall away from home** — the mediamtx `dashcam` path makes it
  viewable on the iPad anywhere, but getting it onto the **Vigil wall** currently
  needs the car to be home (Node 3's RTSP bridge pulls it). A `vigil_cam.py`-style
  cloud frame-poster on Node 5 would fix that; not baked (needs the cloud password
  and a data cap).
- **Thinkware station mode is an assumption.** Model-dependent, and many Thinkware
  units only run their own AP with a proprietary app — no station mode, no RTSP.
  Confirm in VLC before relying on it; if it can't, the dashcam stays SD-card-only.
- **Phase 2** (not in this bake): USB SSD for camera/local buffer, interior USB
  webcam, LiveKit camera publish, 4G dongle + SIM for remote-while-away.
