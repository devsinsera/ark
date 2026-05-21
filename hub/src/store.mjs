// Ark Hub storage — SQLite persistence layer.
//
// Phase 4.3 milestone: this is the FIRST persistent state in Ark. The
// browser app, the Hub, and the installer engine were all stateless
// (or localStorage-only) before this. Networks, devices, and agent
// telemetry now survive Hub restarts.
//
// Database file: ~/.ark/ark-hub.db (override with ARK_HUB_DB env var).
// Pure stdlib — node:sqlite landed stable in Node 22+; verified
// importable on Node 25.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = 1;

const DEFAULT_PATH = process.env.ARK_HUB_DB
  || path.join(homedir(), '.ark', 'ark-hub.db');

// ── DDL ─────────────────────────────────────────────────────────────
const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  network_id TEXT PRIMARY KEY,
  type       TEXT NOT NULL,          -- 'wifi' | 'ethernet' | 'unknown'
  ssid       TEXT,                   -- nullable for ethernet
  subnet     TEXT,
  gateway_ip TEXT,
  gateway_mac TEXT,
  security   TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,      -- normalised MAC if available, else IP
  mac         TEXT,
  vendor      TEXT,
  hostname    TEXT,
  device_name TEXT,
  os          TEXT,
  manifest_id TEXT,
  trust_state TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_sightings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  ip          TEXT NOT NULL,
  source      TEXT NOT NULL,         -- 'arp' | 'mdns' | 'agent'
  seen_at     TEXT NOT NULL,
  FOREIGN KEY (device_id)  REFERENCES devices(device_id),
  FOREIGN KEY (network_id) REFERENCES networks(network_id)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL,
  reported_at     TEXT NOT NULL,
  uptime_s        INTEGER,
  cpu_temp_c      REAL,
  load_1m         REAL,
  memory_used_pct REAL,
  disk_used_pct   REAL,
  ip              TEXT,
  services_json   TEXT,
  raw_json        TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX IF NOT EXISTS idx_sightings_device  ON device_sightings(device_id);
