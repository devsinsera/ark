#!/usr/bin/env node
// Ark Hub — LAN discovery + agent collector. Runs on the LAN
// (typically the user's Mac during development; a Pi or NAS in
// production). Exposes a small REST API the browser UI polls.
//
// Phase 4.3: now persists to SQLite at ~/.ark/ark-hub.db.
// Phase 4.7: exposes /api/export/* and /api/import/* endpoints.

import { createServer } from 'node:http';
import { arpScan, mdnsBrowse, mergeSources, wifiScan, detectCurrentNetwork } from './scan.mjs';
import { openStore } from './store.mjs';
import { devicesCsv, networksCsv, deviceExport, fleetExport, importSnapshot } from './export.mjs';

const PORT = Number(process.env.ARK_HUB_PORT || 7400);
const SCAN_INTERVAL_MS = Number(process.env.ARK_HUB_SCAN_INTERVAL_MS || 5000);
const VERSION = '0.2.0';

// Persistent store (SQLite). Opens — and creates the file if it
// doesn't exist — at construction time. Fatal if we can't reach it.
const store = openStore();
console.log(`[hub] persistent store: ${store.path}`);

// In-memory state (live scan view; the DB is the long-term record).
const state = {
  scanned_at: null,
  devices: [],
  current_network: null,
  agents: new Map(),
  scan_count: 0,
  wifi: { scanned_at: null, active: null, nearby: [] },
  wifi_inflight: false,
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
    req.on('end', () => {
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
          trust_state: 'trusted',
        });
        store.recordTelemetry(deviceId, r);

        return json(res, { ok: true, device_name: r.device_name, device_id: deviceId });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
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
<h2>Discovery</h2><ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/devices">/api/devices</a></li>
  <li><a href="/api/networks">/api/networks</a></li>
  <li><a href="/api/wifi">/api/wifi</a></li>
</ul>
<h2>Export</h2><ul>
  <li><a href="/api/export/devices.csv">/api/export/devices.csv</a></li>
  <li><a href="/api/export/networks.csv">/api/export/networks.csv</a></li>
  <li><a href="/api/export/snapshot.json">/api/export/snapshot.json</a></li>
  <li>/api/export/device/&lt;device_id&gt;.json</li>
</ul>
<h2>Ingest</h2><ul>
  <li>POST /api/agent/report</li>
  <li>POST /api/import/snapshot</li>
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
