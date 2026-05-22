// Ark SSH Runner — Hub-side.
//
// Lets the Hub execute commands against operator-managed hosts over
// SSH. The operator's ~/.ssh/config + ~/.ssh/known_hosts +
// ssh-agent / identity files do all the auth work — Ark never sees
// or stores SSH credentials. We shell out to the system `ssh` binary
// via array-form spawn (no shell interpolation, no injection risk
// from the host_id / label fields).
//
// Used by:
//   - Phase 7.6: scheduled hardening checks against approved hosts
//   - Phase 8: online-Pi updates (push install plans without re-flash)
//   - Phase 6.7 (future): source-side disk reads via dd | pipe
//
// Safety:
//   - Operator-only feature; relies on their existing SSH posture.
//   - Hub never stores private keys. Optional identity_file_path
//     is just a hint passed to `ssh -i`.
//   - We refuse hosts whose ssh_target doesn't match user@host[:port].
//   - All commands logged in cph_alerts? No — separate runner_log table.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DDL = `
CREATE TABLE IF NOT EXISTS managed_hosts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  ssh_target    TEXT NOT NULL,           -- "pi@192.168.4.163" form
  ssh_port      INTEGER NOT NULL DEFAULT 22,
  identity_file TEXT,                    -- absolute path on the Hub host
  notes         TEXT,
  added_at      TEXT NOT NULL,
  last_reached_at TEXT,
  last_status   TEXT
);

CREATE TABLE IF NOT EXISTS runner_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id       INTEGER,
  command       TEXT NOT NULL,
  exit_code     INTEGER,
  stdout_tail   TEXT,
  stderr_tail   TEXT,
  duration_ms   INTEGER,
  ran_at        TEXT NOT NULL,
  reason        TEXT,                    -- 'hardening' | 'manual' | 'capture'
  FOREIGN KEY (host_id) REFERENCES managed_hosts(id)
);
CREATE INDEX IF NOT EXISTS idx_runner_log_host ON runner_log(host_id, ran_at DESC);
`;

// Strict ssh_target validation. Format: user@host[:port].
// Permits IPv4, .local mDNS hostnames, and DNS names.
const SSH_TARGET_RX = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

export function initRunner(db) {
  db.exec(DDL);

  return {
    // ── Host registry ──────────────────────────────────────────
    addHost(h) {
      if (!h.label)      throw new Error('label required');
      if (!h.ssh_target) throw new Error('ssh_target required');
      if (!SSH_TARGET_RX.test(h.ssh_target))
        throw new Error(`ssh_target must look like user@host[:port], got: ${h.ssh_target}`);
      if (h.identity_file && !existsSync(h.identity_file))
        throw new Error(`identity_file not found on this host: ${h.identity_file}`);
      const r = db.prepare(`
        INSERT INTO managed_hosts (label, ssh_target, ssh_port, identity_file, notes, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        h.label, h.ssh_target, h.ssh_port || 22,
        h.identity_file || null, h.notes || null,
        new Date().toISOString(),
      );
      return { id: r.lastInsertRowid };
    },
    listHosts() {
      return db.prepare(`SELECT * FROM managed_hosts ORDER BY added_at DESC`).all();
    },
    getHost(id) {
      return db.prepare(`SELECT * FROM managed_hosts WHERE id = ?`).get(id);
    },
    deleteHost(id) {
      // Cascade-clean the log first; SQLite default doesn't ON DELETE CASCADE
      db.prepare(`DELETE FROM runner_log WHERE host_id = ?`).run(id);
      const r = db.prepare(`DELETE FROM managed_hosts WHERE id = ?`).run(id);
      return r.changes > 0;
    },

    // ── Exec ───────────────────────────────────────────────────
    // Run `command` on host. Returns { ok, exit_code, stdout, stderr, duration_ms }.
    // Tails stdout/stderr at 4 KB each to keep DB rows bounded.
    async exec(hostId, command, { reason = 'manual', timeoutMs = 30000 } = {}) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command required');
      const host = this.getHost(hostId);
      if (!host) throw new Error(`unknown host_id: ${hostId}`);

      const t0 = Date.now();
      const args = ['-o', 'BatchMode=yes',                  // never prompt — fail fast if auth fails
                    '-o', 'ConnectTimeout=10',
                    '-o', 'StrictHostKeyChecking=accept-new', // first connect accepts, subsequent strict
                    '-p', String(host.ssh_port || 22)];
      if (host.identity_file) { args.push('-i', host.identity_file); }
      args.push(host.ssh_target.split(':')[0], '--', command);

      const result = await runSpawn('ssh', args, timeoutMs);
      const dur = Date.now() - t0;
      const stdoutTail = result.stdout.slice(-4096);
      const stderrTail = result.stderr.slice(-4096);

      // Persist log + host status
      db.prepare(`
        INSERT INTO runner_log (host_id, command, exit_code, stdout_tail, stderr_tail, duration_ms, ran_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(hostId, command, result.code, stdoutTail, stderrTail, dur, new Date().toISOString(), reason);
      db.prepare(`
        UPDATE managed_hosts SET last_reached_at = ?, last_status = ? WHERE id = ?
      `).run(new Date().toISOString(), result.code === 0 ? 'ok' : `exit ${result.code}`, hostId);

      return {
        ok:          result.code === 0,
        exit_code:   result.code,
        stdout:      result.stdout,
        stderr:      result.stderr,
        duration_ms: dur,
      };
    },

    // Cheap connectivity probe — echo a known string and compare.
    async test(hostId) {
      const r = await this.exec(hostId, "echo ark-runner-ok", { reason: 'manual', timeoutMs: 15000 });
      const matched = (r.stdout || '').trim().endsWith('ark-runner-ok');
      return { ok: r.ok && matched, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    },

    // ── Log access ─────────────────────────────────────────────
    listLog(hostId, limit = 50) {
      return db.prepare(`
        SELECT * FROM runner_log WHERE host_id = ? ORDER BY ran_at DESC LIMIT ?
      `).all(hostId, limit);
    },
  };
}

// ── helpers ────────────────────────────────────────────────────
function runSpawn(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const out = (b) => { stdout += b.toString('utf8'); };
    const err = (b) => { stderr += b.toString('utf8'); };
    child.stdout.on('data', out);
    child.stderr.on('data', err);
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + '\nspawn error: ' + e.message }); });
  });
}
