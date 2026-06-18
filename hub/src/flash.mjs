// Ark Flash Node subsystem — Hub-side.
//
// Persists registered flash nodes, image registry entries, and the
// job queue. The actual disk writes happen on a Pi running the Flash
// Agent (agent/ark-flash-agent.py); the Hub orchestrates.
//
// Integrates with the rest of Ark:
//   - manifests       : flash_images.manifest_id links each image to
//                       the manifest it was built from
//   - device registry : flash nodes are also recorded in devices()
//                       with role='flash_node' so they show up in
//                       Network + Fleet views
//   - exports         : fleet snapshot includes flash node summary
//   - health          : flash nodes use the same telemetry/health
//                       path as the regular agent

import { promises as fs, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILDS_DIR = path.join(REPO_ROOT, 'builds');

const DDL = `
CREATE TABLE IF NOT EXISTS flash_nodes (
  node_id           TEXT PRIMARY KEY,
  node_name         TEXT NOT NULL,
  hardware_model    TEXT,
  capabilities_json TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'offline',
  network_id        TEXT,
  agent_url         TEXT NOT NULL,
  registered_at     TEXT NOT NULL,
  last_seen         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flash_images (
  image_id      TEXT PRIMARY KEY,
  source_path   TEXT NOT NULL,
  manifest_id   TEXT,
  build_name    TEXT,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  compression   TEXT NOT NULL DEFAULT 'none',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flash_jobs (
  job_id            TEXT PRIMARY KEY,
  node_id           TEXT NOT NULL,
  image_id          TEXT NOT NULL,
  target_disk_path  TEXT NOT NULL,
  target_disk_model TEXT,
  state             TEXT NOT NULL DEFAULT 'queued',
  priority          INTEGER NOT NULL DEFAULT 0,
  progress_pct      INTEGER NOT NULL DEFAULT 0,
  bytes_written     INTEGER NOT NULL DEFAULT 0,
  write_speed_mbps  REAL,
  eta_s             INTEGER,
  error             TEXT,
  log_tail          TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  FOREIGN KEY (node_id)  REFERENCES flash_nodes(node_id),
  FOREIGN KEY (image_id) REFERENCES flash_images(image_id)
);
CREATE INDEX IF NOT EXISTS idx_flash_jobs_state ON flash_jobs(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flash_jobs_node  ON flash_jobs(node_id, created_at DESC);
`;

export const JOB_STATES = [
  'queued', 'preparing', 'writing', 'syncing',
  'verifying', 'mount_test', 'completed',
  'failed', 'cancelled', 'paused',
];

export const NODE_CAPABILITIES = ['sd_write', 'ssd_write', 'verify', 'clone'];

export function initFlash(db) {
  db.exec(DDL);

  return {
    // ── Nodes ────────────────────────────────────────────────────
    registerNode(reg) {
      if (!reg.node_id)   throw new Error('node_id required');
      if (!reg.node_name) throw new Error('node_name required');
      if (!reg.agent_url) throw new Error('agent_url required');
      const now = new Date().toISOString();
      const caps = JSON.stringify(reg.capabilities || []);
      db.prepare(`
        INSERT INTO flash_nodes (node_id, node_name, hardware_model, capabilities_json,
                                 status, network_id, agent_url, registered_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          node_name         = excluded.node_name,
          hardware_model    = COALESCE(excluded.hardware_model,  flash_nodes.hardware_model),
          capabilities_json = excluded.capabilities_json,
          status            = excluded.status,
          network_id        = COALESCE(excluded.network_id, flash_nodes.network_id),
          agent_url         = excluded.agent_url,
          last_seen         = excluded.last_seen
      `).run(
        reg.node_id, reg.node_name, reg.hardware_model || null, caps,
        reg.status || 'idle', reg.network_id || null, reg.agent_url,
        reg.registered_at || now, now,
      );
      return this.getNode(reg.node_id);
    },

    heartbeatNode(nodeId, status) {
      const r = db.prepare(`UPDATE flash_nodes SET last_seen = ?, status = COALESCE(?, status) WHERE node_id = ?`)
        .run(new Date().toISOString(), status || null, nodeId);
      return r.changes > 0;
    },

    listNodes() {
      return db.prepare(`SELECT * FROM flash_nodes ORDER BY last_seen DESC`).all()
        .map(parseCapabilities);
    },
    getNode(id) {
      const r = db.prepare(`SELECT * FROM flash_nodes WHERE node_id = ?`).get(id);
      return r ? parseCapabilities(r) : null;
    },

    // ── Images ───────────────────────────────────────────────────
    registerImage(img) {
      // Dedupe rule: a given source_path resolves to ONE image_id
      // forever. Re-registering the same path with new bytes (rebuilt
      // .img with a different sha) updates the existing row in place
      // instead of creating a parallel ghost entry that points at the
      // same file.
      //
      // Caller-supplied image_id still wins if given, so the upload
      // endpoint's "store at /flash-images/<sha>.img" content-
      // addressable scheme keeps working.
      let id = img.image_id;
      if (!id) {
        const existing = db.prepare(`SELECT image_id FROM flash_images WHERE source_path = ?`).get(img.source_path);
        id = existing?.image_id || newId('img');
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO flash_images (image_id, source_path, manifest_id, build_name,
                                  size_bytes, sha256, compression, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(image_id) DO UPDATE SET
          source_path = excluded.source_path,
          manifest_id = COALESCE(excluded.manifest_id, flash_images.manifest_id),
          build_name  = COALESCE(excluded.build_name,  flash_images.build_name),
          size_bytes  = excluded.size_bytes,
          sha256      = excluded.sha256,
          compression = excluded.compression,
          status      = excluded.status
      `).run(
        id, img.source_path, img.manifest_id || null, img.build_name || null,
        img.size_bytes, img.sha256, img.compression || 'none',
        img.status || 'active', img.created_at || now,
      );
      return this.getImage(id);
    },

    listImages() {
      return db.prepare(`SELECT * FROM flash_images WHERE status = 'active' ORDER BY created_at DESC`).all();
    },

    // Walk builds/*/out/ for ark-built.img(.xz) files and register
    // anything new. Idempotent — skips when source_path is already
    // registered AND file size hasn't changed (the cheap proxy for
    // "image unchanged" — avoids re-hashing 200 MB on every call).
    //
    // Called once at Hub startup, and on demand via the rescan endpoint.
    async rescanBuildOutputs() {
      if (!existsSync(BUILDS_DIR)) return { scanned: 0, added: 0, updated: 0, skipped: 0 };
      const stats = { scanned: 0, added: 0, updated: 0, skipped: 0 };
      const entries = await fs.readdir(BUILDS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // Prefer the .img.xz (what you'd actually flash); fall back
        // to raw .img if no compressed version is around.
        const xz  = path.join(BUILDS_DIR, e.name, 'out', 'ark-built.img.xz');
        const raw = path.join(BUILDS_DIR, e.name, 'out', 'ark-built.img');
        const filePath = existsSync(xz) ? xz : (existsSync(raw) ? raw : null);
        if (!filePath) continue;
        stats.scanned++;

        const fsize = statSync(filePath).size;
        const existing = db.prepare(`SELECT image_id, sha256, size_bytes FROM flash_images WHERE source_path = ?`).get(filePath);
        if (existing && existing.size_bytes === fsize) {
          stats.skipped++;
          continue;
        }

        // New or changed — compute sha256 (streamed; bounded memory)
        const sha = await sha256OfFile(filePath);
        const isXz = filePath.endsWith('.xz');
        const buildName = e.name + (isXz ? '.img.xz' : '.img');
        this.registerImage({
          source_path: filePath,
          manifest_id: e.name,
          build_name:  buildName,
          size_bytes:  fsize,
          sha256:      sha,
          compression: isXz ? 'xz' : 'none',
        });
        if (existing) stats.updated++; else stats.added++;
      }
      return stats;
    },
    getImage(id) {
      return db.prepare(`SELECT * FROM flash_images WHERE image_id = ?`).get(id);
    },
    archiveImage(id) {
      const r = db.prepare(`UPDATE flash_images SET status = 'archived' WHERE image_id = ?`).run(id);
      return r.changes > 0;
    },

    // Hard-delete an image registry row. Returns the row's
    // source_path so the caller can also remove the file on disk.
    // Refuses to delete an image referenced by an in-flight job.
    deleteImage(id) {
      const inflight = db.prepare(`
        SELECT COUNT(*) AS n FROM flash_jobs
        WHERE image_id = ? AND state NOT IN ('completed', 'failed', 'cancelled')
      `).get(id);
      if (inflight.n > 0) throw new Error(`image ${id} is referenced by ${inflight.n} in-flight job(s); cancel them first`);
      const img = this.getImage(id);
      if (!img) return null;
      db.prepare(`DELETE FROM flash_images WHERE image_id = ?`).run(id);
      return { deleted: true, source_path: img.source_path };
    },

    // Hard-delete a flash node from the registry. Doesn't touch the
    // Pi itself — just removes Ark's record. Refuses if jobs are
    // in flight against this node.
    deleteNode(id) {
      const inflight = db.prepare(`
        SELECT COUNT(*) AS n FROM flash_jobs
        WHERE node_id = ? AND state NOT IN ('completed', 'failed', 'cancelled')
      `).get(id);
      if (inflight.n > 0) throw new Error(`node ${id} has ${inflight.n} job(s) in flight; cancel them first`);
      const r = db.prepare(`DELETE FROM flash_nodes WHERE node_id = ?`).run(id);
      return r.changes > 0;
    },

    // ── Jobs ─────────────────────────────────────────────────────
    enqueueJob(job) {
      const errors = validateJobInput(job);
      if (errors.length) throw new Error('invalid job: ' + errors.join('; '));
      const node = this.getNode(job.node_id);
      if (!node) throw new Error(`unknown node_id: ${job.node_id}`);
      const image = this.getImage(job.image_id);
      if (!image) throw new Error(`unknown image_id: ${job.image_id}`);

      const id = newId('job');
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO flash_jobs (job_id, node_id, image_id, target_disk_path, target_disk_model,
                                state, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, job.node_id, job.image_id, job.target_disk_path,
        job.target_disk_model || null, 'queued', job.priority || 0, now,
      );
      return this.getJob(id);
    },

    updateJob(jobId, fields) {
      const allowed = ['state', 'progress_pct', 'bytes_written', 'write_speed_mbps',
                       'eta_s', 'error', 'log_tail', 'started_at', 'completed_at'];
      const updates = [], params = [];
      for (const k of allowed) {
        if (fields[k] !== undefined) {
          updates.push(`${k} = ?`);
          params.push(fields[k]);
        }
      }
      if (!updates.length) return this.getJob(jobId);
      params.push(jobId);
      db.prepare(`UPDATE flash_jobs SET ${updates.join(', ')} WHERE job_id = ?`).run(...params);
      return this.getJob(jobId);
    },

    listJobs({ nodeId, state, limit = 50 } = {}) {
      let sql = `SELECT * FROM flash_jobs WHERE 1=1`;
      const params = [];
      if (nodeId) { sql += ` AND node_id = ?`; params.push(nodeId); }
      if (state)  { sql += ` AND state   = ?`; params.push(state); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      return db.prepare(sql).all(...params);
    },

    getJob(id) {
      return db.prepare(`SELECT * FROM flash_jobs WHERE job_id = ?`).get(id);
    },

    cancelJob(id) {
      const r = db.prepare(`
        UPDATE flash_jobs SET state = 'cancelled', completed_at = ?
        WHERE job_id = ? AND state IN ('queued', 'paused', 'preparing')
      `).run(new Date().toISOString(), id);
      return r.changes > 0;
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseCapabilities(row) {
  try { row.capabilities = JSON.parse(row.capabilities_json); } catch { row.capabilities = []; }
  delete row.capabilities_json;
  return row;
}

function validateJobInput(j) {
  const errs = [];
  if (!j.node_id)          errs.push('node_id required');
  if (!j.image_id)         errs.push('image_id required');
  if (!j.target_disk_path) errs.push('target_disk_path required');
  // Refuse obviously dangerous targets up-front. The Flash Agent
  // applies the same checks server-side; this is just early bail-out
  // so the UI surfaces a clean error.
  if (/^\/dev\/sda$/.test(j.target_disk_path) ||
      /^\/dev\/nvme0n1$/.test(j.target_disk_path) ||
      /^\/dev\/mmcblk0$/.test(j.target_disk_path)) {
    // These names sometimes happen to be removable, but on most
    // Pis they're the OS disk. Mark as needing explicit confirmation.
    if (!j.confirm_root_disk_ok) errs.push(`target ${j.target_disk_path} looks like a system disk; pass confirm_root_disk_ok=true to override`);
  }
  return errs;
}

function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

// Streamed sha256 — bounded memory regardless of file size.
function sha256OfFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
