# TheHauntedBrocoli

Unified launcher app for the Pi 5 kiosk.

Runs on the Pi as a tiny Node HTTP server on `:8080`. Chromium kiosk
points at `http://localhost:8080`. Tile clicks open the underlying apps
(Claude in ttyd, Ark, Ragnar, RaspyJack/Flipper via Ark, Jailbreak,
Payroll, Tor exit test).

## Dev loop

```sh
# locally on Mac (preview)
cd apps/thehauntedbrocoli
node server.mjs              # http://localhost:8080
# edit public/index.html, refresh browser

# deploy to Pi 5 (rsync + restart systemd)
bash deploy.sh
```

`deploy.sh` is idempotent — rsyncs only changed files, restarts the
systemd unit, prints health.

## Layout

```
apps/thehauntedbrocoli/
├── server.mjs                       # Node http server (zero deps)
├── package.json
├── public/
│   └── index.html                   # launcher SPA (single file)
├── thehauntedbrocoli-app.service    # systemd unit (installs to Pi)
├── deploy.sh                        # rsync + restart
└── README.md
```

## Pi-side install

Image bake (in `builds/thehauntedbrocoli/install.sh`) handles first-run
provisioning: clone the app to `/opt/brocoli-app`, install
`thehauntedbrocoli-app.service`, point Chromium kiosk at
`http://localhost:8080`. After that, iterate with `deploy.sh` — no
re-flash needed.

## Adding a tile

Edit the `TILES` array in `public/index.html`. Each tile is:

```js
{ title: 'Name', badge: 'short tag', desc: 'one-line', href: 'http://...', colour: '#hex' }
```

Set `disabled: true` for placeholders.
