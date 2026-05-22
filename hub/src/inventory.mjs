// Hub inventory endpoints — filesystem-backed listings of builds,
// base images, built images, and logs. Drives the Builds / Images /
// Logs nav panels in the browser UI.
//
// All paths resolve relative to the repo root (one level up from
// hub/), so the Hub can be moved without breaking the listings.

import { promises as fs, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILDS_DIR = path.join(REPO_ROOT, 'builds');
const OS_DIR     = path.join(REPO_ROOT, 'Os');
const HUB_LOG    = path.join(process.env.HOME || '', 'Library', 'Logs', 'ark-hub.log');

// ── Builds ──────────────────────────────────────────────────────────
export async function listBuilds() {
  if (!existsSync(BUILDS_DIR)) return [];
  const entries = await fs.readdir(BUILDS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const buildDir = path.join(BUILDS_DIR, e.name);
    out.push(await summariseBuild(e.name, buildDir));
  }
  return out.sort((a, b) => (b.last_touched_ms || 0) - (a.last_touched_ms || 0));
}

export async function getBuild(name) {
  const buildDir = path.join(BUILDS_DIR, name);
  if (!existsSync(buildDir)) return null;
  return summariseBuild(name, buildDir);
}

async function summariseBuild(name, buildDir) {
  const profilePath  = path.join(buildDir, 'profile.json');
  const manifestPath = path.join(buildDir, 'manifest.json');
  const planJsonPath = path.join(buildDir, 'install.plan.json');
  const planShPath   = path.join(buildDir, 'install.plan.sh');
  const logPath      = path.join(buildDir, 'install.log');
  const outImgPath   = path.join(buildDir, 'out', 'ark-built.img');

  const has = (p) => existsSync(p);
  let manifest = null, profile = null, planJson = null;
  try { if (has(manifestPath)) manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}
  try { if (has(profilePath))  profile  = JSON.parse(await fs.readFile(profilePath,  'utf8')); } catch {}
  try { if (has(planJsonPath)) planJson = JSON.parse(await fs.readFile(planJsonPath, 'utf8')); } catch {}

  let lastTouched = 0;
  for (const p of [profilePath, manifestPath, planJsonPath, planShPath, logPath, outImgPath]) {
    if (has(p)) lastTouched = Math.max(lastTouched, statSync(p).mtimeMs);
  }
  let outImgSize = null;
  if (has(outImgPath)) outImgSize = statSync(outImgPath).size;

  return {
    name,
    has: {
      profile:    has(profilePath),
      manifest:   has(manifestPath),
      plan_json:  has(planJsonPath),
      plan_sh:    has(planShPath),
      install_log:has(logPath),
      built_img:  has(outImgPath),
    },
    manifest_summary: manifest ? {
      name: manifest.name,
      version: manifest.version,
      entry_points: manifest.entry_points?.length || 0,
      apt: manifest.dependencies?.apt?.length || 0,
      pip: manifest.dependencies?.pip?.length || 0,
      hardware: manifest.hardware,
      architecture: manifest.architecture,
    } : null,
    profile_summary: profile ? {
      name: profile.name,
      profile_id: profile.profile_id,
      category: profile.category,
    } : null,
    plan_summary: planJson ? {
      build_name: planJson.build_name,
      chosen_entry_point: planJson.chosen_entry_point,
      target_arch: planJson.target_arch,
      step_count: planJson.steps?.length || 0,
      generated_at: planJson.generated_at,
    } : null,
    out_img_size_bytes: outImgSize,
    last_touched_ms: lastTouched,
    last_touched: lastTouched ? new Date(lastTouched).toISOString() : null,
  };
}

// ── Images ──────────────────────────────────────────────────────────
// Two sources: Os/ (base images the operator downloaded) and any
// builds/*/out/ark-built.img (images Ark produced).
export async function listImages() {
  const out = { bases: [], built: [] };
  if (existsSync(OS_DIR)) {
    const entries = await fs.readdir(OS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(img|img\.xz|iso|zip)$/i.test(e.name)) continue;
      const p = path.join(OS_DIR, e.name);
      const s = statSync(p);
      out.bases.push({
        name: e.name,
        path: p,
        size_bytes: s.size,
        last_modified: new Date(s.mtimeMs).toISOString(),
        kind: e.name.endsWith('.xz') ? 'compressed' : 'raw',
      });
    }
  }
  if (existsSync(BUILDS_DIR)) {
    const entries = await fs.readdir(BUILDS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const outDir = path.join(BUILDS_DIR, e.name, 'out');
      if (!existsSync(outDir)) continue;
      const subs = await fs.readdir(outDir);
      for (const f of subs) {
        if (!/\.(img|img\.xz|sha256)$/.test(f)) continue;
        const p = path.join(outDir, f);
        const s = statSync(p);
        out.built.push({
          build: e.name,
          name: f,
          path: p,
          size_bytes: s.size,
          last_modified: new Date(s.mtimeMs).toISOString(),
          kind: f.endsWith('.sha256') ? 'checksum' : f.endsWith('.xz') ? 'compressed' : 'raw',
        });
      }
    }
  }
  out.bases.sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  out.built.sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  return out;
}

// ── Logs ────────────────────────────────────────────────────────────
// Tail-style read — last N kilobytes only, so a multi-megabyte log
// doesn't blow up the JSON response.
export async function tailFile(filePath, { maxBytes = 64 * 1024 } = {}) {
  if (!existsSync(filePath)) return { exists: false, body: '', bytes: 0, path: filePath };
  const s = statSync(filePath);
  const start = Math.max(0, s.size - maxBytes);
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(s.size - start);
    await fh.read(buf, 0, buf.length, start);
    const body = buf.toString('utf8');
    // If we truncated, throw away the partial first line so the
    // visible content always starts at a line boundary.
    const cleaned = start === 0 ? body : body.slice(body.indexOf('\n') + 1);
    return {
      exists:  true,
      body:    cleaned,
      bytes:   buf.length,
      size:    s.size,
      truncated: start > 0,
      path:    filePath,
      modified_at: new Date(s.mtimeMs).toISOString(),
    };
  } finally {
    await fh.close();
  }
}

export function hubLogPath() { return HUB_LOG; }
export function buildLogPath(name) {
  return path.join(BUILDS_DIR, name, 'install.log');
}
