// Can't Phish Here — defensive security module.
//
// Hub-side storage + alert generation. Purely defensive: tracks
// approved hosts, generates alerts when Ark's existing scan data
// shows changes, and exposes a hardening checklist. NEVER runs
// offensive scans, brute-force, or default-credential attempts.
//
// Source-package reference: ~/Downloads/Jack (RaspyJack). Only the
// passive reconnaissance scripts are referenced; the credentials/
// and DNSSpoof/ trees are NEVER invoked by this module.

const DDL = `
CREATE TABLE IF NOT EXISTS cph_webhooks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  url           TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'generic',  -- 'slack' | 'discord' | 'generic'
  min_severity  TEXT NOT NULL DEFAULT 'warn',     -- 'info' | 'warn' | 'critical'
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_fired_at TEXT,
  last_status   TEXT
);

CREATE TABLE IF NOT EXISTS cph_approved_hosts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT,                       -- normalised MAC if known
  label         TEXT NOT NULL,
  ip_pattern    TEXT,                       -- exact IP or CIDR like 192.168.4.0/24
  mac           TEXT,                       -- exact MAC if pinning
  notes         TEXT,
  approved_at   TEXT NOT NULL,
  approved_by   TEXT
);

CREATE TABLE IF NOT EXISTS cph_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id      TEXT UNIQUE NOT NULL,       -- stable id so duplicates dedupe
  severity      TEXT NOT NULL,              -- 'info' | 'warn' | 'critical'
  kind          TEXT NOT NULL,              -- see ALERT_KINDS below
  device_id     TEXT,
  subject       TEXT NOT NULL,              -- short human description
  detail_json   TEXT,                       -- structured payload
  detected_at   TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cph_alerts_severity ON cph_alerts(severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_cph_alerts_kind     ON cph_alerts(kind, detected_at DESC);

CREATE TABLE IF NOT EXISTS cph_hardening_findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_label  TEXT NOT NULL,              -- which approved host
  check_id      TEXT NOT NULL,              -- e.g. 'ssh.password-auth-disabled'
  ok            INTEGER NOT NULL,           -- 0 or 1
  severity      TEXT NOT NULL,
  observation   TEXT,
  recommendation TEXT,
  checked_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cph_findings_target ON cph_hardening_findings(target_label, checked_at DESC);
`;

export const ALERT_KINDS = [
  'new_device',              // an unapproved device appeared on the LAN
  'device_offline',          // an approved device hasn't been seen in N minutes
  'mac_change',              // hostname's MAC changed (possible spoofing)
  'ip_change',               // approved device got a new IP
  'port_open',               // approved host has a new port open
  'cert_expiry',             // approved host's TLS cert expires soon
  'service_change',          // approved host's advertised services changed
  'unusual_traffic',         // (reserved — needs Pi-side daemon)
];

export const HARDENING_CHECKS = [
  {
    id: 'ssh.password-auth-disabled',
    label: 'SSH password authentication disabled',
    severity: 'critical',
    rationale: 'Password auth invites brute-force. Use SSH keys only.',
    how_to_check: 'sshd_config: PasswordAuthentication no',
    how_to_fix:   'sudo sed -i "s/^#?PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && sudo systemctl restart ssh',
  },
  {
    id: 'ssh.root-login-disabled',
    label: 'SSH root login disabled',
    severity: 'critical',
    rationale: 'Root over SSH is a high-value target. Login as a user, then sudo.',
    how_to_check: 'sshd_config: PermitRootLogin no',
    how_to_fix:   'sudo sed -i "s/^#?PermitRootLogin.*/PermitRootLogin no/" /etc/ssh/sshd_config && sudo systemctl restart ssh',
  },
  {
    id: 'ssh.protocol-2-only',
    label: 'SSH protocol 2 only',
    severity: 'warn',
    rationale: 'SSH-1 has well-known weaknesses. Always use Protocol 2.',
    how_to_check: 'sshd -T 2>/dev/null | grep -i protocol',
    how_to_fix:   'Default on modern OpenSSH; explicit Protocol 1 lines should be removed.',
  },
  {
    id: 'os.packages-up-to-date',
    label: 'OS packages up to date',
    severity: 'warn',
    rationale: 'Unpatched systems accumulate known vulns.',
    how_to_check: 'apt list --upgradable 2>/dev/null | wc -l',
    how_to_fix:   'sudo apt update && sudo apt upgrade -y',
  },
  {
    id: 'fw.ufw-enabled',
    label: 'Host firewall enabled (ufw or nftables)',
    severity: 'warn',
    rationale: 'Default-deny outbound + inbound = smaller attack surface.',
    how_to_check: 'sudo ufw status | head -1',
    how_to_fix:   'sudo apt install ufw && sudo ufw default deny incoming && sudo ufw allow 22 && sudo ufw enable',
  },
  {
    id: 'cred.no-default-router-password',
    label: 'Router admin password is NOT the factory default',
    severity: 'critical',
    rationale: 'Default credentials remain the single most common LAN compromise vector. Check manually.',
    how_to_check: '(manual) Try logging into your router admin panel with the sticker default. If it works, change it now.',
    how_to_fix:   'Change the router admin password via its web UI. Use a unique 20+ char passphrase.',
  },
  {
    id: 'iot.guest-vlan-isolated',
    label: 'IoT / smart-home devices on a separate VLAN/SSID',
    severity: 'warn',
    rationale: 'A compromised smart plug should not be able to see your laptop.',
    how_to_check: '(manual) Check your router for a "guest" or "IoT" SSID + ensure your bulbs / plugs / cameras live there.',
    how_to_fix:   'Set up a guest SSID with client-isolation enabled. Move IoT devices over.',
  },
  {
    id: 'tls.cert-not-expiring-soon',
    label: 'TLS certificates not expiring within 30 days',
    severity: 'warn',
    rationale: 'Expired certs break services unexpectedly.',
    how_to_check: 'openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -enddate',
    how_to_fix:   'Renew via certbot / Let\'s Encrypt or your CA.',
  },
];

