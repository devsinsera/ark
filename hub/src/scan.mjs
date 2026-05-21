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
  const hosts = {};   // hostname -> { ip?, port?, service? }
  const byIp  = {};   // ip -> hostname.local

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
      // dns-sd -B blocks; capture ~timeoutMs of output then kill.
      // Instance names look like  "SinseraCore [88:a2:9e:a6:a9:f1]" —
      // strip the bracketed hint to get the bare hostname.
      const candidates = new Set();
      for (const svc of wantServices) {
        try {
          const out = await runWithTimeout(`dns-sd -B ${svc} local.`, timeoutMs / wantServices.length);
          for (const line of out.split('\n')) {
            const m = line.match(/\s+Add\s+\d+\s+\d+\s+local\.\s+\S+\s+(.+)$/);
            if (m) {
              const raw = m[1].trim();
              const cleaned = raw.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
              if (!cleaned) continue;
              services.add(`${svc}|${cleaned}`);
              hosts[cleaned] = hosts[cleaned] || { service: svc };
              candidates.add(cleaned);
            }
          }
        } catch { /* keep going across services */ }
      }
      // Forward-resolve every candidate name → IP. dscacheutil is fast
      // and respects the mDNS resolver on macOS; reverse-PTR lookups
      // don't work, so we build the reverse map ourselves.
      await resolveCandidatesByIp([...candidates], byIp, hosts);
    } else {
      // avahi-browse -art (terminate, return all, resolve) — single shot.
      try {
        const out = await runWithTimeout('avahi-browse -art', timeoutMs);
        for (const line of out.split('\n')) {
          const m = line.match(/^= \S+\s+IPv4\s+(\S+)\s+(\S+)\s+local/);
          if (m) {
            services.add(`${m[2]}|${m[1]}`);
            hosts[m[1]] = { service: m[2] };
            // avahi-browse -r resolves; on Linux byIp can be filled from
            // additional "address = " lines, but minimal handling here.
          }
        }
      } catch {}
    }
  } catch {
    // mDNS is best-effort; never fail the scan because of it.
  }

  return { services: [...services], hosts, byIp };
}

// Forward-resolve a batch of bare hostnames (without `.local` suffix),
// populating byIp + hosts[name].ip. Uses TWO macOS resolvers in
// parallel because each only reports one interface:
//   - dscacheutil → the resolver's preferred A record
//   - dig +short -p 5353 @224.0.0.251 → the multicast-side A record
// Their union covers Pis like SinseraCore that expose both Ethernet
// and Wi-Fi interfaces under the same .local name.
async function resolveCandidatesByIp(names, byIp, hosts) {
  const limited = names.slice(0, 30);
  await Promise.all(limited.map(async (name) => {
    const fqdn = name.endsWith('.local') ? name : `${name}.local`;
    const ips  = new Set();

    // Resolver 1: dscacheutil
    try {
      const out = await runWithTimeout(`dscacheutil -q host -a name ${shellEscape(fqdn)}`, 900);
      for (const m of out.matchAll(/ip_address:\s+(\d+\.\d+\.\d+\.\d+)/g)) ips.add(m[1]);
    } catch {}

    // Resolver 2: dig over mDNS multicast (catches the other interface)
    try {
      const out = await runWithTimeout(`dig +short +time=1 +tries=1 -p 5353 @224.0.0.251 ${shellEscape(fqdn)} A`, 1500);
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)$/);
        if (m) ips.add(m[1]);
      }
    } catch {}

    for (const ip of ips) {
      if (!byIp[ip]) byIp[ip] = fqdn;
      if (hosts[name] && !hosts[name].ip) hosts[name].ip = ip;
    }
  }));
}

