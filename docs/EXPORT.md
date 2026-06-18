# Ark Network Export + Backup

Status: **Phase 4.x spec** — not implemented yet. Network View UI
needs to land first; this is the export feature that hangs off it.

---

## Use cases

1. **Spreadsheet handoff** — paste a CSV into a doc for a network audit.
2. **Full system backup** — JSON bundle of every device + manifest
   + last-known IP + telemetry, restorable into a fresh Ark install.
3. **Single device clone** — export one device's full state so it
   can be re-instantiated as a sibling on another network.
4. **Fleet snapshot** — only Ark-managed devices, with telemetry,
   for audit / migration / drift detection.

## Export modes

### A. Spreadsheet (.csv / .xlsx)

| Device Name | Role | Status | IP | MAC | Hostname | OS | Uptime | CPU Temp | Auth Status | Vendor | Notes | Manifest ID | Last Seen |

Rules:
- Reflects EXACT UI state — filtered view = filtered CSV
- Sortable / pivotable in Excel + Sheets
- No sensitive data (no passwords, no SSH private keys)

### B. Full backup bundle (.json)

A single JSON file containing every piece of Ark state:

```json
{
  "network_export": {
    "timestamp": "2026-05-21T11:45:27Z",
    "ark_version": "0.2.0",
    "hub_version": "0.1.0",
    "subnet": "192.168.4.0/22",
    "scan_method": "arp + mdns + agent",
    "devices":         [...],
    "manifests":       [...],
    "known_hosts":     [...],
    "unknown_devices": [...],
    "telemetry_history": [...]
  }
}
```

Restores cleanly into a fresh Ark instance via a future "Import"
flow.

### C. Single device export

One device + its manifest + its last-known network state, in a
single JSON. Use case: clone to another network, or carry a
device's identity across a re-flash.

```json
{
  "device": {...},
  "manifest_ref": "ark-kiosk-01@v3",
  "manifest_snapshot": {...},
  "last_known_network": {...},
  "hardware_profile": {...},
  "agent_snapshot": {...}
}
```

### D. Fleet snapshot

Subset of (B) — only Ark-managed devices (those with a manifest_id
or agent_id). Used for audit, migration, drift checks. Same JSON
shape as (B) but `unknown_devices: []`.

---

## UI design — Export modal

```
Inside Network View:    [ Export Network ▼ ]

Modal opens:
──────────────────────────────────────────────
EXPORT OPTIONS

  Scope
  ( ) Entire Network
  ( ) Ark Devices Only
  ( ) Unknown Devices Only
  ( ) Selected Rows (count: 4)

  Format
  ( ) Spreadsheet (.csv / .xlsx)
  ( ) Full Backup Bundle (.json)
  ( ) Single Device Export
  ( ) Fleet Snapshot

  Advanced
  [✓] Include telemetry
  [✓] Include last-seen history
  [✓] Include MAC addresses
  [ ] Include sensitive fields (default OFF)

                            [ Cancel ]  [ Download Export ]
──────────────────────────────────────────────
```

## Consistency rule

The export is a **frozen snapshot** — all rows locked to one
timestamp. The Hub takes a copy of `state.devices` at click time
and the modal builds the export from THAT copy, not from live
state that's still updating in the background. No partial scans
included.

## Security rules — non-negotiable

NEVER export:
- Plaintext passwords
- WiFi credentials
- SSH private keys
- API tokens

Always export as redacted:
```json
{ "wifi_password": "***REDACTED***" }
{ "ssh_token":     "***REDACTED***" }
```

The "Include sensitive fields" checkbox is checkbox-only — even
when ticked, the values are replaced with `***REDACTED***`
strings. We never write the real credentials to disk. (The
checkbox just tells future-Ark to mark fields with redaction
markers instead of dropping them entirely.)

## "Backup my phone entirely" — limits

Spec called out this user request explicitly. The honest answer
in the UI:

> Ark sees devices from the network side only. We can capture:
> ✔ IP + MAC + vendor + mDNS services + connection history
> ✘ Internal files, photos, messages, app data
>
> If you want a full phone backup, use the phone's native backup
> (iCloud / Google Backup / iMazing / Time Machine etc).

What we CAN export for a phone:
- Network identity snapshot
- Service exposure map (what ports/services are visible from LAN)
- Vendor + MAC fingerprint
- Connection history (if Hub has been observing long enough)

---

## Phase ordering

| Phase | What |
|---|---|
| 4.x.0 | This spec (now) |
| 4.x.1 | Network View table UI consuming Hub `/api/devices` (Phase 4.1 work) |
| 4.x.2 | CSV export of current view (1-day add — pure JS Blob) |
| 4.x.3 | JSON bundle export (network + manifests + tags) |
| 4.x.4 | Single device export from row context menu |
| 4.x.5 | Import flow — read JSON bundle, restore state |
| 4.x.6 | Telemetry history capture (needs persistent store; today the Hub is in-memory only) |