// ── Public API ─────────────────────────────────────────────────────
export function initSecurity(db) {
  db.exec(DDL);

  return {
    // ── Approved hosts ──────────────────────────────────────────
    listApproved() {
      return db.prepare(`SELECT * FROM cph_approved_hosts ORDER BY approved_at DESC`).all();
    },
    approveHost(h) {
      if (!h.label) throw new Error('label required');
      const r = db.prepare(`
        INSERT INTO cph_approved_hosts (device_id, label, ip_pattern, mac, notes, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(h.device_id || null, h.label, h.ip_pattern || null, h.mac || null,
             h.notes || null, new Date().toISOString(), h.approved_by || 'operator');
      return { id: r.lastInsertRowid, ...h };
    },
    revokeApproval(id) {
      const r = db.prepare(`DELETE FROM cph_approved_hosts WHERE id = ?`).run(id);
      return r.changes > 0;
    },
    isApproved(device) {
      const all = db.prepare(`SELECT * FROM cph_approved_hosts`).all();
      for (const a of all) {
        if (a.mac && device.mac && a.mac.toLowerCase() === device.mac.toLowerCase()) return a;
        if (a.device_id && device.device_id && a.device_id === device.device_id) return a;
        if (a.ip_pattern && device.ip && ipMatches(device.ip, a.ip_pattern)) return a;
      }
      return null;
    },

    // ── Alerts ──────────────────────────────────────────────────
    raiseAlert(alert) {
      if (!alert.kind)    throw new Error('kind required');
      if (!ALERT_KINDS.includes(alert.kind)) throw new Error(`unknown alert kind: ${alert.kind}`);
      if (!alert.subject) throw new Error('subject required');
      const sev = alert.severity || 'info';
      const stableId = alert.alert_id ||
        `${alert.kind}:${alert.device_id || 'no-device'}:${Buffer.from(alert.subject).toString('base64').slice(0, 12)}`;
      let isNew = true;
      try {
        db.prepare(`
          INSERT INTO cph_alerts (alert_id, severity, kind, device_id, subject, detail_json, detected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(stableId, sev, alert.kind, alert.device_id || null,
               alert.subject, alert.detail ? JSON.stringify(alert.detail) : null,
               new Date().toISOString());
      } catch (e) {
        if (/UNIQUE/.test(e.message)) isNew = false;
        else throw e;
      }
      // Fire webhooks on NEW alerts only (dedupes naturally).
      if (isNew) fireWebhooks(db, { severity: sev, kind: alert.kind, subject: alert.subject, detail: alert.detail, alert_id: stableId, detected_at: new Date().toISOString() });
      return { ok: true, alert_id: stableId, new: isNew };
    },

    // ── Webhooks ────────────────────────────────────────────────
    listWebhooks() {
      return db.prepare(`SELECT * FROM cph_webhooks ORDER BY created_at DESC`).all();
    },
    addWebhook(w) {
      if (!w.label) throw new Error('label required');
      if (!w.url || !/^https?:\/\//i.test(w.url)) throw new Error('url must be http(s)://...');
      const kind = (w.kind || 'generic').toLowerCase();
      if (!['generic','slack','discord'].includes(kind)) throw new Error(`unknown webhook kind: ${kind}`);
      const sev  = (w.min_severity || 'warn').toLowerCase();
      if (!['info','warn','critical'].includes(sev)) throw new Error(`unknown severity: ${sev}`);
      const r = db.prepare(`
        INSERT INTO cph_webhooks (label, url, kind, min_severity, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(w.label, w.url, kind, sev, w.enabled === false ? 0 : 1, new Date().toISOString());
      return { id: r.lastInsertRowid };
    },
    deleteWebhook(id) {
      const r = db.prepare(`DELETE FROM cph_webhooks WHERE id = ?`).run(id);
      return r.changes > 0;
    },
    toggleWebhook(id, enabled) {
      const r = db.prepare(`UPDATE cph_webhooks SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
      return r.changes > 0;
    },
    listAlerts({ severity, kind, includeResolved = false, limit = 200 } = {}) {
      let sql = `SELECT * FROM cph_alerts WHERE 1=1`;
      const params = [];
      if (!includeResolved) sql += ` AND resolved_at IS NULL`;
      if (severity) { sql += ` AND severity = ?`; params.push(severity); }
      if (kind)     { sql += ` AND kind = ?`;     params.push(kind); }
      sql += ` ORDER BY detected_at DESC LIMIT ?`;
      params.push(limit);
      return db.prepare(sql).all(...params);
    },
    ackAlert(id) {
      const r = db.prepare(`UPDATE cph_alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`)
        .run(new Date().toISOString(), id);
      return r.changes > 0;
    },
    resolveAlert(id) {
      const r = db.prepare(`UPDATE cph_alerts SET resolved_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
      return r.changes > 0;
    },
    countAlerts() {
      return db.prepare(`
        SELECT severity, COUNT(*) AS n FROM cph_alerts
        WHERE resolved_at IS NULL GROUP BY severity
      `).all().reduce((acc, r) => { acc[r.severity] = r.n; return acc; }, { info: 0, warn: 0, critical: 0 });
    },

    // ── Hardening findings ──────────────────────────────────────
    recordFinding(f) {
      const r = db.prepare(`
        INSERT INTO cph_hardening_findings (target_label, check_id, ok, severity, observation, recommendation, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(f.target_label, f.check_id, f.ok ? 1 : 0,
             f.severity || 'warn', f.observation || null,
             f.recommendation || null, new Date().toISOString());
      return { id: r.lastInsertRowid };
    },
    listFindings(target_label) {
      const sql = target_label
        ? `SELECT * FROM cph_hardening_findings WHERE target_label = ? ORDER BY checked_at DESC LIMIT 100`
        : `SELECT * FROM cph_hardening_findings ORDER BY checked_at DESC LIMIT 100`;
      return target_label ? db.prepare(sql).all(target_label) : db.prepare(sql).all();
    },

    // ── The detector: compares current scan to past sightings and
    //    raises alerts. Called by the Hub each scan tick.
    detect({ currentDevices, previousDevices = [], store }) {
      const raised = [];

      // 1) new_device: unapproved devices on the LAN
      for (const d of currentDevices) {
        const approval = this.isApproved(d);
        if (!approval) {
          if (!d.mac) continue;  // skip ephemeral entries without a MAC
          const result = this.raiseAlert({
            kind: 'new_device',
            severity: 'warn',
            device_id: d.mac,
            subject: `Unapproved device: ${d.device_name || d.hostname || d.mac}`,
            detail: { ip: d.ip, mac: d.mac, vendor: d.vendor, hostname: d.hostname },
          });
          if (result.new) raised.push(result);
        }
      }

      // 2) mac_change: same hostname (or .local name) now reports a
      //    different MAC than last tick. Common cause: iOS Private
      //    Wi-Fi Address re-roll; less common: spoofing. Flag at warn.
      if (previousDevices.length > 0) {
        for (const cur of currentDevices) {
          if (!cur.mac || !cur.hostname) continue;
          const prev = previousDevices.find(p => p.hostname === cur.hostname && p.mac);
          if (prev && prev.mac.toLowerCase() !== cur.mac.toLowerCase()) {
            const r = this.raiseAlert({
              kind: 'mac_change',
              severity: 'warn',
              device_id: cur.mac,
              subject: `MAC change on ${cur.hostname}: ${prev.mac} → ${cur.mac}`,
              detail: { hostname: cur.hostname, ip: cur.ip, previous_mac: prev.mac, current_mac: cur.mac },
            });
            if (r.new) raised.push(r);
          }
        }
      }

      // 3) ip_change: an approved device's IP shifted. From recent
      //    sightings — only fires if the device has appeared on at
      //    least two different IPs in the last few scans.
      const approved = this.listApproved();
      for (const a of approved) {
        if (!a.device_id) continue;
        const dev = store.getDevice(a.device_id);
        if (!dev) continue;

        // device_offline check (kept from v1)
        const lastSeenMs = dev.last_seen ? new Date(dev.last_seen).getTime() : 0;
        const ageS = (Date.now() - lastSeenMs) / 1000;
        if (ageS > 300) {  // 5 min
          const r = this.raiseAlert({
            kind: 'device_offline',
            severity: 'info',
            device_id: a.device_id,
            subject: `Approved host offline: ${a.label}`,
            detail: { last_seen: dev.last_seen, age_s: Math.round(ageS) },
          });
          if (r.new) raised.push(r);
        }

        // ip_change check
        const sightings = store.listDeviceSightings(a.device_id, 3);
        if (sightings.length >= 2) {
          const distinctIps = [...new Set(sightings.map(s => s.ip).filter(Boolean))];
          if (distinctIps.length >= 2 && sightings[0].ip !== sightings[1].ip) {
            const r = this.raiseAlert({
              kind: 'ip_change',
              severity: 'info',
              device_id: a.device_id,
              subject: `${a.label} moved IP: ${sightings[1].ip} → ${sightings[0].ip}`,
              detail: { previous_ip: sightings[1].ip, current_ip: sightings[0].ip, sightings_seen: distinctIps },
            });
            if (r.new) raised.push(r);
          }
        }
      }

      return { raised, count: raised.length };
    },
  };
}

// ── Webhook dispatch ────────────────────────────────────────────────
const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

function fireWebhooks(db, alert) {
  const subs = db.prepare(`SELECT * FROM cph_webhooks WHERE enabled = 1`).all();
  if (!subs.length) return;
  for (const w of subs) {
    const wantRank = SEVERITY_RANK[w.min_severity] ?? 1;
    const gotRank  = SEVERITY_RANK[alert.severity]  ?? 1;
    if (gotRank < wantRank) continue;
    postWebhook(db, w, alert).catch(() => {});  // fire-and-forget
  }
}

async function postWebhook(db, webhook, alert) {
  let body;
  if (webhook.kind === 'slack') {
    body = JSON.stringify({
      text: `*[${alert.severity.toUpperCase()}] ${alert.kind}* — ${alert.subject}`,
      attachments: [{
        color: alert.severity === 'critical' ? '#EF6F5C' : alert.severity === 'warn' ? '#F5B45A' : '#7BB6D9',
        fields: alert.detail ? Object.entries(alert.detail).map(([title, value]) => ({
          title, value: String(value).slice(0, 200), short: true,
        })) : [],
        ts: Math.floor(new Date(alert.detected_at).getTime() / 1000),
        footer: 'Ark · Can’t Phish Here',
      }],
    });
  } else if (webhook.kind === 'discord') {
    body = JSON.stringify({
      embeds: [{
        title: `[${alert.severity.toUpperCase()}] ${alert.kind}`,
        description: alert.subject,
        color: alert.severity === 'critical' ? 0xEF6F5C : alert.severity === 'warn' ? 0xF5B45A : 0x7BB6D9,
        fields: alert.detail ? Object.entries(alert.detail).slice(0, 8).map(([name, value]) => ({
          name, value: String(value).slice(0, 200), inline: true,
        })) : [],
        timestamp: alert.detected_at,
        footer: { text: 'Ark · Can’t Phish Here' },
      }],
    });
  } else {
    body = JSON.stringify(alert);
  }

  let status = 'unknown';
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    status = `${res.status}`;
  } catch (e) {
    status = `error: ${e.message?.slice(0, 80) || 'unknown'}`;
  }
  try {
    db.prepare(`UPDATE cph_webhooks SET last_fired_at = ?, last_status = ? WHERE id = ?`)
      .run(new Date().toISOString(), status, webhook.id);
  } catch {}
}

// CIDR / exact-IP match. Pure JS, no external lib.
function ipMatches(ip, pattern) {
  if (pattern === ip) return true;
  if (!pattern.includes('/')) return false;
  const [base, bitsStr] = pattern.split('/');
  const bits = Number(bitsStr);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const ipI = ipToInt(ip);
  const baseI = ipToInt(base);
  if (ipI == null || baseI == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipI & mask) === (baseI & mask);
}
function ipToInt(ip) {
  const parts = (ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
