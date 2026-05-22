#!/usr/bin/env node
// Ark Hub — LAN discovery + agent collector. Runs on the LAN
// (typically the user's Mac during development; a Pi or NAS in
// production). Exposes a small REST API the browser UI polls.
//
// Phase 4.3: now persists to SQLite at ~/.ark/ark-hub.db.
// Phase 4.7: exposes /api/export/* and /api/import/* endpoints.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arpScan, mdnsBrowse, mergeSources, wifiScan, detectCurrentNetwork } from './scan.mjs';
import { openStore } from './store.mjs';
import { openVault } from './vault.mjs';
import { initDrift, detectConfigDrift, detectNetworkDrift, recordDriftEvents, listDrift, resolveDrift } from './drift.mjs';
import { computeHealth } from './health.mjs';
import { devicesCsv, networksCsv, deviceExport, fleetExport, importSnapshot } from './export.mjs';
import { listBuilds, getBuild, listImages, tailFile, hubLogPath, buildLogPath } from './inventory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PORT = Number(process.env.ARK_HUB_PORT || 7400);
const SCAN_INTERVAL_MS = Number(process.env.ARK_HUB_SCAN_INTERVAL_MS || 5000);
const VERSION = '0.3.0';
const AGENT_FILE = path.join(REPO_ROOT, 'agent', 'ark-agent.py');

// Persistent store (SQLite). Opens — and creates the file if it
// doesn't exist — at construction time. Fatal if we can't reach it.
const store = openStore();
console.log(`[hub] persistent store: ${store.path}`);

// Encrypted credential vault — Phase 5.1. Shares the same SQLite DB.
const vault = openVault(store.db);
console.log(`[hub] vault ready (key fingerprint ${vault.keyFingerprint()})`);

// Drift event table — Phase 4.5 / Phase 5.2 multi-network drift.
initDrift(store.db);

// Pre-compute agent file metadata for the OTA endpoint. Re-checked on
// each /api/agent/latest call so swapping the file picks up live.
async function agentMeta() {
  if (!existsSync(AGENT_FILE)) return null;
  const body = await readFile(AGENT_FILE);
  const version = (body.toString().match(/^AGENT_VERSION\s*=\s*"([^"]+)"/m) || [, 'unknown'])[1];
  const sha256  = createHash('sha256').update(body).digest('hex');
  const size    = body.length;
  return { version, sha256, size };
}

// In-memory state (live scan view; the DB is the long-term record).
const state = {
  scanned_at: null,
  devices: [],
  current_network: null,
  agents: new Map(),
  scan_count: 0,
  wifi: { scanned_at: null, active: null, nearby: [] },
  wifi_inflight: false,
  // Phase 4.5: in-memory manifest registry used by drift detection.
  // Populated via POST /api/manifests/register — UI hands the Hub
  // the manifests it cares about so the Hub can compare Agent reports.
  manifests: new Map(),
};

async function runScan() {
  try {
    const [arp, mdns] = await Promise.all([
      arpScan(),
      mdnsBrowse({ timeoutMs: 4000 }),
    ]);
    const agents = [...state.agents.values()];
    const merged = mergeSources({ arp, mdns, agents });

    // Figure out which network we're on. Persist it + every device
    // sighting on it. The cached Wi-Fi state (if any) informs whether
    // we're on Wi-Fi vs Ethernet.
    const net = await detectCurrentNetwork({ activeWifi: state.wifi.active });
    if (net) {
      state.current_network = net;
      store.upsertNetwork({
        network_id:  net.network_id,
        type:        net.type,
        ssid:        net.ssid,
        subnet:      net.subnet,
        gateway_ip:  net.gateway_ip,
        gateway_mac: net.gateway_mac,
        security:    net.security,
      });
    }

    for (const d of merged) {
      const deviceId = d.mac || d.ip;
      store.upsertDevice({
        device_id:   deviceId,
        mac:         d.mac,
        vendor:      d.vendor,
        hostname:    d.hostname,
        device_name: d.device_name,
        os:          d.os,
        manifest_id: d.manifest_id,
        trust_state: d.trust_state || 'unknown',
      });
      if (net && d.ip) {
        store.recordSighting(deviceId, net.network_id, d.ip, (d.sources && d.sources[0]) || 'arp');
      }
    }

    state.devices = merged;
    state.scanned_at = new Date().toISOString();
    state.scan_count++;
  } catch (e) {
    console.error('[hub] scan error:', e.message);
  }
}

