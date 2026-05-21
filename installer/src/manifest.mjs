// Manifest System — every build has a manifest.json. The engine
// auto-generates one from a detection report; if a build ships its
// own manifest.json in src/, the engine reconciles (operator values
// win for top-level fields; detection fills in the gaps).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

export const ALL_ARCHITECTURES = ['armv6', 'armv7', 'arm64'];

/**
 * Build a manifest object from a detection report.
 * Pure function — no I/O. Lets us snapshot-test it.
 */
export function manifestFromDetection(detection) {
  return {
    schema_version: SCHEMA_VERSION,
    name:           detection.name,
    version:        detection.version || 'auto-detected',
    type:           detection.type    || 'pi-build',
    entry_points:   detection.entry_points || [],
    dependencies: {
      apt: detection.dependencies?.apt || [],
      pip: detection.dependencies?.pip || [],
    },
    hardware: {
      spi:  !!detection.hardware?.spi,
      i2c:  !!detection.hardware?.i2c,
      gpio: detection.hardware?.gpio !== false,  // default true
      lcd:  !!detection.hardware?.lcd,
    },
    architecture: detection.architecture?.length
      ? detection.architecture
      : [...ALL_ARCHITECTURES],
  };
}

/**
 * Read an existing manifest.json from the build's staged src/, if
 * present. Returns null if none.
 */
export async function readShippedManifest(buildDir) {
  const candidate = path.join(buildDir, 'src', 'manifest.json');
  if (!existsSync(candidate)) return null;
  try {
    return JSON.parse(await readFile(candidate, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reconcile a shipped manifest with the engine's detection report.
 * Operator-shipped values take precedence; detection fills the gaps.
 * Returns the merged manifest.
 */
export function reconcileManifest(shipped, detected) {
  if (!shipped) return detected;
  const out = { ...detected };
  for (const k of Object.keys(shipped)) {
    if (k === 'dependencies') {
      out.dependencies = {
        apt: dedupe([...(shipped.dependencies?.apt || []), ...(detected.dependencies?.apt || [])]),
        pip: dedupe([...(shipped.dependencies?.pip || []), ...(detected.dependencies?.pip || [])]),
      };
    } else if (k === 'hardware') {
      out.hardware = { ...detected.hardware, ...shipped.hardware };
    } else if (k === 'architecture') {
      out.architecture = shipped.architecture;
    } else {
      out[k] = shipped[k];
    }
  }
  return out;
}

function dedupe(arr) { return [...new Set(arr)].sort(); }

/**
 * Validate a manifest. Returns { ok, errors[] }.
 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (!m.name)                     errors.push('name missing');
  if (!Array.isArray(m.entry_points)) errors.push('entry_points must be an array');
  if (!m.dependencies || typeof m.dependencies !== 'object') errors.push('dependencies missing');
  if (!m.hardware     || typeof m.hardware     !== 'object') errors.push('hardware missing');
  if (!Array.isArray(m.architecture)) errors.push('architecture must be an array');
  for (const a of m.architecture || []) {
    if (!ALL_ARCHITECTURES.includes(a)) errors.push(`unknown architecture: ${a}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Persist manifest.json to the build directory.
 */
export async function writeManifest(buildDir, manifest) {
  await writeFile(path.join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
