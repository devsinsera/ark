// Input Layer — normalise any of git / zip / folder / bundle / raw tree
// into a build's src/ directory. Returns the staging path.
//
// Pure stdlib + shell tools (git, unzip, tar, cp). No npm deps so the
// engine can run on a fresh clone with just `node`.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const sh = promisify(exec);

export const INPUT_TYPES = ['git', 'zip', 'folder', 'bundle', 'raw'];

/**
 * Detect what kind of input we're being handed.
 *   - https://… or git@…           → 'git'
 *   - ends in .zip                  → 'zip'
 *   - ends in .tar.gz / .tgz        → 'bundle'
 *   - existing directory            → 'folder'
 *   - existing single file (other)  → 'raw'
 */
export async function detectInputType(source) {
  if (/^https?:\/\//i.test(source) || /^git@/.test(source) || source.endsWith('.git')) {
    return 'git';
  }
  if (source.endsWith('.zip')) return 'zip';
  if (source.endsWith('.tar.gz') || source.endsWith('.tgz') || source.endsWith('.tar')) {
    return 'bundle';
  }
  if (existsSync(source)) {
    const s = await stat(source);
    if (s.isDirectory()) return 'folder';
    return 'raw';
  }
  throw new Error(`Could not classify input: ${source}`);
}

/**
 * Ingest a source into the build's staging directory.
 * Returns { build_dir, src_dir, input_type, source_resolved }.
 *
 * Idempotent: re-running blows away the existing src/ and re-stages.
 * (We never silently merge — would produce non-deterministic builds.)
 */
export async function ingest({ source, buildName, buildsRoot }) {
  if (!buildName) throw new Error('buildName is required');
  if (!source)    throw new Error('source is required');

  const inputType = await detectInputType(source);
  const buildDir  = path.resolve(buildsRoot, buildName);
  const srcDir    = path.join(buildDir, 'src');

  // Wipe + recreate src/ to keep ingestion deterministic.
  if (existsSync(srcDir)) {
    await rm(srcDir, { recursive: true, force: true });
  }
  await mkdir(path.join(buildDir, 'scripts'), { recursive: true });
  await mkdir(path.join(buildDir, 'config'),  { recursive: true });
  await mkdir(srcDir,                          { recursive: true });

  switch (inputType) {
    case 'git':    await ingestGit(source, srcDir);    break;
    case 'zip':    await ingestZip(source, srcDir);    break;
    case 'bundle': await ingestBundle(source, srcDir); break;
    case 'folder': await ingestFolder(source, srcDir); break;
    case 'raw':    await ingestRaw(source, srcDir);    break;
    default: throw new Error(`Unknown input type: ${inputType}`);
  }

  const sourceResolved = await resolveSourceMetadata(inputType, source, srcDir);
  return { build_dir: buildDir, src_dir: srcDir, input_type: inputType, source: sourceResolved };
}

async function ingestGit(url, dest) {
  // shallow clone keeps things fast; users can deepen later if they need history
  await sh(`git clone --depth 1 ${quote(url)} ${quote(dest)}`, { maxBuffer: 32 * 1024 * 1024 });
  // strip .git so the staging tree is pure source
  await rm(path.join(dest, '.git'), { recursive: true, force: true });
}

async function ingestZip(zipPath, dest) {
  await sh(`unzip -q ${quote(path.resolve(zipPath))} -d ${quote(dest)}`, { maxBuffer: 32 * 1024 * 1024 });
  await collapseSingleTopDir(dest);
}

async function ingestBundle(tarPath, dest) {
  await sh(`tar -xzf ${quote(path.resolve(tarPath))} -C ${quote(dest)}`, { maxBuffer: 32 * 1024 * 1024 });
  await collapseSingleTopDir(dest);
}

async function ingestFolder(folderPath, dest) {
  // Use cp -R to preserve the tree shape. Trailing /. copies contents, not the dir itself.
  await sh(`cp -R ${quote(path.resolve(folderPath))}/. ${quote(dest)}/`);
}

async function ingestRaw(filePath, dest) {
  // single file → drop it into src/ as-is
  await sh(`cp ${quote(path.resolve(filePath))} ${quote(dest)}/`);
}

/**
 * When zip/tar contains a single top-level directory (the common case
 * for GitHub release archives), promote its contents up so the layout
 * matches a git clone.
 */
async function collapseSingleTopDir(dest) {
  const { stdout } = await sh(`ls -1 ${quote(dest)}`);
  const entries = stdout.trim().split('\n').filter(Boolean);
  if (entries.length === 1) {
    const inner = path.join(dest, entries[0]);
    const s = await stat(inner);
    if (s.isDirectory()) {
      await sh(`cp -R ${quote(inner)}/. ${quote(dest)}/ && rm -rf ${quote(inner)}`);
    }
  }
}

async function resolveSourceMetadata(inputType, source, srcDir) {
  const meta = { type: inputType, original: source };
  if (inputType === 'git') {
    try {
      // git clone strips the upstream URL when we delete .git/, so capture it ourselves
      meta.git_url = source;
    } catch { /* best effort */ }
  } else {
    try {
      const s = await stat(source);
      meta.size_bytes = s.size;
    } catch { /* path may have been a URL */ }
  }
  return meta;
}

// Safe-ish shell quoting. Source paths are operator-supplied; we
// reject anything with single quotes outright rather than try to
// escape them perfectly.
function quote(s) {
  const str = String(s);
  if (str.includes("'")) {
    throw new Error(`Refusing to handle path with single quote: ${str}`);
  }
  return `'${str}'`;
}

/**
 * Quick listing of the staging tree (used by `ark-install ingest` to
 * give the operator a sanity check that the package landed correctly).
 */
export async function listSrcSummary(srcDir, max = 30) {
  const { stdout } = await sh(`find ${quote(srcDir)} -maxdepth 3 -type f | head -n ${max}`);
  return stdout.trim().split('\n').filter(Boolean);
}
