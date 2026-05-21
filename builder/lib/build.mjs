// Phase 3 — image builder.
//
// Pipeline at a glance:
//
//   manifest      Installer Engine            chroot-run.sh
//   ───────  →   render → install.plan.sh →  (in Linux container)
//                                              ↓
//                                            new .img with apt+pip
//                                            pre-installed
//
// macOS hosts (where the operator typically lives) cannot do loop
// devices + chroot natively, so this orchestrator runs the chroot
// pipeline inside a small Linux container. Apple Silicon runs the
// container natively (no emulation); x86 hosts emulate arm64 via
// qemu-user-static inside the chroot.
//
// Prerequisites the operator must have:
//   - Docker available (Docker Desktop OR Colima OR podman aliased)
//   - The base .img already downloaded (no implicit fetch — this is
//     dual-use territory and we don't decide what gets baked in)
//
// Outputs:
//   <outDir>/ark-built.img        — final image, ready to flash
//   <outDir>/ark-built.sha256     — content hash
//   <outDir>/ark-build.log        — every line of chroot-run output

import { spawn } from 'node:child_process';
import { promises as fs, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILDER_ROOT = path.resolve(__dirname, '..');
const IMAGE_TAG = 'ark-builder:0.1';

export async function buildImage({ planPath, basePath, outDir, runner = 'docker', skipInstall = false }) {
  // ── 1. Validate inputs ──────────────────────────────────────────
  const errors = [];
  if (!planPath || !existsSync(planPath)) errors.push(`plan not found: ${planPath}`);
  if (!basePath || !existsSync(basePath)) errors.push(`base image not found: ${basePath}`);
  if (!outDir) errors.push('outDir is required');
  if (errors.length) return { ok: false, error: errors.join('; ') };

  await fs.mkdir(outDir, { recursive: true });
  const outImg  = path.join(path.resolve(outDir), 'ark-built.img');
  const outLog  = path.join(path.resolve(outDir), 'ark-build.log');
  const outSha  = path.join(path.resolve(outDir), 'ark-built.sha256');
  const basePathAbs = path.resolve(basePath);
  const planPathAbs = path.resolve(planPath);

  // ── 2. Check runtime availability ───────────────────────────────
  const runtime = await detectRuntime(runner);
  if (!runtime.ok) {
    return { ok: false, error: runtime.error, hint: runtime.hint };
  }
  console.log(`[builder] using container runtime: ${runtime.cmd}`);

  // ── 3. Build the ark-builder image (cached after first run) ─────
  console.log(`[builder] preparing ark-builder image…`);
  const buildOk = await runStreaming(runtime.cmd,
    ['build', '-t', IMAGE_TAG, '-f', path.join(BUILDER_ROOT, 'Dockerfile.arkbuild'), BUILDER_ROOT],
    outLog, { append: false }
  );
  if (!buildOk.ok) return { ok: false, error: 'docker build failed (see ' + outLog + ')' };

  // ── 4. x86 hosts need binfmt registered so they can run arm64
  //       binaries inside the chroot. Apple Silicon skips this.
  if (process.arch !== 'arm64') {
    console.log('[builder] x86 host — registering binfmt for arm64 emulation');
    await runStreaming(runtime.cmd,
      ['run', '--privileged', '--rm', 'tonistiigi/binfmt:latest', '--install', 'arm64'],
      outLog, { append: true }
    );
  }

  // ── 5. Run the chroot pipeline ──────────────────────────────────
  // Mount strategy:
  //   - basePath dir → /work/base   (read-only)
  //   - planPath dir → /work/plan   (read-only)
  //   - outDir       → /work/out    (read-write; final .img lands here)
  const baseDir  = path.dirname(basePathAbs);
  const planDir  = path.dirname(planPathAbs);
  const baseName = path.basename(basePathAbs);
  const planName = path.basename(planPathAbs);

  const args = [
    'run', '--rm', '--privileged',
    '-v', `${baseDir}:/work/base:ro`,
    '-v', `${planDir}:/work/plan:ro`,
    '-v', `${path.resolve(outDir)}:/work/out`,
  ];
  if (skipInstall) args.push('-e', 'ARK_SKIP_INSTALL=1');

  args.push(IMAGE_TAG,
    `/work/base/${baseName}`,
    `/work/plan/${planName}`,
    `/work/out/ark-built.img`,
  );

  console.log('[builder] entering chroot pipeline (this can take several minutes)…');
  const runOk = await runStreaming(runtime.cmd, args, outLog, { append: true });
  if (!runOk.ok) return { ok: false, error: 'chroot pipeline failed (see ' + outLog + ')' };

  // ── 6. Hash the output ──────────────────────────────────────────
  if (!existsSync(outImg)) return { ok: false, error: 'pipeline finished but output image is missing' };
  const sha = await sha256File(outImg);
  await fs.writeFile(outSha, `${sha}  ${path.basename(outImg)}\n`);

  return {
    ok: true,
    out_img:  outImg,
    sha256:   sha,
    log_file: outLog,
    sha_file: outSha,
  };
}

// Quick host-check used by `ark-builder check`. Reports what we can
// see without modifying anything.
export async function checkHost() {
  const out = {
    host_arch:  process.arch,
    host_os:    process.platform,
    docker:     await hasCommand('docker'),
    podman:     await hasCommand('podman'),
    colima:     await hasCommand('colima'),
  };
  out.has_runtime = out.docker || out.podman;
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function detectRuntime(preferred) {
  if (preferred && preferred !== 'docker') {
    const ok = await hasCommand(preferred);
    if (ok) return { ok: true, cmd: preferred };
    return { ok: false, error: `runtime "${preferred}" not on PATH`, hint: installHint() };
  }
  for (const cmd of ['docker', 'podman']) {
    if (await hasCommand(cmd)) return { ok: true, cmd };
  }
  return { ok: false, error: 'no container runtime found', hint: installHint() };
}

function installHint() {
  return [
    'The image builder runs inside a Linux container.',
    'Install one of:',
    '  • Colima (recommended, lightweight): brew install colima docker && colima start',
    '  • Docker Desktop:                    https://docker.com/products/docker-desktop',
    '  • Podman:                            brew install podman && podman machine init && podman machine start',
    'Then re-run: node ark-builder.mjs build …',
  ].join('\n  ');
}

function hasCommand(cmd) {
  return new Promise((resolve) => {
    const p = spawn('which', [cmd], { stdio: 'ignore' });
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// Run a child process, stream stdout+stderr live to terminal AND
// append to a log file. Resolves { ok, code }.
async function runStreaming(cmd, args, logPath, { append = true } = {}) {
  if (!append) await fs.writeFile(logPath, `# ark-build.log — started ${new Date().toISOString()}\n# ${cmd} ${args.join(' ')}\n\n`);
  const fh = await fs.open(logPath, 'a');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk) => {
      process.stdout.write(chunk);
      fh.write(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      fh.close();
      resolve({ ok: code === 0, code });
    });
    child.on('error', (e) => {
      fh.write(`\nspawn error: ${e.message}\n`).then(() => fh.close());
      resolve({ ok: false, code: -1, error: e.message });
    });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(file);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
