// Ark credential vault — Phase 5.1.
//
// Stores secrets (WiFi keys, SSH keys, API tokens) encrypted at rest.
// Returns opaque credential_refs to the rest of the system; UI and
// installer engine never see plaintext over the wire.
//
// Security model (operator-readable):
//   - Master key lives at $ARK_VAULT_KEY (default ~/.ark/vault.master.key).
//     0600 perms enforced on creation. Anyone with read on that file
//     can decrypt everything; protect it accordingly.
//   - On Hub startup: generate the master key if missing; otherwise
//     load it.
//   - Each entry encrypted with AES-256-GCM under the master key with
//     a random 12-byte IV. Auth-tag stored alongside the ciphertext.
//   - HTTP API exposes set / list / delete only. Plaintext retrieval
//     is internal-only — used by the installer engine when it has to
//     bake a credential into an install plan.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;            // AES-256
const IV_BYTES  = 12;            // GCM standard
const TAG_BYTES = 16;            // GCM auth tag

const DEFAULT_KEY_PATH = process.env.ARK_VAULT_KEY
  || path.join(homedir(), '.ark', 'vault.master.key');

const DDL = `
CREATE TABLE IF NOT EXISTS vault_entries (
  ref           TEXT PRIMARY KEY,   -- opaque public reference (e.g. "v_<8hex>")
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,      -- 'wifi-key' | 'ssh-key' | 'api-token' | 'other'
  iv            BLOB NOT NULL,
  ciphertext    BLOB NOT NULL,
  tag           BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  accessed_at   TEXT
);
`;

const ALLOWED_KINDS = new Set(['wifi-key', 'ssh-key', 'api-token', 'other']);

export function openVault(db, { keyPath = DEFAULT_KEY_PATH } = {}) {
  if (!(db instanceof DatabaseSync)) {
    throw new Error('openVault: expected DatabaseSync instance');
  }
  db.exec(DDL);
  const masterKey = loadOrCreateMasterKey(keyPath);

  return {
    keyPath,

    set({ label, kind, value }) {
      if (!label || typeof label !== 'string') throw new Error('label required');
      if (!ALLOWED_KINDS.has(kind))            throw new Error(`unknown kind: ${kind}`);
      if (typeof value !== 'string' || !value) throw new Error('value (string) required');

      const ref = newRef();
      const iv  = randomBytes(IV_BYTES);
      const c   = createCipheriv('aes-256-gcm', masterKey, iv);
      const ct  = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      const tag = c.getAuthTag();

      db.prepare(`
        INSERT INTO vault_entries (ref, label, kind, iv, ciphertext, tag, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(ref, label, kind, iv, ct, tag, new Date().toISOString());

      return { ref, label, kind, created_at: new Date().toISOString() };
    },

    // INTERNAL ONLY — never expose via HTTP. Used by the installer
    // engine when it needs to bake a credential into an install plan
    // (e.g. a WiFi key dropped into dietpi.txt).
    get(ref) {
      const row = db.prepare(`SELECT * FROM vault_entries WHERE ref = ?`).get(ref);
      if (!row) return null;
      const d = createDecipheriv('aes-256-gcm', masterKey, row.iv);
      d.setAuthTag(row.tag);
      const plain = Buffer.concat([d.update(row.ciphertext), d.final()]).toString('utf8');
      db.prepare(`UPDATE vault_entries SET accessed_at = ? WHERE ref = ?`)
        .run(new Date().toISOString(), ref);
      return { ref: row.ref, label: row.label, kind: row.kind, value: plain };
    },

    list() {
      return db.prepare(`
        SELECT ref, label, kind, created_at, accessed_at
        FROM vault_entries ORDER BY created_at DESC
      `).all();
    },

    delete(ref) {
      const r = db.prepare(`DELETE FROM vault_entries WHERE ref = ?`).run(ref);
      return r.changes > 0;
    },

    keyFingerprint() {
      // Stable, non-reversible identifier for the master key, so the
      // UI can warn if the key rotates between sessions.
      return masterKey.subarray(0, 4).toString('hex') + '…' + masterKey.subarray(-4).toString('hex');
    },
  };
}

function loadOrCreateMasterKey(keyPath) {
  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath);
    if (buf.length !== KEY_BYTES) {
      throw new Error(`master key at ${keyPath} is not ${KEY_BYTES} bytes (got ${buf.length})`);
    }
    return buf;
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key);
  // Tighten permissions to 0600 — owner read/write only.
  try { chmodSync(keyPath, 0o600); } catch {}
  console.log(`[vault] generated master key at ${keyPath} (0600)`);
  return key;
}

function newRef() {
  return 'v_' + randomBytes(8).toString('hex');
}