// ── HTTP server ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS — browser UI is served from sinsera.co; Hub is localhost.
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ark-agent-token');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── Health + version ──
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, {
      ok: true,
      version: VERSION,
      uptime_s: process.uptime(),
      scan_count: state.scan_count,
      last_scan: state.scanned_at,
      port: PORT,
      store_path: store.path,
    });
  }

  // ── Live devices (in-memory; for the polling UI) ──
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    return json(res, {
      scanned_at: state.scanned_at,
      hub_version: VERSION,
      current_network: state.current_network,
      device_count: state.devices.length,
      devices: state.devices,
    });
  }

  // ── Networks (persisted; Tab 2 of Network Landscape) ──
  if (req.method === 'GET' && url.pathname === '/api/networks') {
    const networks = store.listNetworks();
    for (const n of networks) n.device_count = store.countSightingsByNetwork(n.network_id);
    return json(res, { count: networks.length, networks });
  }

  // ── Single device (with history + telemetry) ──
  const devMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (req.method === 'GET' && devMatch) {
    const id = decodeURIComponent(devMatch[1]);
    const d  = store.getDevice(id);
    if (!d) return json(res, { ok: false, error: 'device not found' }, 404);
    return json(res, {
      device:    d,
      sightings: store.listDeviceSightings(id, 200),
      telemetry: store.listTelemetry(id, 50),
    });
  }

  // ── Agent telemetry ingest ──
  if (req.method === 'POST' && url.pathname === '/api/agent/report') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const r = JSON.parse(body);
        if (!r.device_name) throw new Error('device_name required');
        // Strip anything that looks like a credential. We never persist
        // these even if the agent erroneously includes them.
        delete r.password; delete r.token; delete r.ssh_token;
        delete r.wifi_password; delete r.ssh_private_key;
        r.last_seen = new Date().toISOString();
        r.sources = ['agent'];
        state.agents.set(r.device_name, r);

        // Persist as telemetry. device_id is the agent-reported MAC
        // if available, else falls back to device_name.
        const deviceId = r.mac || r.device_name;
        store.upsertDevice({
          device_id:   deviceId,
          mac:         r.mac,
          hostname:    r.hostname,
          device_name: r.device_name,
          os:          r.os,
          manifest_id: r.manifest_id,
          trust_state: 'trusted',
        });
        store.recordTelemetry(deviceId, r);

        // Phase 4.5 — detect config drift against the device's manifest.
        const manifest = r.manifest_id ? state.manifests.get(r.manifest_id) : null;
        const driftEvents = detectConfigDrift({ deviceId, report: r, manifest });
        const netDrift    = detectNetworkDrift({ deviceId, store });
        const recorded = recordDriftEvents(store.db, [...driftEvents, ...netDrift]);

        // Tell the agent if there's a newer version available, so it
        // can self-update without polling another endpoint.
        const meta = await agentMeta();
        const update = (meta && r.agent_version && meta.version !== r.agent_version)
          ? { available_version: meta.version, sha256: meta.sha256, url: '/api/agent/download' }
          : null;

        return json(res, {
          ok: true,
          device_name: r.device_name,
          device_id: deviceId,
          drift_recorded: recorded,
          update,
        });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── OTA: agent version metadata ──
  if (req.method === 'GET' && url.pathname === '/api/agent/latest') {
    const meta = await agentMeta();
    if (!meta) return json(res, { ok: false, error: 'agent file not found' }, 404);
    return json(res, { ok: true, ...meta, url: '/api/agent/download' });
  }

  // ── OTA: agent download ──
  if (req.method === 'GET' && url.pathname === '/api/agent/download') {
    if (!existsSync(AGENT_FILE)) return json(res, { ok: false, error: 'agent file not found' }, 404);
    const body = await readFile(AGENT_FILE);
    res.writeHead(200, {
      'content-type': 'text/x-python',
      'content-disposition': 'attachment; filename="ark-agent.py"',
      'content-length': body.length,
    });
    return res.end(body);
  }

  // ── Vault (Phase 5.1) ──
  if (req.method === 'POST' && url.pathname === '/api/vault/set') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        const out = vault.set(r);
        return json(res, { ok: true, ...out });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/vault/list') {
    return json(res, { entries: vault.list() });
  }
  const vaultDel = url.pathname.match(/^\/api\/vault\/([^/]+)$/);
  if (req.method === 'DELETE' && vaultDel) {
    const ok = vault.delete(decodeURIComponent(vaultDel[1]));
    return json(res, { ok });
  }

  // ── Drift events (Phase 4.5 + 5.2) ──
  if (req.method === 'GET' && url.pathname === '/api/drift') {
    const includeResolved = url.searchParams.get('include_resolved') === '1';
    const limit = Number(url.searchParams.get('limit') || 100);
    return json(res, { events: listDrift(store.db, { limit, includeResolved }) });
  }
  const driftDevMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/drift$/);
  if (req.method === 'GET' && driftDevMatch) {
    const id = decodeURIComponent(driftDevMatch[1]);
    const includeResolved = url.searchParams.get('include_resolved') === '1';
    return json(res, { events: listDrift(store.db, { deviceId: id, includeResolved }) });
  }
  const driftResolveMatch = url.pathname.match(/^\/api\/drift\/(\d+)\/resolve$/);
  if (req.method === 'POST' && driftResolveMatch) {
    const id = Number(driftResolveMatch[1]);
    const ok = resolveDrift(store.db, id);
    return json(res, { ok });
  }

  // ── Manifest registry (Phase 4.5 — UI pushes manifests for drift checks) ──
  if (req.method === 'POST' && url.pathname === '/api/manifests/register') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        if (!m.id) throw new Error('manifest id required');
        // Strip credential-shaped fields before storing — even though
        // this is local-only, defense-in-depth.
        const sanitized = { ...m };
        if (sanitized.network) {
          delete sanitized.network.wifi_password;
          delete sanitized.network.ssh_private_key;
        }
        state.manifests.set(m.id, sanitized);
        return json(res, { ok: true, registered: m.id, count: state.manifests.size });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/manifests') {
    return json(res, { count: state.manifests.size, ids: [...state.manifests.keys()] });
  }

  // ── Inventory: builds / images / logs (Phase 2 + 3 stub fix-ups) ──
  if (req.method === 'GET' && url.pathname === '/api/builds') {
    return json(res, { builds: await listBuilds() });
  }
  const buildMatch = url.pathname.match(/^\/api\/builds\/([^/]+)$/);
  if (req.method === 'GET' && buildMatch) {
    const b = await getBuild(decodeURIComponent(buildMatch[1]));
    if (!b) return json(res, { ok: false, error: 'build not found' }, 404);
    return json(res, b);
  }
  if (req.method === 'GET' && url.pathname === '/api/images') {
    return json(res, await listImages());
  }
  if (req.method === 'GET' && url.pathname === '/api/logs/hub') {
    return json(res, await tailFile(hubLogPath(), { maxBytes: 128 * 1024 }));
  }
  const buildLogMatch = url.pathname.match(/^\/api\/logs\/build\/([^/]+)$/);
  if (req.method === 'GET' && buildLogMatch) {
    return json(res, await tailFile(buildLogPath(decodeURIComponent(buildLogMatch[1])), { maxBytes: 128 * 1024 }));
  }

  // ── Health (Phase 4.6) ──
  const healthMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/health$/);
  if (req.method === 'GET' && healthMatch) {
    const id = decodeURIComponent(healthMatch[1]);
    const device = store.getDevice(id);
    if (!device) return json(res, { ok: false, error: 'device not found' }, 404);
    const tel = store.latestTelemetry(id);
    const sgt = store.listDeviceSightings(id, 5);
    const h = computeHealth({ telemetry: tel, sightings: sgt, manifestId: device.manifest_id });
    return json(res, { device_id: id, ...h });
  }
  if (req.method === 'GET' && url.pathname === '/api/health/fleet') {
    const devices = store.listDevices();
    const fleet = devices.map(d => {
      const tel = store.latestTelemetry(d.device_id);
      const sgt = store.listDeviceSightings(d.device_id, 5);
      const h = computeHealth({ telemetry: tel, sightings: sgt, manifestId: d.manifest_id });
      return { device_id: d.device_id, device_name: d.device_name || d.hostname, ...h };
    });
    return json(res, { fleet });
  }

  // ── Manual scan trigger ──
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    await runScan();
    return json(res, { ok: true, scanned_at: state.scanned_at, device_count: state.devices.length });
  }

  // ── Wi-Fi (cached + refresh) ──
  if (req.method === 'GET' && url.pathname === '/api/wifi') {
    return json(res, state.wifi);
  }
  if (req.method === 'POST' && url.pathname === '/api/wifi/refresh') {
    if (state.wifi_inflight) {
      return json(res, { ok: false, error: 'A Wi-Fi scan is already running.', wifi: state.wifi }, 409);
    }
    state.wifi_inflight = true;
    try {
      const result = await wifiScan({ timeoutMs: 12000 });
      if (result.ok) {
        state.wifi = { scanned_at: result.scanned_at, active: result.active, nearby: result.nearby };
      }
      return json(res, { ok: result.ok, ...state.wifi, error: result.error || null });
    } finally {
      state.wifi_inflight = false;
    }
  }

  // ── Exports ──
  if (req.method === 'GET' && url.pathname === '/api/export/devices.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="ark-devices.csv"' });
    return res.end(devicesCsv(store.listDevices()));
  }
  if (req.method === 'GET' && url.pathname === '/api/export/networks.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="ark-networks.csv"' });
    return res.end(networksCsv(store.listNetworks()));
  }
  if (req.method === 'GET' && url.pathname === '/api/export/snapshot.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="ark-snapshot.json"' });
    return res.end(JSON.stringify(fleetExport(store), null, 2));
  }
  const devExportMatch = url.pathname.match(/^\/api\/export\/device\/([^/]+)\.json$/);
  if (req.method === 'GET' && devExportMatch) {
    const id = decodeURIComponent(devExportMatch[1]);
    const exp = deviceExport(store, id);
    if (!exp) return json(res, { ok: false, error: 'device not found' }, 404);
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="ark-device-${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json"` });
    return res.end(JSON.stringify(exp, null, 2));
  }

  // ── Imports ──
  if (req.method === 'POST' && url.pathname === '/api/import/snapshot') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const snap = JSON.parse(body);
        const result = importSnapshot(store, snap);
        return json(res, { ok: true, ...result });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── Default help page ──
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8">
<title>Ark Hub</title>
<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;max-width:680px;margin:40px auto;color:#dde;background:#0a0a0a;padding:0 16px}h1{color:#06b6d4}h2{color:#7dd3fc;font-size:14px;margin-top:24px}code{background:#1a1a22;padding:2px 6px;border-radius:3px}a{color:#22d3ee}</style>
<h1>Ark Hub v${VERSION}</h1>
<p>${state.devices.length} live device(s) · scan #${state.scan_count} · ${state.scanned_at || 'first-scan-pending'}</p>
<p>Persistent store: <code>${store.path}</code></p>
<p>Vault: <code>${vault.keyFingerprint()}</code> · ${vault.list().length} entries</p>
<h2>Discovery</h2><ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/devices">/api/devices</a></li>
  <li><a href="/api/networks">/api/networks</a></li>
  <li><a href="/api/wifi">/api/wifi</a></li>
</ul>
<h2>Fleet</h2><ul>
  <li><a href="/api/health/fleet">/api/health/fleet</a></li>
  <li><a href="/api/drift">/api/drift</a></li>
  <li>/api/devices/&lt;id&gt;/health</li>
  <li>/api/devices/&lt;id&gt;/drift</li>
</ul>
<h2>Export</h2><ul>
  <li><a href="/api/export/devices.csv">/api/export/devices.csv</a></li>
  <li><a href="/api/export/networks.csv">/api/export/networks.csv</a></li>
  <li><a href="/api/export/snapshot.json">/api/export/snapshot.json</a></li>
  <li>/api/export/device/&lt;device_id&gt;.json</li>
</ul>
<h2>Vault</h2><ul>
  <li><a href="/api/vault/list">/api/vault/list</a> (refs + labels; never values)</li>
  <li>POST /api/vault/set · DELETE /api/vault/&lt;ref&gt;</li>
</ul>
<h2>Agent (OTA)</h2><ul>
  <li><a href="/api/agent/latest">/api/agent/latest</a></li>
  <li><a href="/api/agent/download">/api/agent/download</a></li>
  <li>POST /api/agent/report</li>
</ul>
<h2>Ingest</h2><ul>
  <li>POST /api/import/snapshot · POST /api/manifests/register</li>
  <li>POST /api/scan · POST /api/wifi/refresh</li>
</ul>`);
  }

  return json(res, { ok: false, error: 'Not found' }, 404);
});

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[hub] listening on http://localhost:${PORT}`);

  // Order matters: run the Wi-Fi scan BEFORE the first device scan so
  // detectCurrentNetwork can classify correctly from the very first
  // tick. Otherwise the first tick lays down a stale "ethernet" row
  // before Wi-Fi data is known, which then persists in SQLite.
  state.wifi_inflight = true;
  try {
    console.log('[hub] initial Wi-Fi scan…');
    const result = await wifiScan({ timeoutMs: 12000 });
    if (result.ok) {
      state.wifi = { scanned_at: result.scanned_at, active: result.active, nearby: result.nearby };
      console.log(`[hub] Wi-Fi: ${result.active ? '(' + (result.active.ssid || '<redacted>') + ')' : 'none active'} · ${result.nearby.length} nearby`);
    } else {
      console.log('[hub] Wi-Fi scan returned not-OK; proceeding without SSID');
    }
  } catch (e) {
    console.error('[hub] initial wifi scan failed:', e.message, '— continuing without it');
  } finally {
    state.wifi_inflight = false;
  }

  console.log(`[hub] scanning every ${SCAN_INTERVAL_MS}ms — first pass running now…`);
  await runScan();
  console.log(`[hub] first scan complete: ${state.devices.length} devices`);

  setInterval(runScan, SCAN_INTERVAL_MS);
  // hourly prune to keep DB bounded
  setInterval(() => { try { store.prune(); } catch {} }, 3600 * 1000);
});

process.on('SIGINT',  () => { console.log('\n[hub] shutting down'); store.close(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { store.close(); server.close(() => process.exit(0)); });
