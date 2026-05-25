#!/usr/bin/env node
// Ark Hub — LAN discovery + agent collector. Runs on the LAN
// (typically the user's Mac during development; a Pi or NAS in
// production). Exposes a small REST API the browser UI polls.
//
// Phase 4.3: now persists to SQLite at ~/.ark/ark-hub.db.
// Phase 4.7: exposes /api/export/* and /api/import/* endpoints.

import { createServer } from 'node:http';
import { readFile, stat, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { arpScan, mdnsBrowse, mergeSources, wifiScan, detectCurrentNetwork } from './scan.mjs';
import { openStore } from './store.mjs';
import { openVault } from './vault.mjs';
import { initDrift, detectConfigDrift, detectNetworkDrift, recordDriftEvents, listDrift, resolveDrift } from './drift.mjs';
import { computeHealth } from './health.mjs';
import { devicesCsv, networksCsv, deviceExport, fleetExport, importSnapshot } from './export.mjs';
import { listBuilds, getBuild, deleteBuild, listImages, tailFile, hubLogPath, buildLogPath } from './inventory.mjs';
import { runEngine, listProfiles, stageZipFromRequest, safeBuildName } from './installer.mjs';
import { initFlash, JOB_STATES, NODE_CAPABILITIES } from './flash.mjs';
import { initSecurity, ALERT_KINDS, HARDENING_CHECKS, classifyCheckOutput } from './security.mjs';
import { initRunner } from './runner.mjs';
import { initScheduler } from './scheduler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PORT = Number(process.env.ARK_HUB_PORT || 7400);
const SCAN_INTERVAL_MS = Number(process.env.ARK_HUB_SCAN_INTERVAL_MS || 5000);
const VERSION = '0.3.1';
const AGENT_FILE = path.join(REPO_ROOT, 'agent', 'ark-agent.py');
// Content-addressable image store for Flash Node uploads. Files
// named by their sha256 → automatic dedup of re-uploads.
const FLASH_IMAGE_DIR = path.join(homedir(), '.ark', 'flash-images');
await mkdir(FLASH_IMAGE_DIR, { recursive: true });
// Staging area for browser → Hub uploads that get scp'd onward to a
// managed host. Files here are short-lived (deleted after the scp
// finishes, success or failure).
const PUSH_STAGING_DIR = path.join(homedir(), '.ark', 'push-staging');
await mkdir(PUSH_STAGING_DIR, { recursive: true });
// Bind host: 127.0.0.1 by default (localhost-only). Set
// ARK_HUB_BIND_HOST=0.0.0.0 to expose to the LAN — required when
// the browser running the Ark UI is on a DIFFERENT machine from the
// one running the Hub. Anyone on the LAN can then reach the Hub,
// so only enable this on networks you trust.
const BIND_HOST = process.env.ARK_HUB_BIND_HOST || '127.0.0.1';

// Persistent store (SQLite). Opens — and creates the file if it
// doesn't exist — at construction time. Fatal if we can't reach it.
const store = openStore();
console.log(`[hub] persistent store: ${store.path}`);

// Encrypted credential vault — Phase 5.1. Shares the same SQLite DB.
const vault = openVault(store.db);
console.log(`[hub] vault ready (key fingerprint ${vault.keyFingerprint()})`);

// Drift event table — Phase 4.5 / Phase 5.2 multi-network drift.
initDrift(store.db);

// Flash Node subsystem — nodes, image registry, job queue.
const flash = initFlash(store.db);

// Can't Phish Here — defensive security module.
const security = initSecurity(store.db);

// SSH Runner — operator-managed hosts + remote command execution.
const runner = initRunner(store.db);

// Hardening scheduler — Phase 7.6. Runs operator-declared checks
// against operator-declared hosts on an interval, recording findings.
const scheduler = initScheduler(store.db, { runner, security });

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

    const previousDevices = state.devices;
    state.devices = merged;
    state.scanned_at = new Date().toISOString();
    state.scan_count++;

    // Can't Phish Here — defensive detection on each scan tick.
    // Pass previousDevices so MAC-change detection has something to
    // compare against.
    try {
      security.detect({ currentDevices: merged, previousDevices, store });
    } catch (e) {
      console.error('[hub] cph detect error:', e.message);
    }
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

        // CPH passive-monitor alerts come in via the regular agent
        // report path with a 'cph_alert' field. Raise into the alert
        // engine immediately so they surface in the UI without
        // waiting for the next scan tick.
        if (r.cph_alert && r.cph_alert.kind && r.cph_alert.subject) {
          try {
            security.raiseAlert({
              kind:     r.cph_alert.kind,
              severity: r.cph_alert.severity || 'warn',
              device_id: r.mac || r.device_name,
              subject:  r.cph_alert.subject,
              detail:   r.cph_alert.detail || {},
            });
          } catch (e) {
            console.error('[hub] cph_alert from agent rejected:', e.message);
          }
        }

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

  // ── Can't Phish Here — defensive security module ────────────────
  if (req.method === 'GET' && url.pathname === '/api/cph/overview') {
    return json(res, {
      alerts:   security.countAlerts(),
      approved: security.listApproved().length,
      checks:   HARDENING_CHECKS.length,
      last_scan: state.scanned_at,
      device_count: state.devices.length,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/alerts') {
    return json(res, {
      alerts: security.listAlerts({
        severity: url.searchParams.get('severity') || undefined,
        kind:     url.searchParams.get('kind')     || undefined,
        includeResolved: url.searchParams.get('include_resolved') === '1',
        limit:    Number(url.searchParams.get('limit') || 200),
      }),
    });
  }
  const cphAckMatch = url.pathname.match(/^\/api\/cph\/alerts\/(\d+)\/ack$/);
  if (req.method === 'POST' && cphAckMatch) {
    return json(res, { ok: security.ackAlert(Number(cphAckMatch[1])) });
  }
  const cphResolveMatch = url.pathname.match(/^\/api\/cph\/alerts\/(\d+)\/resolve$/);
  if (req.method === 'POST' && cphResolveMatch) {
    return json(res, { ok: security.resolveAlert(Number(cphResolveMatch[1])) });
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/approved') {
    return json(res, { hosts: security.listApproved() });
  }
  if (req.method === 'POST' && url.pathname === '/api/cph/approved') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { return json(res, { ok: true, host: security.approveHost(JSON.parse(body)) }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const cphRevokeMatch = url.pathname.match(/^\/api\/cph\/approved\/(\d+)$/);
  if (req.method === 'DELETE' && cphRevokeMatch) {
    return json(res, { ok: security.revokeApproval(Number(cphRevokeMatch[1])) });
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/checks') {
    return json(res, { checks: HARDENING_CHECKS });
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/findings') {
    const target = url.searchParams.get('target') || undefined;
    return json(res, { findings: security.listFindings(target) });
  }
  if (req.method === 'POST' && url.pathname === '/api/cph/findings') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { return json(res, { ok: true, ...security.recordFinding(JSON.parse(body)) }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/constants') {
    return json(res, { alert_kinds: ALERT_KINDS, hardening_checks: HARDENING_CHECKS.map(c => c.id) });
  }
  if (req.method === 'GET' && url.pathname === '/api/cph/webhooks') {
    return json(res, { webhooks: security.listWebhooks() });
  }
  if (req.method === 'POST' && url.pathname === '/api/cph/webhooks') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { return json(res, { ok: true, ...security.addWebhook(JSON.parse(body)) }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const cphWebhookMatch = url.pathname.match(/^\/api\/cph\/webhooks\/(\d+)$/);
  if (req.method === 'DELETE' && cphWebhookMatch) {
    return json(res, { ok: security.deleteWebhook(Number(cphWebhookMatch[1])) });
  }
  const cphWebhookToggle = url.pathname.match(/^\/api\/cph\/webhooks\/(\d+)\/toggle$/);
  if (req.method === 'POST' && cphWebhookToggle) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body || '{}');
        return json(res, { ok: security.toggleWebhook(Number(cphWebhookToggle[1]), !!r.enabled) });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }

  // ── SSH Runner — managed hosts + remote exec ─────────────────────
  if (req.method === 'GET' && url.pathname === '/api/runner/hosts') {
    return json(res, { hosts: runner.listHosts() });
  }
  if (req.method === 'POST' && url.pathname === '/api/runner/hosts') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { return json(res, { ok: true, ...runner.addHost(JSON.parse(body)) }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const runnerHostMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)$/);
  if (req.method === 'DELETE' && runnerHostMatch) {
    return json(res, { ok: runner.deleteHost(Number(runnerHostMatch[1])) });
  }
  const runnerTestMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)\/test$/);
  if (req.method === 'POST' && runnerTestMatch) {
    try { return json(res, await runner.test(Number(runnerTestMatch[1]))); }
    catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    return;
  }
  const runnerExecMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)\/exec$/);
  if (req.method === 'POST' && runnerExecMatch) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { command, reason, timeoutMs } = JSON.parse(body);
        const r = await runner.exec(Number(runnerExecMatch[1]), command, { reason, timeoutMs });
        return json(res, r);
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const runnerLogMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)\/log$/);
  if (req.method === 'GET' && runnerLogMatch) {
    return json(res, { log: runner.listLog(Number(runnerLogMatch[1]), 50) });
  }
  // POST /api/runner/hosts/<id>/push — accepts raw bytes in the body,
  // stages them under ~/.ark/push-staging, then scp's the file to the
  // host at ?path=<remote_path>. Filename for the staging file comes
  // from ?filename=<name> (cosmetic; the remote path is what matters).
  // The remote path may be either a full file path or a directory
  // (trailing /), in which case the filename is appended. Temp file
  // is unlinked whether the scp succeeds or fails.
  const runnerPushMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)\/push$/);
  if (req.method === 'POST' && runnerPushMatch) {
    const hostId   = Number(runnerPushMatch[1]);
    const filename = url.searchParams.get('filename') || 'upload.bin';
    const wantPath = url.searchParams.get('path') || '';
    if (!wantPath)           return json(res, { ok: false, error: 'path query param required' }, 400);
    if (!/^[A-Za-z0-9._\-]+$/.test(filename)) return json(res, { ok: false, error: 'filename: only [A-Za-z0-9._-] allowed' }, 400);
    if (!runner.getHost(hostId)) return json(res, { ok: false, error: 'unknown host_id' }, 404);
    const remotePath = wantPath.endsWith('/') ? wantPath + filename : wantPath;
    const stagePath = path.join(PUSH_STAGING_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`);
    let size = 0;
    const out = createWriteStream(stagePath);
    req.on('data', (chunk) => { size += chunk.length; out.write(chunk); });
    req.on('end', () => {
      out.end(async () => {
        try {
          const pushed = await runner.pushFile(hostId, stagePath, remotePath);
          return json(res, {
            ok:          pushed.ok,
            exit_code:   pushed.exit_code,
            stderr:      pushed.stderr,
            duration_ms: pushed.duration_ms,
            remote_path: remotePath,
            size_bytes:  size,
          });
        } catch (e) {
          return json(res, { ok: false, error: e.message }, 500);
        } finally {
          try { await unlink(stagePath); } catch {}
        }
      });
    });
    req.on('error', async (e) => {
      try { await unlink(stagePath); } catch {}
      return json(res, { ok: false, error: e.message }, 400);
    });
    return;
  }
  // GET /api/runner/log?reason=raspyjack&limit=20  — all-host log
  // filtered by reason tag. Backs the RaspyJack tab's run-history
  // sidebar in Can't Phish Here.
  if (req.method === 'GET' && url.pathname === '/api/runner/log') {
    const reason = url.searchParams.get('reason');
    const limit  = url.searchParams.get('limit');
    if (!reason) return json(res, { ok: false, error: 'reason query param required' }, 400);
    return json(res, { log: runner.listLogByReason(reason, limit) });
  }
  // POST /api/runner/hosts/<id>/exec/stream — same body as /exec but
  // returns NDJSON streamed line-by-line:
  //   {"event":"start","host":{...}}
  //   {"event":"chunk","stream":"stdout","data":"..."}
  //   {"event":"chunk","stream":"stderr","data":"..."}
  //   ...
  //   {"event":"end","ok":true,"exit_code":0,"duration_ms":1234}
  const runnerExecStreamMatch = url.pathname.match(/^\/api\/runner\/hosts\/(\d+)\/exec\/stream$/);
  if (req.method === 'POST' && runnerExecStreamMatch) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      const hostId = Number(runnerExecStreamMatch[1]);
      try {
        const { command, reason, timeoutMs } = JSON.parse(body);
        const host = runner.getHost(hostId);
        if (!host) { return json(res, { ok: false, error: 'unknown host' }, 404); }
        res.writeHead(200, {
          'content-type':  'application/x-ndjson',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        });
        const send = (obj) => {
          try { res.write(JSON.stringify(obj) + '\n'); } catch {}
        };
        send({ event: 'start', host: { id: host.id, label: host.label, ssh_target: host.ssh_target } });
        const r = await runner.execStream(hostId, command, {
          reason: reason || 'manual',
          timeoutMs: timeoutMs || 60000,
          onChunk: (c) => send({ event: 'chunk', ...c }),
        });
        send({ event: 'end', ok: r.ok, exit_code: r.exit_code, duration_ms: r.duration_ms });
        res.end();
      } catch (e) {
        try {
          if (!res.headersSent) return json(res, { ok: false, error: e.message }, 400);
          res.write(JSON.stringify({ event: 'end', ok: false, error: e.message }) + '\n');
          res.end();
        } catch {}
      }
    });
    return;
  }

  // CPH scheduled checks — Phase 7.6
  if (req.method === 'GET' && url.pathname === '/api/cph/scheduled') {
    return json(res, { schedules: scheduler.list() });
  }
  if (req.method === 'POST' && url.pathname === '/api/cph/scheduled') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { return json(res, { ok: true, ...scheduler.add(JSON.parse(body)) }); }
      catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const schedDel = url.pathname.match(/^\/api\/cph\/scheduled\/(\d+)$/);
  if (req.method === 'DELETE' && schedDel) {
    return json(res, { ok: scheduler.delete(Number(schedDel[1])) });
  }
  const schedToggle = url.pathname.match(/^\/api\/cph\/scheduled\/(\d+)\/toggle$/);
  if (req.method === 'POST' && schedToggle) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body || '{}');
        return json(res, { ok: scheduler.toggle(Number(schedToggle[1]), !!r.enabled) });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }

  // Online-Pi update — Phase 8. scp the install.plan.sh to a managed
  // host and execute it. Doesn't re-flash; mutates the running OS.
  if (req.method === 'POST' && url.pathname === '/api/runner/online-update') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { host_id, build_name } = JSON.parse(body);
        if (!host_id || !build_name) throw new Error('host_id and build_name required');
        const planPath = path.join(REPO_ROOT, 'builds', build_name, 'install.plan.sh');
        if (!existsSync(planPath)) throw new Error(`install.plan.sh not found for build: ${build_name}`);
        const remoteTmp = `/tmp/ark-online-update-${Date.now()}.sh`;
        const pushed = await runner.pushFile(host_id, planPath, remoteTmp);
        if (!pushed.ok) return json(res, { ok: false, step: 'scp', ...pushed }, 500);
        const ran = await runner.exec(host_id, `chmod +x ${remoteTmp} && sudo bash ${remoteTmp} && rm -f ${remoteTmp}`, {
          reason: 'online-update', timeoutMs: 600000,
        });
        return json(res, { ok: ran.ok, step: 'exec', ...ran });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // CPH hardening check — run a single check against a managed host
  // via the SSH runner; classify result; record a finding.
  if (req.method === 'POST' && url.pathname === '/api/cph/hardening/run') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { host_id, check_id } = JSON.parse(body);
        const check = HARDENING_CHECKS.find(c => c.id === check_id);
        if (!check)         return json(res, { ok: false, error: `unknown check_id: ${check_id}` }, 400);
        if (!check.probe)   return json(res, { ok: false, error: `check has no automated probe: ${check_id}` }, 400);
        const host = runner.getHost(host_id);
        if (!host)          return json(res, { ok: false, error: 'host not found' }, 404);

        const exec = await runner.exec(host_id, check.probe, { reason: 'hardening' });
        const passOrFail = classifyCheckOutput(check, exec.stdout);
        const ok = passOrFail === true;
        security.recordFinding({
          target_label:   host.label,
          check_id:       check.id,
          ok,
          severity:       check.severity,
          observation:    (exec.stdout || '').trim().slice(0, 500),
          recommendation: ok ? null : check.how_to_fix,
        });
        return json(res, { ok: true, check_id, passed: ok, observation: (exec.stdout || '').trim().slice(0, 500), exec });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // ── Flash Node subsystem ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/flash/nodes/register') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const reg = JSON.parse(body);
        const node = flash.registerNode(reg);
        return json(res, { ok: true, node });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/flash/nodes') {
    return json(res, { nodes: flash.listNodes() });
  }
  const flashNodeHeartbeat = url.pathname.match(/^\/api\/flash\/nodes\/([^/]+)\/heartbeat$/);
  if (req.method === 'POST' && flashNodeHeartbeat) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const r = JSON.parse(body || '{}');
        const ok = flash.heartbeatNode(decodeURIComponent(flashNodeHeartbeat[1]), r.status);
        return json(res, { ok });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/flash/images') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const img = flash.registerImage(JSON.parse(body));
        return json(res, { ok: true, image: img });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // ── Local Mac flash — write an image to an SD card attached to
  // this Mac directly. macOS-only; uses osascript with administrator
  // privileges so the user gets a single auth prompt (same UX as
  // Raspberry Pi Imager).
  if (req.method === 'GET' && url.pathname === '/api/local/disks') {
    return listLocalDisks()
      .then(disks => json(res, { disks }))
      .catch(e => json(res, { ok: false, error: e.message, disks: [] }, 500));
  }
  if (req.method === 'POST' && url.pathname === '/api/local/flash') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { image_id, target } = JSON.parse(body);
        const img = flash.getImage(image_id);
        if (!img) return json(res, { ok: false, error: 'image not found' }, 404);
        if (!img.source_path || !existsSync(img.source_path)) return json(res, { ok: false, error: 'image file missing on disk' }, 404);
        // Target safety: must be /dev/diskN where N >= 1 (boot disk = disk0)
        if (!/^\/dev\/disk[1-9][0-9]*$/.test(target)) return json(res, { ok: false, error: `invalid target: ${target}` }, 400);
        // Verify target is in the external-disks list (defensive double-check)
        const externalDisks = await listLocalDisks();
        if (!externalDisks.some(d => d.device === target)) {
          return json(res, { ok: false, error: `target ${target} not in external-disks list — refusing` }, 400);
        }
        const result = await runLocalFlash(img.source_path, target);
        return json(res, result);
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // POST /api/flash/images/rescan — walk builds/*/out/ and register
  // any new .img.xz / .img files into the flash registry. Idempotent;
  // skip-if-unchanged-size so re-running is cheap. Called automatically
  // on Hub startup and on demand from the UI.
  if (req.method === 'POST' && url.pathname === '/api/flash/images/rescan') {
    flash.rescanBuildOutputs()
      .then(stats => json(res, { ok: true, ...stats }))
      .catch(e => json(res, { ok: false, error: e.message }, 500));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/flash/images') {
    return json(res, { images: flash.listImages() });
  }
  if (req.method === 'POST' && url.pathname === '/api/flash/jobs') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const job = flash.enqueueJob(JSON.parse(body));
        return json(res, { ok: true, job });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/flash/jobs') {
    return json(res, {
      jobs: flash.listJobs({
        nodeId: url.searchParams.get('node_id') || undefined,
        state:  url.searchParams.get('state')   || undefined,
        limit:  Number(url.searchParams.get('limit') || 50),
      }),
    });
  }
  const flashJobMatch = url.pathname.match(/^\/api\/flash\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && flashJobMatch) {
    const j = flash.getJob(decodeURIComponent(flashJobMatch[1]));
    if (!j) return json(res, { ok: false, error: 'job not found' }, 404);
    return json(res, j);
  }
  const flashJobUpdate = url.pathname.match(/^\/api\/flash\/jobs\/([^/]+)\/update$/);
  if (req.method === 'POST' && flashJobUpdate) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const updated = flash.updateJob(decodeURIComponent(flashJobUpdate[1]), JSON.parse(body));
        return json(res, { ok: true, job: updated });
      } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  const flashJobCancel = url.pathname.match(/^\/api\/flash\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && flashJobCancel) {
    const ok = flash.cancelJob(decodeURIComponent(flashJobCancel[1]));
    return json(res, { ok });
  }
  if (req.method === 'GET' && url.pathname === '/api/flash/constants') {
    return json(res, { job_states: JOB_STATES, node_capabilities: NODE_CAPABILITIES });
  }

  // Image delete — hard-removes from registry + optionally the file.
  // Refuses when an in-flight job references the image.
  const flashImgDelete = url.pathname.match(/^\/api\/flash\/images\/([^/]+)$/);
  if (req.method === 'DELETE' && flashImgDelete) {
    try {
      const id = decodeURIComponent(flashImgDelete[1]);
      const result = flash.deleteImage(id);
      if (!result) return json(res, { ok: false, error: 'image not found' }, 404);
      // Best-effort remove the file on disk too
      if (result.source_path && existsSync(result.source_path) && result.source_path.startsWith(FLASH_IMAGE_DIR)) {
        try { await unlink(result.source_path); } catch {}
      }
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 409);
    }
  }

  // Node delete — removes from registry. Refuses if jobs are in flight.
  const flashNodeDelete = url.pathname.match(/^\/api\/flash\/nodes\/([^/]+)$/);
  if (req.method === 'DELETE' && flashNodeDelete) {
    try {
      const id = decodeURIComponent(flashNodeDelete[1]);
      const ok = flash.deleteNode(id);
      return json(res, { ok });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 409);
    }
  }

  // Image upload — accepts raw bytes. Filename via ?filename= query
  // param (cosmetic only; stored content-addressable by sha256).
  if (req.method === 'POST' && url.pathname === '/api/flash/images/upload') {
    const filename = url.searchParams.get('filename') || 'upload.img';
    const tmpPath = path.join(FLASH_IMAGE_DIR, '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const hash = createHash('sha256');
    let size = 0;
    const file = createWriteStream(tmpPath);
    req.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
      file.write(chunk);
    });
    req.on('end', async () => {
      file.end(async () => {
        try {
          const sha256 = hash.digest('hex');
          const finalPath = path.join(FLASH_IMAGE_DIR, sha256 + '.img');
          if (existsSync(finalPath)) {
            await unlink(tmpPath);  // dedup
          } else {
            await rename(tmpPath, finalPath);
          }
          const img = flash.registerImage({
            source_path: finalPath,
            size_bytes:  size,
            sha256,
            compression: filename.endsWith('.xz') ? 'xz' : 'none',
            build_name:  filename,
          });
          return json(res, { ok: true, image: img });
        } catch (e) {
          try { await unlink(tmpPath); } catch {}
          return json(res, { ok: false, error: e.message }, 500);
        }
      });
    });
    req.on('error', async (e) => {
      try { await unlink(tmpPath); } catch {}
      return json(res, { ok: false, error: e.message }, 400);
    });
    return;
  }

  // Image download — streams the bytes the Flash Agent fetches
  // when running a job. URL handed to the Agent by the dispatcher.
  const flashImgDownloadMatch = url.pathname.match(/^\/api\/flash\/images\/([^/]+)\/download$/);
  if (req.method === 'GET' && flashImgDownloadMatch) {
    const id = decodeURIComponent(flashImgDownloadMatch[1]);
    const img = flash.getImage(id);
    if (!img) return json(res, { ok: false, error: 'image not found' }, 404);
    if (!existsSync(img.source_path)) return json(res, { ok: false, error: 'image bytes missing' }, 404);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': img.size_bytes,
      'content-disposition': `attachment; filename="${path.basename(img.source_path)}"`,
    });
    createReadStream(img.source_path).pipe(res);
    return;
  }

  // ── Installer engine — browser surface for what was CLI-only ──
  if (req.method === 'GET' && url.pathname === '/api/installer/profiles') {
    return json(res, { profiles: await listProfiles() });
  }
  // Upload a ZIP to stage. Returns the path the next call uses.
  if (req.method === 'POST' && url.pathname === '/api/installer/upload-zip') {
    const buildName = url.searchParams.get('build_name') || 'upload';
    try {
      const dest = await stageZipFromRequest(req, buildName);
      const size = await stat(dest).then(s => s.size);
      return json(res, { ok: true, path: dest, size_bytes: size });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 400);
    }
  }
  // Drive the full pipeline: ingest -> detect -> compile.
  if (req.method === 'POST' && url.pathname === '/api/installer/run') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const r = JSON.parse(body);
        const out = await runEngine({
          source:     r.source,
          buildName:  r.build_name,
          profileId:  r.profile_id || null,
          useVenv:    !!r.use_venv,
        });
        return json(res, { ok: true, ...out });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
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
  // Direct download of the build's compressed .img — bypasses the
  // flash image registry. Streams from builds/<name>/out/ark-built.img.xz
  // (falls back to .img if no xz is around).
  const buildDownloadMatch = url.pathname.match(/^\/api\/builds\/([^/]+)\/download$/);
  if (req.method === 'GET' && buildDownloadMatch) {
    const name = decodeURIComponent(buildDownloadMatch[1]);
    if (/[\/\\]|\.\./.test(name)) return json(res, { ok: false, error: 'invalid build name' }, 400);
    const xz  = path.join(REPO_ROOT, 'builds', name, 'out', 'ark-built.img.xz');
    const raw = path.join(REPO_ROOT, 'builds', name, 'out', 'ark-built.img');
    const file = existsSync(xz) ? xz : (existsSync(raw) ? raw : null);
    if (!file) return json(res, { ok: false, error: 'no built image found' }, 404);
    const st = statSync(file);
    res.writeHead(200, {
      'content-type':        file.endsWith('.xz') ? 'application/x-xz' : 'application/octet-stream',
      'content-length':      st.size,
      'content-disposition': `attachment; filename="${name}${file.endsWith('.xz') ? '.img.xz' : '.img'}"`,
    });
    const stream = createReadStream(file);
    stream.pipe(res);
    return;
  }
  if (req.method === 'DELETE' && buildMatch) {
    try {
      const r = await deleteBuild(decodeURIComponent(buildMatch[1]));
      return json(res, r, r.ok ? 200 : 404);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 400);
    }
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

// Flash Node dispatcher — periodically pushes queued jobs to their
// target Flash Agent. Per the spec's v2 plan: the Hub doesn't wait
// for the operator to call the Agent directly anymore. Fire-and-
// forget; the Agent ACKs by transitioning the job's state via
// /api/flash/jobs/<id>/update.
async function dispatchQueuedFlashJobs() {
  const queued = flash.listJobs({ state: 'queued', limit: 20 });
  for (const job of queued) {
    const node = flash.getNode(job.node_id);
    if (!node) continue;
    if (node.status === 'offline') continue;
    if (!node.agent_url) continue;
    const image = flash.getImage(job.image_id);
    if (!image) {
      flash.updateJob(job.job_id, { state: 'failed', error: `image not found: ${job.image_id}`, completed_at: new Date().toISOString() });
      continue;
    }
    // Mark dispatched so we don't re-fire next tick
    flash.updateJob(job.job_id, { state: 'preparing', started_at: new Date().toISOString() });
    const payload = {
      hub_job_id:       job.job_id,
      sha256:           image.sha256,
      target_disk_path: job.target_disk_path,
      // Prefer image_url so the Agent fetches from the Hub. Otherwise
      // hand it a path the Agent can read locally.
      image_url:        `http://${getOwnHostHint()}:${PORT}/api/flash/images/${encodeURIComponent(image.image_id)}/download`,
      allow_root_override: false,
    };
    try {
      const r = await fetch(node.agent_url.replace(/\/+$/, '') + '/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`agent returned ${r.status}`);
    } catch (e) {
      flash.updateJob(job.job_id, { state: 'failed', error: `dispatch failed: ${e.message}`, completed_at: new Date().toISOString() });
      console.error(`[hub] flash dispatch ${job.job_id} -> ${node.agent_url} failed:`, e.message);
    }
  }
}