function shellEscape(s) {
  const str = String(s);
  if (str.includes("'")) return `"${str.replace(/"/g, '\\"')}"`;
  return `'${str}'`;
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

// Resolve an IP back to its mDNS .local hostname (best-effort).
// Uses macOS / Linux nss-mdns: `dig +short -x <ip>` or `dns-sd -G`.
// Times out fast so the scan loop never stalls.
export async function reverseMdns(ip, timeoutMs = 1500) {
  try {
    const cmd = IS_MAC
      ? `dscacheutil -q host -a ipv4_address ${ip}`
      : `getent hosts ${ip}`;
    const out = await runWithTimeout(cmd, timeoutMs);
    if (IS_MAC) {
      const m = out.match(/name:\s+(\S+)/);
      return m ? m[1] : null;
    } else {
      const m = out.match(/\s+(\S+)/);
      return m ? m[1] : null;
    }
  } catch {
    return null;
  }
}

// ── Merge ───────────────────────────────────────────────────────────
// Combine ARP rows with mDNS data and ARK agent reports.
export function mergeSources({ arp = [], mdns = { services: [], hosts: {}, byIp: {} }, agents = [] }) {
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

  // Layer in mDNS hostnames — for any device whose IP appears in the
  // mDNS byIp map, attach the .local hostname and (if the merged
  // device_name is still synthetic) replace it with the real one.
  for (const [ip, host] of Object.entries(mdns.byIp || {})) {
    for (const d of by.values()) {
      if (d.ip === ip) {
        d.hostname = host;
        if (d.device_name === 'unknown' || /^pi-[a-f0-9]+$/.test(d.device_name)) {
          d.device_name = host.replace(/\.local\.?$/, '');
        }
        if (!d.sources.includes('mdns')) d.sources.push('mdns');
      }
    }
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

// ── Current network identity ────────────────────────────────────────
// Derive a stable network_id for the network the Hub is currently on.
// Uses default gateway + ARP + (when available) active Wi-Fi SSID.
//
// Format:
//   wifi:<ssid>:<gateway_mac>           — when on Wi-Fi
//   ethernet:<subnet>:<gateway_mac>     — when on Ethernet only
//   unknown:<gateway_ip>                — fallback
//
// Returns null if no default gateway can be found (rare).
export async function detectCurrentNetwork({ activeWifi = null } = {}) {
  // 1) gateway IP from `netstat -nr` (macOS) or `ip route` (Linux)
  let gwIp = null, iface = null;
  try {
    if (IS_MAC) {
      const { stdout } = await sh('netstat -nr -f inet | grep default | head -1');
      const m = stdout.match(/^default\s+(\S+)\s+\S+\s+(\S+)/m);
      if (m) { gwIp = m[1]; iface = m[2]; }
    } else {
      const { stdout } = await sh('ip route show default');
      const m = stdout.match(/^default via (\S+) dev (\S+)/);
      if (m) { gwIp = m[1]; iface = m[2]; }
    }
  } catch {}
  if (!gwIp) return null;

  // 2) gateway MAC from ARP table
  let gwMac = null;
  try {
    const arp = await arpScan();
    const row = arp.find(r => r.ip === gwIp);
    if (row) gwMac = row.mac;
  } catch {}

  // 3) decide type. macOS uses `en0` for BOTH Wi-Fi and Ethernet
  // depending on the hardware, so interface-name matching is unreliable.
  // The authoritative signal is whether system_profiler returned a
  // current Wi-Fi association — if activeWifi is non-null we're on
  // Wi-Fi even when the SSID itself is "<redacted>" (which macOS does
  // when Node doesn't have Location Services permission).
  const isWifi = !!activeWifi;
  const ssid   = isWifi ? (activeWifi.ssid || null) : null;
  const type   = isWifi ? 'wifi' : (iface && /^(eth|en)/.test(iface) ? 'ethernet' : 'unknown');

  // 4) subnet — best-effort: derive from gateway IP /24 (cheap default)
  const subnetParts = gwIp.split('.');
  const subnet = subnetParts.length === 4 ? `${subnetParts[0]}.${subnetParts[1]}.${subnetParts[2]}.0/24` : null;

  // Build a stable id. When SSID is "<redacted>", fall back to the
  // gateway MAC + subnet for uniqueness so multiple redacted networks
  // don't collide into one row.
  const ssidForId = ssid && ssid !== '<redacted>' ? ssid : (subnet || gwIp);
  const idCore = isWifi ? ssidForId : (subnet || gwIp);
  const network_id = `${type}:${idCore}:${gwMac || gwIp}`;

  return {
    network_id,
    type,
    ssid,
    ssid_redacted: ssid === '<redacted>',
    subnet,
    gateway_ip:  gwIp,
    gateway_mac: gwMac,
    security:    isWifi ? (activeWifi.security || null) : null,
    interface:   iface,
  };
}
