// Hardening-check scheduler — Phase 7.6.
//
// Operator declares "run check X against host Y every N hours".
// The Hub maintains a cph_scheduled_checks table; a tick every
// 60s finds checks whose next-due time has passed, dispatches them
// via the SSH runner, classifies the output, records a finding.
//
// Builds entirely on top of:
//   - security.mjs::HARDENING_CHECKS + classifyCheckOutput()
//   - security.mjs::recordFinding()
//   - runner.mjs::exec()

import { HARDENING_CHECKS, classifyCheckOutput } from './security.mjs';

const DDL = `
CREATE TABLE IF NOT EXISTS cph_scheduled_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id         INTEGER NOT NULL,
  check_id        TEXT NOT NULL,
  interval_hours  REAL NOT NULL DEFAULT 24,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  last_passed     INTEGER,
  created_at      TEXT NOT NULL,
  UNIQUE(host_id, check_id),
  FOREIGN KEY (host_id) REFERENCES managed_hosts(id)
);
`;

export function initScheduler(db, { runner, security }) {
  db.exec(DDL);

  return {
    list() {
      // Join in host label + check label for the UI
      const rows = db.prepare(`SELECT * FROM cph_scheduled_checks ORDER BY created_at DESC`).all();
      for (const r of rows) {
        const h = db.prepare(`SELECT label, ssh_target FROM managed_hosts WHERE id = ?`).get(r.host_id);
        r.host_label  = h?.label;
        r.host_target = h?.ssh_target;
        const c = HARDENING_CHECKS.find(c => c.id === r.check_id);
        r.check_label = c?.label;
        r.severity    = c?.severity;
        r.next_due    = nextDue(r);
      }
      return rows;
    },

    add({ host_id, check_id, interval_hours = 24 }) {
      if (!host_id || !check_id) throw new Error('host_id and check_id required');
      const check = HARDENING_CHECKS.find(c => c.id === check_id);
      if (!check)        throw new Error(`unknown check_id: ${check_id}`);
      if (!check.probe)  throw new Error(`check ${check_id} has no automated probe`);
      const r = db.prepare(`
        INSERT INTO cph_scheduled_checks (host_id, check_id, interval_hours, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host_id, check_id) DO UPDATE SET
          interval_hours = excluded.interval_hours,
          enabled        = 1
      `).run(host_id, check_id, interval_hours, new Date().toISOString());
      return { id: r.lastInsertRowid };
    },

    delete(id) {
      const r = db.prepare(`DELETE FROM cph_scheduled_checks WHERE id = ?`).run(id);
      return r.changes > 0;
    },

    toggle(id, enabled) {
      const r = db.prepare(`UPDATE cph_scheduled_checks SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
      return r.changes > 0;
    },

    // Periodic tick — runs every minute from the Hub's startup
    // interval. Picks every enabled row whose next-due is past, runs
    // its probe via the SSH runner, classifies stdout, records a
    // finding. Errors per-row are isolated.
    async tick() {
      const due = db.prepare(`SELECT * FROM cph_scheduled_checks WHERE enabled = 1`).all()
                    .filter(row => isDue(row));
      for (const row of due) {
        const check = HARDENING_CHECKS.find(c => c.id === row.check_id);
        const host  = db.prepare(`SELECT * FROM managed_hosts WHERE id = ?`).get(row.host_id);
        if (!check || !host) continue;
        try {
          const exec = await runner.exec(row.host_id, check.probe, { reason: 'hardening-cron' });
          const ok = classifyCheckOutput(check, exec.stdout) === true;
          security.recordFinding({
            target_label:   host.label,
            check_id:       check.id,
            ok,
            severity:       check.severity,
            observation:    (exec.stdout || '').trim().slice(0, 500),
            recommendation: ok ? null : check.how_to_fix,
          });
          db.prepare(`
            UPDATE cph_scheduled_checks SET last_run_at = ?, last_passed = ? WHERE id = ?
          `).run(new Date().toISOString(), ok ? 1 : 0, row.id);
          // If a check that PREVIOUSLY passed now fails, raise an alert.
          if (row.last_passed === 1 && !ok) {
            security.raiseAlert({
              kind: 'service_change',
              severity: check.severity || 'warn',
              device_id: host.ssh_target,
              subject: `${host.label}: ${check.label} regressed`,
              detail: { check_id: check.id, observation: (exec.stdout || '').slice(0, 200) },
            });
          }
        } catch (e) {
          console.error(`[scheduler] check ${row.check_id} on host ${row.host_id} failed:`, e.message);
          db.prepare(`UPDATE cph_scheduled_checks SET last_run_at = ?, last_passed = 0 WHERE id = ?`)
            .run(new Date().toISOString(), row.id);
        }
      }
      return { ran: due.length };
    },
  };
}

function isDue(row) {
  if (!row.last_run_at) return true;
  const lastMs = new Date(row.last_run_at).getTime();
  const dueMs  = lastMs + row.interval_hours * 3600 * 1000;
  return Date.now() >= dueMs;
}
function nextDue(row) {
  if (!row.last_run_at) return new Date().toISOString();
  const lastMs = new Date(row.last_run_at).getTime();
  return new Date(lastMs + row.interval_hours * 3600 * 1000).toISOString();
}
