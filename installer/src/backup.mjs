// Backup — wrap a build into a portable tar.gz that contains
// everything needed to re-deploy or restore on another machine.
//
// Includes:
//   src/             — normalised source
//   config/          — Ark-managed config
//   manifest.json    — build manifest
//   install.log      — engine log
//   install.plan.json — last compiled plan
//   apt.installed.txt — snapshot of installed apt packages (from the Pi via Agent)
//   pip.freeze.txt    — snapshot of pip freeze (from the Pi via Agent)
//
// Pi-side dependency snapshots are present only if the Agent has
// posted them back — they're optional. Backups never include
// credentials, SSH keys, or WiFi passwords.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const sh = promisify(exec);

export async function backup({ buildDir, format = 'tar.gz', outDir }) {
  if (!existsSync(buildDir)) throw new Error(`Build directory not found: ${buildDir}`);
  const name      = path.basename(buildDir);
  const outRoot   = outDir || path.join(buildDir, 'exports');
  await mkdir(outRoot, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext   = format === 'zip' ? 'zip' : 'tar.gz';
  const out   = path.join(outRoot, `${name}-${stamp}.${ext}`);

  const parts = [
    'src',
    'scripts',
    'config',
    'manifest.json',
    'install.log',
    'install.plan.json',
    'install.plan.sh',
    'apt.installed.txt',
    'pip.freeze.txt',
  ].filter(p => existsSync(path.join(buildDir, p)));

  if (parts.length === 0) {
    throw new Error(`Nothing to back up in ${buildDir} — run ingest + detect + compile first.`);
  }

  if (format === 'zip') {
    await sh(
      `cd ${quote(buildDir)} && zip -r -q ${quote(out)} ${parts.map(quote).join(' ')}`,
      { maxBuffer: 64 * 1024 * 1024 }
    );
  } else {
    await sh(
      `tar -czf ${quote(out)} -C ${quote(buildDir)} ${parts.map(quote).join(' ')}`,
      { maxBuffer: 64 * 1024 * 1024 }
    );
  }

  const { stdout } = await sh(`shasum -a 256 ${quote(out)}`);
  const sha256 = stdout.split(/\s+/)[0];
  return { archive: out, sha256, included: parts };
}

function quote(s) {
  const str = String(s);
  if (str.includes("'")) throw new Error(`Refusing path with single quote: ${str}`);
  return `'${str}'`;
}