function getOwnHostHint() {
  return process.env.ARK_HUB_PUBLIC_HOST || lanIpHint() || '127.0.0.1';
}

// ── Local Mac flash helpers ─────────────────────────────────────────
// Walk macOS's external + physical disks via diskutil. Parses the
// plist via the bundled python3 to avoid shipping a JS plist parser.
// Returns [{device:'/dev/diskN', size_bytes, content, name, removable}]
async function listLocalDisks() {
  if (process.platform !== 'darwin') return [];
  const plist = await new Promise((resolve, reject) => {
    execFile('diskutil', ['list', '-plist', 'external', 'physical'], (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
  // Parse via python3 (always present on macOS)
  const py = `
import plistlib, sys, json
d = plistlib.loads(sys.stdin.read().encode())
out = []
for disk in d.get('AllDisksAndPartitions', []):
    parts = disk.get('Partitions', []) or []
    label = next((p.get('VolumeName') for p in parts if p.get('VolumeName')), None)
    out.append({
        'device': '/dev/' + disk.get('DeviceIdentifier', ''),
        'size_bytes': disk.get('Size', 0),
        'content': disk.get('Content', ''),
        'name': label,
        'removable': True,
    })
print(json.dumps(out))
`.trim();
  const jsonText = await new Promise((resolve, reject) => {
    const p = spawn('python3', ['-c', py]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || 'python3 exit ' + code)));
    p.stdin.end(plist);
  });
  return JSON.parse(jsonText);
}

// Flash <imagePath> onto <target> (e.g. /dev/disk4) via dd, with the
// admin auth prompt routed through osascript so the user sees the
// standard macOS "Ark wants to make changes" dialog. Image can be
// .img or .img.xz — xz is auto-decompressed on the fly.
//
// Synchronous: the HTTP request blocks until dd completes (typically
// 3-5 min). The UI must show a "flashing…" spinner for the duration.
async function runLocalFlash(imagePath, target) {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'local flash is macOS-only (diskutil + dd via osascript)' };
  }
  // Use rdiskN (raw character device) instead of diskN — order of
  // magnitude faster on macOS (no buffer cache).
  const rawTarget = target.replace(/^\/dev\/disk/, '/dev/rdisk');
  const isXz = imagePath.endsWith('.xz');
  // Build the shell command. xz piped into dd; unmount target first.
  // Don't include status=progress — older macOS dd doesn't support it
  // and there's no progress streaming here anyway (sync HTTP).
  const inner = isXz
    ? `/usr/bin/diskutil unmountDisk ${target}; /usr/bin/xz -dc ${shQuote(imagePath)} | /bin/dd of=${rawTarget} bs=4m`
    : `/usr/bin/diskutil unmountDisk ${target}; /bin/dd if=${shQuote(imagePath)} of=${rawTarget} bs=4m`;
  // osascript "do shell script" string-escapes via doubled backslashes
  // and escaped double quotes. Build a heredoc to avoid that escaping
  // nightmare — write the script to a tempfile and exec it.
  const scriptPath = `/tmp/ark-local-flash-${Date.now()}.sh`;
  await new Promise((resolve, reject) => {
    const w = createWriteStream(scriptPath, { mode: 0o755 });
    w.write('#!/bin/bash\nset -euo pipefail\n' + inner + '\n');
    w.end();
    w.on('finish', resolve);
    w.on('error', reject);
  });
  try {
    const ascript = `do shell script "/bin/bash ${scriptPath}" with administrator privileges`;
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      execFile('osascript', ['-e', ascript], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // osascript exits non-zero if the user cancelled the auth prompt
          if ((stderr || '').includes('-128')) return reject(new Error('cancelled by user'));
          return reject(new Error(stderr || err.message));
        }
        resolve(stdout);
      });
    });
    const dur = Math.round((Date.now() - t0) / 1000);
    return { ok: true, duration_s: dur, target, raw_target: rawTarget };
  } finally {
    try { await unlink(scriptPath); } catch {}
  }
}

