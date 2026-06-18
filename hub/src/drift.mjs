// Drift detection — Phase 4.5 + Phase 5 multi-network drift.
//
// Two kinds of drift:
//   1. CONFIG drift: an Agent-reported state differs from the device's
//      manifest. Service declared but not running, kiosk URL changed,
//      packages diverged, OS version mismatch.
//   2. NETWORK drift: a device that was last seen on network A is now
//      on network B (or shows up on a new network for the first time).
//
// Drift events persist in a table for the UI to surface as banners.

import { DatabaseSync } from 'node:sqlite';

const DDL = `
CREATE TABLE IF NOT EXISTS drift_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- 'service' | 'kiosk_url' | 'packages' | 'os' | 'network' | 'manifest_missing'
  field       TEXT,
  expected    TEXT,
  actual      TEXT,
  detected_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_drift_device_kind ON drift_events(device_id, kind, detected_at DESC);
`;

export function initDrift(db) {
  if (!(db instanceof DatabaseSync)) throw new Error('initDrift: expected DatabaseSync');
  db.exec(DDL);
}

/**
 * Compare an incoming Agent telemetry report against the device's
 * registered manifest. Returns a list of drift events (NOT YET
 * persisted) so the caller can decide whether to record them.
 *
 * `manifest` is optional. If null (no manifest assigned), we record a
 * single 'manifest_missing' event so the operator knows the device is
 * un-tracked.
 */
export function detectConfigDrift({ deviceId, report, manifest }) {
  const events = [];
  const push = (kind, field, expected, actual) => {
    events.push({ device_id: deviceId, kind, field, expected: stringify(expected), actual: stringify(actual) });
  };

  if (!manifest) {
    push('manifest_missing', null, null, null);
    return events;
  }

  // OS mismatch
  if (manifest.os && report.os && !report.os.toLowerCase().includes(manifest.os.toLowerCase())) {
    push('os', 'os', manifest.os, report.os);
  }

  // Service drift — manifest may list expected service names
  const expectedSvcs = Array.isArray(manifest.expected_services)
    ? manifest.expected_services
    : (manifest.services && Array.isArray(manifest.services) ? manifest.services.map(s => s.name || s) : null);
  const actualSvcs = Array.isArray(report.services)
    ? report.services.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean)
    : [];
  if (expectedSvcs) {
    for (const expected of expectedSvcs) {
      if (!actualSvcs.includes(expected)) {
        push('service', 'missing', expected, null);
      }
    }
  }

  // Kiosk URL drift
  if (manifest.kiosk_url && report.kiosk_url && manifest.kiosk_url !== report.kiosk_url) {
    push('kiosk_url', 'kiosk_url', manifest.kiosk_url, report.kiosk_url);
  }

  // Package drift (apt) — only flag explicit absences if the manifest
  // declares apt deps; pip is too noisy for drift checks at this stage.
  const expectedApt = manifest.dependencies?.apt;
  const installedApt = report.apt_installed || report.installed_apt;
  if (Array.isArray(expectedApt) && Array.isArray(installedApt)) {
    for (const pkg of expectedApt) {
      if (!installedApt.includes(pkg)) push('packages', 'apt_missing', pkg, null);
    }
  }

  return events;
}

/**
 * Multi-network drift: compare the device's most-recent sighting's
 * network_id to the previous one. Returns 0 or 1 event.
 */
export function detectNetworkDrift({ deviceId, store }) {
  const recent = store.listDeviceSightings(deviceId, 2);
  if (recent.length < 2) return [];
  const [current, previous] = recent;   // listDeviceSightings is DESC
  if (current.network_id === previous.network_id) return [];

  // Don't spam the same drift on every scan tick — only record when
  // we haven't already logged this transition recently.
  const existing = store.db.prepare(`
    SELECT id FROM drift_events
    WHERE device_id = ?
      AND kind = 'network'
      AND expected = ?
      AND actual = ?
      AND resolved_at IS NULL
    ORDER BY detected_at DESC LIMIT 1
  `).get(deviceId, previous.network_id, current.network_id);
  if (existing) return [];

  return [{
    device_id: deviceId,
    kind: 'network',
    field: 'network_id',
    expected: previous.network_id,
    actual:   current.network_id,
  }];
}

export function recordDriftEvents(db, events) {
  if (!events?.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO drift_events (device_id, kind, field, expected, actual, detected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let inserted = 0;
  for (const e of events) {
    stmt.run(e.device_id, e.kind, e.field, e.expected, e.actual, now);
    inserted++;
  }
  return inserted;
}

export function listDrift(db, { deviceId, limit = 100, includeResolved = false } = {}) {
  if (deviceId) {
    const sql = `SELECT * FROM drift_events WHERE device_id = ?${includeResolved ? '' : ' AND resolved_at IS NULL'} ORDER BY detected_at DESC LIMIT ?`;
    return db.prepare(sql).all(deviceId, limit);
  }
  const sql = `SELECT * FROM drift_events${includeResolved ? '' : ' WHERE resolved_at IS NULL'} ORDER BY detected_at DESC LIMIT ?`;
  return db.prepare(sql).all(limit);
}

export function resolveDrift(db, id) {
  const r = db.prepare(`UPDATE drift_events SET resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
  return r.changes > 0;
}

function stringify(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
