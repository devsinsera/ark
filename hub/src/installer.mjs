// Hub-side wrapper around the installer engine. Lets the browser
// drive the engine that, until now, was CLI-only (`node installer/
// bin/ark-install.mjs ingest|detect|compile`).
//
// Wraps the same library functions the CLI uses, so behaviour is
// identical. The browser sends a source (git URL / ZIP upload /
// folder path) + a target build name + an optional profile id, and
// gets back the produced manifest + plan summary.

import { promises as fs, existsSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../../installer/src/ingest.mjs';
import { detect } from '../../installer/src/detect.mjs';
import { compile } from '../../installer/src/compile.mjs';
import { manifestFromDetection, writeManifest } from '../../installer/src/manifest.mjs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const BUILDS_ROOT  = path.join(REPO_ROOT, 'builds');
const UPLOAD_TMP   = path.join(REPO_ROOT, '.installer-uploads');

// Slugify a build name to a safe filesystem path — strips anything
// that could escape the builds/ directory.
export function safeBuildName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Stream raw bytes from req into UPLOAD_TMP/<name>.zip. Returns the
// resolved path. Caller passes the request object directly; we
// pipe-stream so big uploads don't sit in memory.
export async function stageZipFromRequest(req, name) {
  await fs.mkdir(UPLOAD_TMP, { recursive: true });
  const safeName = safeBuildName(name) || ('upload-' + Date.now());
  const dest = path.join(UPLOAD_TMP, safeName + '.zip');
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  return dest;
}

// Run the full pipeline (ingest -> detect -> compile) against a
// source. Returns the produced artefacts as paths + summaries.
//
// source.kind: 'git' | 'zip-path' | 'folder' | 'bundle'
// source.value: the URL / file path / folder path
// source.ref:   optional commit/branch/tag for git sources
export async function runEngine({ source, buildName, profileId = null, useVenv = false }) {
  if (!source || !source.kind || !source.value) {
    throw new Error('source.kind + source.value required');
  }
  const safe = safeBuildName(buildName);
  if (!safe) throw new Error('buildName resolves to empty after sanitisation');

  // Map kind → source string the ingest() function recognises
  let sourceStr;
  let ref = source.ref || null;
  switch (source.kind) {
    case 'git':       sourceStr = source.value; break;
    case 'zip-path':  sourceStr = source.value; break;   // path to a .zip file
    case 'folder':    sourceStr = source.value; break;   // local directory
    case 'bundle':    sourceStr = source.value; break;   // path to a .tar.gz
    default: throw new Error(`unknown source.kind: ${source.kind}`);
  }

  // Phase 1 — ingest
  const ing = await ingest({ source: sourceStr, buildName: safe, buildsRoot: BUILDS_ROOT, ref });

  // Phase 2 — detect
  const det = await detect({ buildDir: ing.build_dir });
  await writeManifest(ing.build_dir, manifestFromDetection(det));

  // Optional profile (e.g. raspyjack, claude-cli-pi)
  let profile = null;
  if (profileId) {
    const p = path.join(BUILDS_ROOT, profileId, 'profile.json');
    if (existsSync(p)) {
      profile = JSON.parse(await fs.readFile(p, 'utf8'));
    }
  }

  // Phase 3 — compile (renders install.plan.sh + install.plan.json)
  const compiled = await compile({ buildDir: ing.build_dir, detection: det, profile, useVenv });

  return {
    build_name: safe,
    build_dir:  ing.build_dir,
    input_type: ing.input_type,
    source:     ing.source,
    manifest:   compiled.manifest,
    plan_summary: {
      build_name:         compiled.plan.build_name,
      chosen_entry_point: compiled.plan.chosen_entry_point,
      target_arch:        compiled.plan.target_arch,
      step_count:         compiled.plan.steps?.length || 0,
      generated_at:       compiled.plan.generated_at,
    },
    plan_path:   compiled.plan_path,
    script_path: compiled.script_path,
    log_path:    compiled.log_path,
  };
}

// List build-profile JSONs from builds/*/profile.json — used to
// populate the profile picker in the UI.
export async function listProfiles() {
  if (!existsSync(BUILDS_ROOT)) return [];
  const entries = await fs.readdir(BUILDS_ROOT, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(BUILDS_ROOT, e.name, 'profile.json');
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf8'));
      out.push({
        profile_id:   j.profile_id || e.name,
        name:         j.name || e.name,
        description:  j.description || '',
        category:     j.category || null,
      });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
