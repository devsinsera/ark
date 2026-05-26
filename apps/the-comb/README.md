# The Comb

Unified launcher app for **The Hive** (Pi 5).

Runs on the Pi as a tiny Node HTTP server on `:8080`. Chromium kiosk
points at `https://sinsera.co/the-comb/` (publicly hosted) which loads
the exact same `public/index.html` you edit here. Tile clicks open
the underlying apps: Claude (ttyd pop-out), Ark, Ragnar, RaspyJack,
Flipper, Jailbreak, Payroll, Tor exit test.

## Dev loop

```sh
# locally on Mac (preview)
cd apps/the-comb
node server.mjs                # http://localhost:8080
# edit public/index.html, refresh browser

# deploy to The Hive (rsync + restart systemd)
bash deploy.sh

# publish to sinsera.co/the-comb/ (HostGator)
bash deploy-public.sh
```

`deploy.sh` rsyncs to `brocoli@thehive.local:/opt/the-comb`.
`deploy-public.sh` lftp-mirrors `public/` to `ftp.sinsera.co:/the-comb/`.

## Layout

```
apps/the-comb/
├── server.mjs              # Node http server (zero deps)
├── package.json
├── public/
│   └── index.html          # launcher SPA (single file)
├── the-comb.service        # systemd unit (installs to /etc/systemd/system on Pi)
├── deploy.sh               # rsync to The Hive
├── deploy-public.sh        # lftp to sinsera.co
├── apps/                   # per-tile project folders (Payroll has real code)
└── README.md
```

## Pi-side install (fresh flash)

`builds/the-hive/install.sh` is the phase-2 installer fired by the
image bake. It:
- apt-installs Node + X + Chromium + ttyd + Tor + dkms toolchain
- pins kernel to 6.12, DKMS-builds the AC600 driver
- enables `the-comb.service` + `ttyd-claude.service` + `ark-kiosk.service`
- auto-mounts the STICK USB at `/mnt/stick` via fstab

After the first boot, iterate via `bash deploy.sh` — no re-flash.

## Adding a tile

Edit the `TILES` array in `public/index.html`. Each tile:

```js
{ title: 'Name', badge: 'short tag', desc: 'one-line', href: 'http://...', colour: '#hex' }
```

Set `disabled: true` for placeholders. Set `popup: true` (plus optional
`width`/`height`) for app-mode pop-out windows instead of new tabs.
