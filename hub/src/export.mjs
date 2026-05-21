// Hub export helpers — turn store data into operator-readable formats.
//
// Phase 4.7. Strict security rules apply to every export path:
//   - NEVER export passwords, SSH keys, WiFi credentials, API tokens.
//   - Telemetry's raw_json may carry agent-reported fields; we whitelist
//     known-safe keys before exporting.

const SAFE_TELEMETRY_KEYS = new Set([
  'device_name', 'hostname', 'mac', 'ip',
  'uptime_s', 'cpu_temp_c', 'memory_used_pct', 'disk_used_pct',
  'load_1m', 'os', 'agent_version', 'services',
  'manifest_id', 'reported_at',
]);

export function sanitizeTelemetry(report) {
  if (!report) return null;
  const out = {};
  for (const [k, v] of Object.entries(report)) {
    if (SAFE_TELEMETRY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function devicesCsv(devices) {
  // Header + rows. Strings get CSV-quoted; nulls become empty.
  const cols = ['device_id','mac','hostname','device_name','vendor','os','trust_state','first_seen','last_seen'];
  const rows = [cols.join(',')];
  for (const d of devices) {
    rows.push(cols.map(c => csvField(d[c])).join(','));
  }
  return rows.join('\n') + '\n';
}

export function networksCsv(networks) {
  const cols = ['network_id','type','ssid','subnet','gateway_ip','gateway_mac','security','first_seen','last_seen'];
  const rows = [cols.join(',')];
  for (const n of networks) {
    rows.push(cols.map(c => csvField(n[c])).join(','));
  }
  return rows.join('\n') + '\n';
}

function csvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Single-device export: device + all sightings + bounded telemetry +
// sanitized for safe transport.
export function deviceExport(store, deviceId, { telemetryLimit = 200 } = {}) {
  const device    = store.getDevice(deviceId);
  if (!device) return null;
  const sightings = store.listDeviceSightings(deviceId, 500);
  const tRows     = store.listTelemetry(deviceId, telemetryLimit);

  return {
    schema_version: 1,
    generated_at:   new Date().toISOString(),
    device,
    sightings,
    telemetry: tRows.map(t => {
      let raw;
      try { raw = JSON.parse(t.raw_json); } catch { raw = {}; }
      return {
        reported_at:     t.reported_at,
        uptime_s:        t.uptime_s,
        cpu_temp_c:      t.cpu_temp_c,
        load_1m:         t.load_1m,
        memory_used_pct: t.memory_used_pct,
        disk_used_pct:   t.disk_used_pct,
        ip:              t.ip,
        sanitized:       sanitizeTelemetry(raw),
      };
    }),
  };
}

// Fleet snapshot is delegated to store.fleetSnapshot() — this wrapper
// sanitises the latest_telemetry blob before handing it over.
export function fleetExport(store) {
  const snap = store.fleetSnapshot();
  for (const d of snap.devices) {
    if (d.latest_telemetry) {
      let raw;
      try { raw = JSON.parse(d.latest_telemetry.raw_json); } catch { raw = {}; }
      d.latest_telemetry = {
        reported_at:     d.latest_telemetry.reported_at,
        cpu_temp_c:      d.latest_telemetry.cpu_temp_c,
        uptime_s:        d.latest_telemetry.uptime_s,
        memory_used_pct: d.latest_telemetry.memory_used_pct,
        disk_used_pct:   d.latest_telemetry.disk_used_pct,
        load_1m:         d.latest_telemetry.load_1m,
        ip:              d.latest_telemetry.ip,
        sanitized:       sanitizeTelemetry(raw),
      };
    }
  }
  return snap;
}

// Optional: import a previously-exported snapshot back into the store.
// Idempotent — upserts everything. Doesn't replay sightings/telemetry
// (those should remain immutable).
export function importSnapshot(store, snap) {
  if (!snap || snap.schema_version !== 1) {
    throw new Error('Unsupported snapshot schema version');
  }
  let nets = 0, devs = 0;
  for (const n of snap.networks || []) { store.upsertNetwork(n); nets++; }
  for (const d of snap.devices  || []) { store.upsertDevice(d);  devs++; }
  return { networks_imported: nets, devices_imported: devs };
}
