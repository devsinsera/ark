# Can't Phish Here

Defensive security module for Ark. Wraps the recon-side capabilities
of the RaspyJack codebase (located at `~/Downloads/Jack/`) and
surfaces them through Ark's UI as a passive, alert-driven security
guardian for owned + approved infrastructure.

## Hard rules

These are **enforced in code**, not just policy:

1. **Active probes target only approved hosts.** Unapproved IPs are
   logged and alerted on; they're never scanned, port-checked, or
   banner-grabbed.
2. **No brute-force / default-credentials attempts.** The
   `payloads/credentials/` tree from RaspyJack is NEVER invoked. The
   hardening checklist instead recommends manual checks the operator
   runs themselves.
3. **No traffic injection.** `DNSSpoof/`, deauth, and ARP spoofing
   scripts in RaspyJack are NEVER invoked.
4. **Recommendations only.** Ark never auto-disables services, opens
   firewall ports, or installs packages. Every fix the hardening tab
   suggests is a shell command the operator copy-pastes.

## What RaspyJack code IS used (read-only patterns)

Direct copies aren't made — Can't Phish Here uses the *techniques*:

| RaspyJack file | What we borrowed |
|---|---|
| `payloads/reconnaissance/arp_scan_stealth.py` | The ARP-table parsing approach (Hub already does this) |
| `payloads/reconnaissance/mdns_scanner.py` | The mDNS service-type list — copied for the Hub's HomeKit/Matter browse |
| `payloads/reconnaissance/cert_scanner.py` | TLS cert expiry check pattern (used in hardening recommendations) |
| `payloads/reconnaissance/cctv_scanner.py` | Port/path patterns for identifying CCTV (used to LABEL approved cameras, never to probe) |

Everything else is original Ark code.

## Architecture

```
Browser UI
    │   ARK → SECURITY TOOLS → Can't Phish Here (6 tabs)
    ▼
Ark Hub (existing) + security.mjs (new)
    │
    │   on each scan tick:
    │     security.detect({ currentDevices, store })
    │     → raises new_device / device_offline / mac_change alerts
    │
    │   /api/cph/*  endpoints:
    │     overview · alerts · approved · checks · findings
    │
    └── SQLite (~/.ark/ark-hub.db)
          cph_approved_hosts
          cph_alerts
          cph_hardening_findings
```

The detector runs on data the Hub already has — no Pi-side daemon
required for v1. A passive monitoring agent (traffic anomaly
detection) is a Phase-2 enhancement.

## Files added

| File | Purpose |
|---|---|
| `hub/src/security.mjs` | SQLite schema, alert engine, approved-host registry, hardening definitions, in-tick detector |
| `hub/src/index.mjs` | 10 new endpoints under `/api/cph/*` |
| `app/src/CantPhishHere.jsx` | 6-tab UI: Overview / Devices / Alerts / Logs / Hardening / Settings |
| `app/src/App.jsx` | Nav entry + route |
| `docs/CANT_PHISH_HERE.md` | This file |

## Alert kinds

```
new_device       → an unapproved device appeared on the LAN
device_offline   → an approved device hasn't been seen in 5+ min
mac_change       → hostname's MAC changed (possible spoofing)
ip_change        → approved device got a new IP
port_open        → approved host has a new port open
cert_expiry      → approved host's TLS cert expires soon
service_change   → approved host's advertised services changed
unusual_traffic  → reserved for Phase-2 passive monitor on a Pi
```

Each alert has a **stable id** built from `kind + device_id +
subject-hash` so repeated detections dedupe instead of stacking. The
operator acks (silences notifications) or resolves (closes the alert
entirely).

## Detection pipeline

```
1. Hub.runScan()   (existing — ARP + mDNS + agent reports merged)
2. security.detect({ currentDevices, store })
3. For each device d in currentDevices:
     if isApproved(d) → continue
     else             → raiseAlert('new_device', severity='warn', ...)
4. For each approved host a:
     last-seen age > 5 min → raiseAlert('device_offline', severity='info')
5. raiseAlert() inserts into cph_alerts with stable_id; UNIQUE constraint
   dedupes re-raises.
```

Future enhancements (gated on Pi-side daemon):
- MAC change for an approved host's IP
- Port-state diff (new port opened)
- TLS cert expiry < 30 days
- Repeated failed connections in tcpdump tail

## Hardening pipeline

Today: read-only checklist served at `/api/cph/checks`. Eight items,
each with `severity`, `rationale`, `how_to_check`, `how_to_fix`.

Future: a `recordFinding()` endpoint operators can call with the
output of running a check (auto-script TBD), generating a history
of pass/fail observations per approved host.

## What still needs building

1. **Pi-side passive monitor.** A daemon that tails `tcpdump` /
   `journalctl` and posts anomalies (repeated failed ssh, ARP table
   flapping, etc.) back to the Hub as `unusual_traffic` alerts.
2. **Webhook/email integration.** Alerts surface in the UI today;
   pushing them to Slack / Discord / email is not wired.
3. **Auto-discover for `mac_change` and `port_open`.** Schema is
   ready; the per-tick comparison logic needs to land in
   `security.mjs::detect`.
4. **Scheduled hardening runs.** `/api/cph/findings` accepts results
   but doesn't yet have a cron that runs the checks on a schedule.
5. **TLS cert scanner.** `cert_scanner.py` from RaspyJack maps to a
   light-weight `openssl s_client` call from the Pi-side daemon
   against approved hosts only.
6. **LCD mode on Pi Zero (LCD_1in44.py from RaspyJack).** Would let a
   Pi Zero 2 W with the 1.44" screen show the current alert count +
   most-recent alert text. Currently text-only on the Hub UI.

## Risks

- **Approved-host list is operator-supplied.** A misconfigured CIDR
  (e.g. `0.0.0.0/0`) would silently approve the entire LAN. UI
  doesn't currently warn about over-broad patterns.
- **No rate limit on alert raise.** A flapping device could produce
  one alert per scan tick; the dedupe-by-stable-id mostly handles
  this but isn't a hard limit.
- **Hub trust boundary.** The Hub stores plaintext approved-host
  records in SQLite (no creds, but the list itself is a signal). DB
  file is mode 0600 by default on macOS; verify on other hosts.

## Engine integration

Can't Phish Here is NOT installed via the Installer Engine in v1
because it has no Pi-side runtime — it's pure Hub + UI. When the
Phase-2 passive daemon lands, it'll ship as an installer profile in
`builds/cant-phish-here/profile.json`.
