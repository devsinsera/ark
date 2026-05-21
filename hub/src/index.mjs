#!/usr/bin/env node
// Ark Hub — LAN discovery + agent collector. Runs on the LAN
// (typically the user's Mac during development; a Pi or NAS in
// production). Exposes a small REST API the browser UI polls.
//
// Pure stdlib — no npm deps so it can be `npm run hub` and just work.
// Browser fetches http://localhost:7400/api/devices.

import { createServer } from 'node:http';
import { arpScan, mdnsBrowse, mergeSources } from './scan.mjs';

const PORT = Number(process.env.ARK_HUB_PORT || 7400);
const SCAN_INTERVAL_MS = Number(process.env.ARK_HUB_SCAN_INTERVAL_MS || 5000);
const VERSION = '0.1.0';

// In-memory state. Phase 1 has no persistence — server restart = clean state.
const state = {
  scanned_at: null,
  devices: [],
  agents: new Map(),   // device_id -> last agent report
  scan_count: 0,
};

async function runScan() {
  try {
    const [arp, mdns] = await Promise.all([
      arpScan(),
      mdnsBrowse({ timeoutMs: 4000 }),
    ]);
    const agents = [...state.agents.values()];
    state.devices = mergeSources({ arp, mdns, agents });
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

  // GET /api/health — liveness probe
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, {
      ok: true,
      version: VERSION,
      uptime_s: process.uptime(),
      scan_count: state.scan_count,
      last_scan: state.scanned_at,
      port: PORT,
    });
  }

  // GET /api/devices — current device list
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    return json(res, {
      scanned_at: state.scanned_at,
      hub_version: VERSION,
      device_count: state.devices.length,
      devices: state.devices,
    });
  }

  // POST /api/agent/report — agent on a Pi telling us about itself
  if (req.method === 'POST' && url.pathname === '/api/agent/report') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        if (!r.device_name) throw new Error('device_name required');
        // We never store auth tokens / passwords. Strip anything that
        // looks like one before persisting.
        delete r.password;
        delete r.token;
        delete r.ssh_token;
        r.last_seen = new Date().toISOString();
        r.sources = ['agent'];
        state.agents.set(r.device_name, r);
        return json(res, { ok: true, device_name: r.device_name });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // POST /api/devices/:id/action — manual actions (assign manifest, etc.)
  if (req.method === 'POST' && /^\/api\/devices\/[^/]+\/action$/.test(url.pathname)) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        // Phase 1 just acknowledges — no SSH reboot, no exec.
        return json(res, { ok: true, accepted: r, note: 'Phase 1 stub — no execution yet.' });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // POST /api/scan — trigger an immediate scan
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    await runScan();
    return json(res, { ok: true, scanned_at: state.scanned_at, device_count: state.devices.length });
  }

  // Default: tiny help page
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8">
<title>Ark Hub</title>
<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;max-width:660px;margin:40px auto;color:#dde;background:#0a0a0a;padding:0 16px}h1{color:#06b6d4}code{background:#1a1a22;padding:2px 6px;border-radius:3px}a{color:#22d3ee}</style>
<h1>Ark Hub v${VERSION}</h1>
<p>Running on port <code>${PORT}</code>. ${state.devices.length} device(s) on the LAN as of ${state.scanned_at || 'first-scan-pending'}.</p>
<ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/devices">/api/devices</a></li>
  <li>POST <code>/api/agent/report</code> — agents call this</li>
  <li>POST <code>/api/scan</code> — trigger immediate scan</li>
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
  console.log(`[hub] scanning every ${SCAN_INTERVAL_MS}ms — first pass running now…`);
  await runScan();
  console.log(`[hub] first scan complete: ${state.devices.length} devices`);
  setInterval(runScan, SCAN_INTERVAL_MS);
});

process.on('SIGINT',  () => { console.log('\n[hub] shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
