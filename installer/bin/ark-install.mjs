#!/usr/bin/env node
// ark-install — CLI entry for the ARK-CORE Installer Engine.
//
// Usage:
//   ark-install ingest  <source>      --as <build_name>
//   ark-install detect  <build_name>
//   ark-install compile <build_name>  [--profile <profile_id>]
//   ark-install backup  <build_name>  [--format zip|tar.gz]
//   ark-install run     <source>      --as <build_name>  [--profile <profile_id>]
//
// `run` is a convenience: ingest → detect → compile.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { ingest, listSrcSummary } from '../src/ingest.mjs';
import { detect }                  from '../src/detect.mjs';
import { compile }                 from '../src/compile.mjs';
import { backup }                  from '../src/backup.mjs';
import { writeManifest }           from '../src/manifest.mjs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ARK_ROOT     = path.resolve(__dirname, '..', '..');
const BUILDS_ROOT  = path.join(ARK_ROOT, 'builds');

function usage(exitCode = 0) {
  console.log(`ark-install — ARK-CORE Installer Engine

USAGE
  ark-install ingest  <source>      --as <build_name>
  ark-install detect  <build_name>
  ark-install compile <build_name>  [--profile <profile_id>]
  ark-install backup  <build_name>  [--format zip|tar.gz]
  ark-install run     <source>      --as <build_name>  [--profile <profile_id>]

SOURCES
  Git URL        https://github.com/<owner>/<repo>
  ZIP file       ./path/to/build.zip
  Folder         ./path/to/folder
  Bundle         ./path/to/build.tar.gz
  Raw file       ./path/to/file

Builds are stored under ${BUILDS_ROOT}/<build_name>/
`);
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (!args._[0]) usage(0);

try {
  switch (args._[0]) {
    case 'ingest':  await cmdIngest(args);  break;
    case 'detect':  await cmdDetect(args);  break;
    case 'compile': await cmdCompile(args); break;
    case 'backup':  await cmdBackup(args);  break;
    case 'run':     await cmdRun(args);     break;
    case '-h':
    case '--help':
    case 'help':    usage(0); break;
    default:
      console.error(`Unknown command: ${args._[0]}`);
      usage(1);
  }
} catch (e) {
  console.error('[ark-install] ERROR:', e.message);
  process.exit(1);
}

// ── Commands ────────────────────────────────────────────────────────
async function cmdIngest({ _ }) {
  const source     = _[1];
  const buildName  = required('--as', _);
  if (!source) throw new Error('Source is required. e.g. ark-install ingest <url> --as my-build');
  console.log(`[ingest] ${source} → builds/${buildName}/src/`);
  const r = await ingest({ source, buildName, buildsRoot: BUILDS_ROOT });
  console.log(`[ingest] OK  type=${r.input_type}  src=${r.src_dir}`);
  const top = await listSrcSummary(r.src_dir, 20);
  if (top.length) {
    console.log('[ingest] tree preview:');
    for (const f of top) console.log('   ' + path.relative(r.build_dir, f));
    if (top.length === 20) console.log('   …');
  }
}

async function cmdDetect({ _ }) {
  const buildName = _[1];
  if (!buildName) throw new Error('Build name required.');
  const buildDir  = path.join(BUILDS_ROOT, buildName);
  if (!existsSync(buildDir)) throw new Error(`No build at ${buildDir} — run ingest first.`);
  console.log(`[detect] scanning ${buildDir}/src/`);
  const det = await detect({ buildDir });
  console.log(`[detect] entry-points: ${det.entry_points.join(', ') || '(none)'}`);
  console.log(`[detect] apt:          ${det.dependencies.apt.join(', ') || '(none)'}`);
  console.log(`[detect] pip:          ${det.dependencies.pip.join(', ') || '(none)'}`);
  console.log(`[detect] hardware:     ${Object.entries(det.hardware).filter(([,v]) => v).map(([k]) => k).join(', ') || '(none)'}`);
  console.log(`[detect] architecture: ${det.architecture.join(', ')}`);
  // Persist a partial manifest so the next stage doesn't have to re-detect
  const { manifestFromDetection } = await import('../src/manifest.mjs');
  await writeManifest(buildDir, manifestFromDetection(det));
  console.log(`[detect] manifest written → ${path.join(buildDir, 'manifest.json')}`);
}

async function cmdCompile({ _, profile: profileId }) {
  const buildName = _[1];
  if (!buildName) throw new Error('Build name required.');
  const buildDir  = path.join(BUILDS_ROOT, buildName);
  if (!existsSync(buildDir)) throw new Error(`No build at ${buildDir} — run ingest first.`);

  // Re-detect so the manifest stays current (no stale data).
  console.log(`[compile] re-detecting ${buildDir}/src/`);
  const det = await detect({ buildDir });

  // Optional profile (e.g. raspyjack)
  let profile = null;
  if (profileId) {
    const p = path.join(BUILDS_ROOT, profileId, 'profile.json');
    if (!existsSync(p)) throw new Error(`Profile not found: ${p}`);
    profile = JSON.parse(await readFile(p, 'utf8'));
    console.log(`[compile] using profile: ${profile.name} (${profile.profile_id})`);
  }

  const out = await compile({ buildDir, detection: det, profile });
  console.log(`[compile] OK`);
  console.log(`   manifest → ${path.relative(ARK_ROOT, path.join(buildDir, 'manifest.json'))}`);
  console.log(`   plan     → ${path.relative(ARK_ROOT, out.plan_path)}`);
  console.log(`   script   → ${path.relative(ARK_ROOT, out.script_path)}`);
  console.log(`   log      → ${path.relative(ARK_ROOT, out.log_path)}`);
}

async function cmdBackup({ _, format }) {
  const buildName = _[1];
  if (!buildName) throw new Error('Build name required.');
  const buildDir  = path.join(BUILDS_ROOT, buildName);
  const r = await backup({ buildDir, format: format || 'tar.gz' });
  console.log(`[backup] archive: ${r.archive}`);
  console.log(`[backup] sha256:  ${r.sha256}`);
  console.log(`[backup] included: ${r.included.join(', ')}`);
}

async function cmdRun(args) {
  await cmdIngest(args);
  await cmdDetect({ _: ['detect', argValue(args, '--as')] });
  await cmdCompile({ _: ['compile', argValue(args, '--as')], profile: args.profile });
}

// ── Arg parser (tiny) ───────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  // common alias
  if (out.as) out['as'] = out.as;
  return out;
}

function required(flag, _) {
  // walk argv looking for the flag's value
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i+1]) throw new Error(`Missing required ${flag} <value>`);
  return process.argv[i+1];
}

function argValue(args, flag) {
  const k = flag.replace(/^--/, '');
  return args[k];
}
