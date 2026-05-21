// Scanner — shells out to native tools to discover LAN devices.
// macOS-flavoured (uses `arp -a` + `dns-sd`); Linux equivalents are
// `ip neigh` / `arp -e` / `avahi-browse`. The hub is platform-aware.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { vendorForMac, isLikelyPi } from './oui.mjs';

const sh = promisify(exec);
const IS_MAC = platform() === 'darwin';

// ── ARP scan ────────────────────────────────────────────────────────
// macOS: `arp -a` prints lines like
//   ? (192.168.4.1) at 30:3a:4a:6e:a1:4d on en0 ifscope [ethernet]
// Linux: `ip neighbor` prints
//   192.168.4.1 dev wlan0 lladdr 30:3a:4a:6e:a1:4d REACHABLE
export async function arpScan() {
  let cmd;
  if (IS_MAC) cmd = 'arp -a';
  else        cmd = 'ip neighbor show';

  const { stdout } = await sh(cmd, { maxBuffer: 1024 * 1024 });
  const rows = [];
  const seen = new Set();

  if (IS_MAC) {
    for (const line of stdout.split('\n')) {
      const m = line.match(/\(([0-9.]+)\) at ([0-9a-f:]+)/i);
      if (!m) continue;
      if (m[2] === 'ff:ff:ff:ff:ff:ff') continue;     // broadcast
      if (m[2].includes('incomplete')) continue;
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mac = normaliseMac(m[2]);
      rows.push({
        ip: m[1],
        mac,
        vendor: vendorForMac(mac),
        likely_pi: isLikelyPi(mac),
        source: 'arp',
      });
    }
  } else {
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([0-9.]+) dev \S+ lladdr ([0-9a-f:]+)/i);
      if (!m) continue;
      const mac = normaliseMac(m[2]);
      rows.push({
        ip: m[1], mac, vendor: vendorForMac(mac),
        likely_pi: isLikelyPi(mac), source: 'arp',
      });
    }
  }
  return rows;
}

function normaliseMac(raw) {
  return raw.toLowerCase().split(/[-:]/)
    .map(p => p.length === 1 ? '0' + p : p).join(':');
}

// ── mDNS service browse ─────────────────────────────────────────────
// Best-effort: macOS has `dns-sd`, Linux has `avahi-browse`. Both
// blockingly wait for responses, so we cap with a SIGTERM timeout.
export async function mdnsBrowse({ timeoutMs = 5000 } = {}) {
  const services = new Set();
  const hosts = {};   // hostname -> { ip?, port?, txt? }

  // Service list we care about
  const wantServices = [
    '_arkagent._tcp',
    '_http._tcp',
    '_ssh._tcp',
    '_workstation._tcp',
    '_raop._tcp',           // AirPlay
    '_airplay._tcp',
    '_googlecast._tcp',     // Chromecast
    '_printer._tcp',
    '_ipp._tcp',
    '_smb._tcp',
  ];

  try {
    if (IS_MAC) {
      // dns-sd -B blocks; capture first ~timeoutMs of output then kill.
      for (const svc of wantServices) {
        try {
          const out = await runWithTimeout(`dns-sd -B ${svc} local.`, timeoutMs / wantServices.length);
          for (const line of out.split('\n')) {
            const m = line.match(/\s+Add\s+\d+\s+\d+\s+local\.\s+\S+\s+(.+)$/);
            if (m) {
              const name = m[1].trim();
              services.add(`${svc}|${name}`);
              hosts[name] = hosts[name] || { service: svc };
            }
          }
        } catch { /* keep going across services */ }
      }
    } else {
      // avahi-browse -art (terminate, return all, resolve) — single shot.
      try {
        const out = await runWithTimeout('avahi-browse -art', timeoutMs);
        for (const line of out.split('\n')) {
          // = field lines have IPv4 + port
          const m = line.match(/^= \S+\s+IPv4\s+(\S+)\s+(\S+)\s+local/);
          if (m) {
            services.add(`${m[2]}|${m[1]}`);
            hosts[m[1]] = { service: m[2] };
          }
        }
      } catch {}
    }
  } catch (e) {
    // mDNS is best-effort; never fail the scan because of it.
  }

  return { services: [...services], hosts };
}

function runWithTimeout(cmd, ms) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = exec(cmd, { timeout: ms + 1000, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024 });
    child.stdout?.on('data', d => { output += d; });
    child.stderr?.on('data', d => { output += d; });
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} resolve(output); }, ms);
    child.on('close', () => { clearTimeout(t); resolve(output); });
    child.on('error', (err) => { clearTimeout(t); resolve(output); });
  });
}