CREATE INDEX IF NOT EXISTS idx_sightings_network ON device_sightings(network_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_device  ON telemetry(device_id, reported_at);
`;

export function openStore(filePath = DEFAULT_PATH) {
  // Make sure the parent dir exists. Cheap idempotent mkdir.
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(DDL);

  // Record schema version once
  const existing = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
  if (!existing) {
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }

  return {
    db,
    path: filePath,

    // ── Networks ──────────────────────────────────────────────────────
    upsertNetwork(net) {
      const now = new Date().toISOString();
      // Insert OR update last_seen.
      db.prepare(`
        INSERT INTO networks (network_id, type, ssid, subnet, gateway_ip, gateway_mac, security, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(network_id) DO UPDATE SET
          last_seen   = excluded.last_seen,
          ssid        = COALESCE(excluded.ssid,        networks.ssid),
          subnet      = COALESCE(excluded.subnet,      networks.subnet),
          gateway_ip  = COALESCE(excluded.gateway_ip,  networks.gateway_ip),
          gateway_mac = COALESCE(excluded.gateway_mac, networks.gateway_mac),
          security    = COALESCE(excluded.security,    networks.security)
      `).run(
        net.network_id,
        net.type || 'unknown',
        net.ssid || null,
        net.subnet || null,
        net.gateway_ip || null,
        net.gateway_mac || null,
        net.security || null,
        net.first_seen || now,
        now,
      );
    },

    listNetworks() {
      return db.prepare(`SELECT * FROM networks ORDER BY last_seen DESC`).all();
    },

    getNetwork(networkId) {
      return db.prepare(`SELECT * FROM networks WHERE network_id = ?`).get(networkId);
    },

    // ── Devices ────────────────────────────────────────────────────────
    upsertDevice(d) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO devices (device_id, mac, vendor, hostname, device_name, os, manifest_id, trust_state, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          last_seen   = excluded.last_seen,
          mac         = COALESCE(excluded.mac,         devices.mac),
          vendor      = COALESCE(excluded.vendor,      devices.vendor),
          hostname    = COALESCE(excluded.hostname,    devices.hostname),
          device_name = COALESCE(excluded.device_name, devices.device_name),
          os          = COALESCE(excluded.os,          devices.os),
          manifest_id = COALESCE(excluded.manifest_id, devices.manifest_id),
          trust_state = COALESCE(excluded.trust_state, devices.trust_state)
      `).run(
        d.device_id,
        d.mac || null,
        d.vendor || null,
        d.hostname || null,
        d.device_name || null,
        d.os || null,
        d.manifest_id || null,
        d.trust_state || 'unknown',
        d.first_seen || now,
        now,
      );
    },

    listDevices() {
      return db.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all();
    },

    getDevice(deviceId) {
      return db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get(deviceId);
    },

    // ── Device sightings ───────────────────────────────────────────────
    recordSighting(deviceId, networkId, ip, source) {
      db.prepare(`
        INSERT INTO device_sightings (device_id, network_id, ip, source, seen_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(deviceId, networkId, ip, source, new Date().toISOString());
    },

    listDeviceSightings(deviceId, limit = 100) {
      return db.prepare(`
        SELECT s.*, n.ssid, n.type AS network_type
        FROM device_sightings s
        LEFT JOIN networks n USING (network_id)
        WHERE s.device_id = ?
        ORDER BY s.seen_at DESC
        LIMIT ?
      `).all(deviceId, limit);
    },

    countSightingsByNetwork(networkId) {
      return db.prepare(`
        SELECT COUNT(DISTINCT device_id) AS device_count
        FROM device_sightings
        WHERE network_id = ?
      `).get(networkId).device_count;
    },

    // ── Telemetry ──────────────────────────────────────────────────────
    recordTelemetry(deviceId, report) {
      db.prepare(`
        INSERT INTO telemetry (device_id, reported_at, uptime_s, cpu_temp_c, load_1m, memory_used_pct, disk_used_pct, ip, services_json, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        new Date().toISOString(),
        report.uptime_s        ?? null,
        report.cpu_temp_c      ?? null,
        report.load_1m         ?? null,
        report.memory_used_pct ?? null,
        report.disk_used_pct   ?? null,
        report.ip              ?? null,
        report.services ? JSON.stringify(report.services) : null,
        JSON.stringify(report),
      );
    },

    listTelemetry(deviceId, limit = 200) {
      return db.prepare(`
        SELECT * FROM telemetry
        WHERE device_id = ?
        ORDER BY reported_at DESC
        LIMIT ?
      `).all(deviceId, limit);
    },

    latestTelemetry(deviceId) {
      return db.prepare(`
        SELECT * FROM telemetry WHERE device_id = ?
        ORDER BY reported_at DESC LIMIT 1
      `).get(deviceId);
    },

    // ── Fleet snapshot (Phase 4.7 export) ──────────────────────────────
    fleetSnapshot() {
      const devices = db.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all();
      const networks = db.prepare(`SELECT * FROM networks ORDER BY last_seen DESC`).all();
      const stmt = db.prepare(`SELECT * FROM telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT 1`);
      for (const d of devices) {
        d.latest_telemetry = stmt.get(d.device_id) || null;
      }
      return {
        schema_version: SCHEMA_VERSION,
        generated_at:   new Date().toISOString(),
        networks,
        devices,
      };
    },

    // Maintenance: keep DB size bounded by pruning old telemetry +
    // device_sightings rows. Operator-tunable retention.
    prune({ maxTelemetryPerDevice = 1000, maxSightingsPerDevice = 200 } = {}) {
      db.exec(`
        DELETE FROM telemetry WHERE id NOT IN (
          SELECT id FROM telemetry t1
          WHERE (SELECT COUNT(*) FROM telemetry t2
                 WHERE t2.device_id = t1.device_id AND t2.reported_at >= t1.reported_at) <= ${maxTelemetryPerDevice}
        );
      `);
      db.exec(`
        DELETE FROM device_sightings WHERE id NOT IN (
          SELECT id FROM device_sightings s1
          WHERE (SELECT COUNT(*) FROM device_sightings s2
                 WHERE s2.device_id = s1.device_id AND s2.seen_at >= s1.seen_at) <= ${maxSightingsPerDevice}
        );
      `);
    },

    close() {
      db.close();
    },
  };
}
