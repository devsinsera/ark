#!/usr/bin/env node
// Ark Builder — Linux-side image compiler.
//
// Subcommands:
//   render  — Phase 1: read a plan.json, emit dietpi.txt + autostart
//   build   — Phase 3: full image build (chroot + apt + repack) — stub
//   plan    — Convenience: stringify a manifest into a build plan
//             (browser does this too; CLI parity for CI workflows)

import { argv, exit, stderr, stdout } from 'node:process';
import { renderPlan } from './lib/render.mjs';
import { buildImage } from './lib/build.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next; i++;
      }
    } else args._.push(a);
  }
  return args;
}

function usage() {
  stdout.write(`ark-builder — Ark device image compiler (Linux)

Usage:
  ark-builder render --plan <plan.json> --out <dir>
  ark-builder build  --plan <plan.json> --base <image.img> --out <dir>

Subcommands:
  render    Phase 1. Read a build plan, write dietpi.txt + Automation_Custom_Script.sh.
            No root required. Equivalent to what the browser UI produces.
  build     Phase 3. Full pipeline: mount base image, chroot, apt-install, repack.
            Linux only. Requires sudo + qemu-user-static + losetup. STUB FOR NOW.

Options:
  --plan <path>     JSON build plan emitted by the browser UI.
  --base <path>     Base DietPi .img to start from (build only).
  --out  <dir>      Output directory (created if missing).
  --help            Show this message.
`);
}

async function main() {
  const args = parseArgs(argv.slice(2));
  if (args.help || args._.length === 0) { usage(); exit(0); }

  const sub = args._[0];

  if (sub === 'render') {
    if (!args.plan || !args.out) {
      stderr.write('ark-builder render: --plan and --out are required.\n');
      exit(2);
    }
    const result = await renderPlan({ planPath: args.plan, outDir: args.out });
    stdout.write(`✔ Rendered ${result.files.length} files into ${args.out}\n`);
    for (const f of result.files) stdout.write(`    ${f}\n`);
    exit(0);
  }

  if (sub === 'build') {
    if (!args.plan || !args.base || !args.out) {
      stderr.write('ark-builder build: --plan, --base, and --out are required.\n');
      exit(2);
    }
    const result = await buildImage({ planPath: args.plan, basePath: args.base, outDir: args.out });
    if (!result.ok) {
      stderr.write(`✖ Build failed: ${result.error || 'unknown'}\n`);
      exit(1);
    }
    stdout.write(`✔ Built image at ${result.imagePath}\n`);
    exit(0);
  }

  stderr.write(`ark-builder: unknown subcommand "${sub}"\n`);
  usage();
  exit(2);
}

main().catch(err => {
  stderr.write(`✖ ${err.message || err}\n`);
  if (process.env.DEBUG) stderr.write(err.stack + '\n');
  exit(1);
});