function shQuote(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

// Find this host's primary LAN IPv4. Best-effort — picks the first
// non-loopback IPv4 the kernel has bound. Used for both startup logs
// and the URL the Hub hands to Flash Agents so they can fetch images
// back from the Hub.
function lanIpHint() {
  try {
    const ifaces = require('node:os').networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
  } catch {}
  return null;
}

server.listen(PORT, BIND_HOST, async () => {
  if (BIND_HOST === '0.0.0.0') {
    const lan = lanIpHint();
    console.log(`[hub] listening on http://${lan || '0.0.0.0'}:${PORT} (LAN-reachable)`);
    console.log(`[hub] other devices on the LAN should set their Hub URL to: http://${lan || '<your-mac-LAN-IP>'}:${PORT}`);
  } else {
    console.log(`[hub] listening on http://127.0.0.1:${PORT} (localhost only)`);
    console.log(`[hub] to expose to the LAN: set ARK_HUB_BIND_HOST=0.0.0.0`);
  }

  // Auto-register any built images on startup so newly-baked images
  // appear in the Flash Images table without a manual register call.
  try {
    const stats = await flash.rescanBuildOutputs();
    if (stats.added + stats.updated > 0) {
      console.log(`[hub] flash image scan: +${stats.added} new, ${stats.updated} updated, ${stats.skipped} unchanged`);
    } else {
      console.log(`[hub] flash image scan: ${stats.scanned} build(s) checked, all already registered`);
    }
  } catch (e) {
    console.log(`[hub] flash image scan failed: ${e.message}`);
  }

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
  // Flash Node dispatcher — every 4 s, push any queued jobs to their
  // target Agent. No-op when nothing is queued.
  setInterval(() => { dispatchQueuedFlashJobs().catch(e => console.error('[hub] flash dispatcher:', e.message)); }, 4000);
  // Hardening cron — every 60s, run any scheduled checks that are
  // due. Per-check failures are isolated.
  setInterval(() => { scheduler.tick().catch(e => console.error('[hub] scheduler:', e.message)); }, 60 * 1000);
});

process.on('SIGINT',  () => { console.log('\n[hub] shutting down'); store.close(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { store.close(); server.close(() => process.exit(0)); });