// ── Merge ───────────────────────────────────────────────────────────
// Combine ARP rows with mDNS data and ARK agent reports.
export function mergeSources({ arp = [], mdns = { services: [], hosts: {} }, agents = [] }) {
  // Start from ARP (the most ground-truthed signal).
  const by = new Map();
  for (const r of arp) {
    const key = r.mac || r.ip;
    by.set(key, {
      id: key,
      device_name: r.likely_pi ? `pi-${r.mac.slice(-5).replace(':', '')}` : 'unknown',
      role: 'unknown',
      status: 'online',
      ip: r.ip,
      mac: r.mac,
      hostname: null,
      os: r.likely_pi ? 'likely Pi' : null,
      uptime_s: null,
      cpu_temp_c: null,
      auth_status: 'unknown',
      vendor: r.vendor,
      services: [],
      manifest_id: null,
      last_seen: new Date().toISOString(),
      sources: ['arp'],
    });
  }

  // Layer in mDNS service hints — anything in mDNS with `_arkagent._tcp`
  // gets bumped to a stronger identity.
  for (const svcLine of mdns.services || []) {
    const [svc, name] = svcLine.split('|');
    // We don't know which IP this mDNS name maps to without resolving it,
    // so just record the service set; later phases will resolve hosts.
    // For now, surface the service list for unknown devices at the bottom.
  }

  // Agent reports always win — they're authoritative for their device.
  for (const a of agents) {
    const key = a.mac || a.ip || a.device_name;
    by.set(key, {
      ...by.get(key),
      ...a,
      sources: [...new Set([...(by.get(key)?.sources || []), 'agent'])],
    });
  }

  return [...by.values()].sort((a, b) => {
    // Pi-like devices to top, then by IP
    if (a.os === 'likely Pi' && b.os !== 'likely Pi') return -1;
    if (a.os !== 'likely Pi' && b.os === 'likely Pi') return 1;
    return ipSortKey(a.ip).localeCompare(ipSortKey(b.ip));
  });
}

function ipSortKey(ip) {
  return (ip || '').split('.').map(p => p.padStart(3, '0')).join('.');
}

// ── Wi-Fi nearby + active scan (Network Landscape Tab 1 + Tab 2) ────
// macOS: `system_profiler SPAirPortDataType -json` returns both the
// currently-connected network AND the surrounding visible SSIDs.
// Linux: `nmcli -t -f SSID,SIGNAL,SECURITY,CHAN dev wifi list`.
// Both are slow (3-10s) — call sparingly, not on every scan tick.
export async function wifiScan({ timeoutMs = 12000 } = {}) {
  try {
    if (IS_MAC) return await wifiScanMac(timeoutMs);
    return await wifiScanLinux(timeoutMs);
  } catch (e) {
    return { ok: false, error: e.message, nearby: [], active: null };
  }
}

async function wifiScanMac(timeoutMs) {
  const { stdout } = await sh('system_profiler SPAirPortDataType -json', { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs });
  const data = JSON.parse(stdout);
  const interfaces = data?.SPAirPortDataType?.[0]?.spairport_airport_interfaces || [];

  // First interface is usually en0 (built-in WiFi). Take its data.
  const en0 = interfaces[0] || {};
  const currentRaw  = en0.spairport_current_network_information || null;
  const nearbyRaw   = en0.spairport_airport_other_local_wireless_networks || [];

  // Normalise the SSID record shape used by both nearby + active.
  const norm = (r) => ({
    ssid:        r._name || null,
    channel:     parseChannel(r.spairport_network_channel),
    phymode:     r.spairport_network_phymode || null,
    rssi:        toInt(r.spairport_signal_noise || r.spairport_network_rssi),
    noise:       toInt(r.spairport_signal_noise_noise),
    security:    r.spairport_security_mode || r.spairport_network_security || 'unknown',
    type:        r.spairport_network_type || 'infrastructure',
    bssid:       r.spairport_network_bssid || null,
  });

  return {
    ok: true,
    scanned_at: new Date().toISOString(),
    active:  currentRaw ? norm(currentRaw) : null,
    nearby:  nearbyRaw.map(norm).sort((a, b) => (b.rssi || -1000) - (a.rssi || -1000)),
  };
}

async function wifiScanLinux(timeoutMs) {
  const { stdout } = await sh(
    "nmcli -t -f SSID,SIGNAL,SECURITY,CHAN,BSSID dev wifi list",
    { timeout: timeoutMs }
  );
  const nearby = stdout.trim().split('\n').filter(Boolean).map(line => {
    const [ssid, signal, security, chan, bssid] = line.split(':');
    return {
      ssid: ssid || null,
      rssi: signal ? -100 + Number(signal) : null,  // nmcli %, approximate dBm
      security: security || 'unknown',
      channel: chan ? Number(chan) : null,
      bssid: bssid || null,
      type: 'infrastructure',
    };
  });
  return { ok: true, scanned_at: new Date().toISOString(), nearby, active: null };
}

function parseChannel(s) {
  // macOS returns e.g. "100 (5GHz, 20MHz)" — just the number is enough.
  if (!s) return null;
  const m = String(s).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}
function toInt(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
