# Ark Agent — on-device telemetry reporter

A small Python script that runs on every Ark-managed Pi, reports
health + identity to the Hub every 30s, and listens for inbound
commands.

Status: **Phase 4.2** — spec only. Not implemented yet.

---

## Why a separate agent

The Hub does **passive** discovery (arp-scan + mDNS). That tells you
"there's a Pi at 192.168.1.50". The Agent does **active** reporting
— uptime, CPU temp, kiosk service health, manifest ID. Without the
agent, the table can only show IP + MAC + "online", which is enough
for a network manager but not for fleet management.

Each Pi runs one agent. The agent is small: a single Python file,
~150 lines, deployed via the same `Automation_Custom_Script.sh`
mechanism Ark already uses.

---

## What it does

Once on first boot:
1. Read `/etc/ark/manifest.json` (written by `Automation_Custom_Script.sh`).
2. Read `/etc/ark/hub.url` (the Hub URL, configured at build time).
3. Read `/etc/ark/agent.token` (shared secret, configured at build time).

Then forever:
1. Every 30s, POST `/agent/report` to the Hub with current telemetry.
2. Advertise itself via mDNS as `_ark._tcp.local` on port 22 (SSH).
3. Run as a systemd service (`ark-agent.service`) with restart-on-failure.

---

## What it reports

```jsonc
{
  "device_name":    "ark-kiosk-01",      // from manifest.identity.name
  "manifest_id":    "m_abc12345",
  "role":           "kiosk",
  "uptime_s":       123456,
  "cpu_temp_c":     42.5,
  "cpu_load":       [0.15, 0.10, 0.05],  // 1/5/15 min averages
  "memory_used_mb": 380,
  "memory_total_mb": 512,
  "disk_used_pct":  18,
  "wifi_rssi":      -54,
  "battery_pct":    null,                // null unless PiSugar present
  "battery_v":      null,
  "services":       {"ssh": "running", "kiosk": "healthy"},
  "last_boot":      "2026-05-20T08:00:00Z",
  "build_version":  "0.1.0",
  "auth_status":    "key-based"          // never the password itself
}
```

**Auth status is an enum, never a credential.** The agent inspects
`/root/.ssh/authorized_keys` (key-based) or the SSH config
(password-based) and reports a flag. The password itself is never
read, hashed, transmitted, or logged.

---

## What it accepts

`POST` from the Hub (via SSH or via a small HTTP endpoint on the
Pi, port 7401, authenticated with the shared token):

- `reboot`     — `sudo reboot`
- `kiosk.restart` — `systemctl restart kiosk.service`
- `pull-config` — re-fetch the manifest from the Hub and re-apply

---

## Install

The Ark build pipeline writes:
- `/etc/ark/manifest.json`
- `/etc/ark/hub.url`     (filled with the Hub URL chosen in the UI)
- `/etc/ark/agent.token` (256-bit random; only the Hub knows it)
- `/usr/local/bin/ark-agent.py`
- `/etc/systemd/system/ark-agent.service`

Then `systemctl enable ark-agent`. On first boot it'll register
with the Hub.

---

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| Device shows OFFLINE in UI | Hub hasn't heard from agent in `staleness_window` | Check `journalctl -u ark-agent`. Likely network drop or service crash. systemd will restart in 10s. |
| Auth status: unknown | Agent can't read its config files | Re-flash with build pipeline or copy missing files |
| CPU temp missing | `/sys/class/thermal/thermal_zone0/temp` not readable | Permissions issue; agent runs as root by default |
| Battery null but PiSugar plugged | i2c not enabled in `config.txt` | Add `dtparam=i2c_arm=on`; manifest's `hardware.pisugar=true` should ensure this |

---

## Why this isn't built yet

The Ark Agent only matters when the **Ark Hub** exists. Per the
"don't over-engineer fleet/telemetry first" rule in the original
Ark spec, fleet pieces are Phase 4. Phase 1-3 stay focused on:
- Manifest system ✅
- Config generation ✅
- Image builder pipeline (Phase 3)

When Phase 3 lands, this agent goes into the image's first-boot
script and registers automatically. Then Phase 4 is unblocked.
