// Detection Layer — scan a staged build's src/ and figure out:
//   - Which entry-point script to run, in priority order
//   - Which apt + pip packages it needs
//   - Which hardware interfaces it touches (SPI/I2C/GPIO/LCD)
//   - Which CPU architectures it supports (armv6/armv7/arm64)
//
// Best-effort but deterministic — same input always produces the same
// detection report.

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Priority list lives in one place; UI + manifest both read this.
export const ENTRY_POINT_PRIORITY = [
  'install.sh',
  'setup.sh',
  /^install_.+\.sh$/,
  'main.py',
  'app.py',
  'Makefile',
];

const HARDWARE_KEYWORDS = {
  spi: [/\bspi\b/i, /spidev/i, /raspi-config.*spi/i, /do_spi/i],
  i2c: [/\bi2c\b/i, /smbus/i, /raspi-config.*i2c/i, /do_i2c/i],
  gpio: [/\bgpio\b/i, /RPi\.GPIO/i, /gpiozero/i, /libgpiod/i],
  lcd: [/\blcd\b/i, /ssd1306/i, /luma\.lcd/i, /framebuffer/i, /\bst7735\b/i, /\bili9341\b/i, /\bpcd8544\b/i],
};

const APT_INSTALL_RX  = /apt(?:-get)?\s+install\s+(?:-y\s+)?(?:--no-install-recommends\s+)?([^\n#;|&]+)/gi;
const PIP_INSTALL_RX  = /pip3?\s+install\s+(?:--upgrade\s+)?(?:--user\s+)?(?:--break-system-packages\s+)?([^\n#;|&]+)/gi;

// English words that slip through the regex from log lines like
// `echo "pip install package may fail without …"`. Conservative list —
// only add words that are extremely unlikely to be real package names.
const PIP_STOP_WORDS = new Set([
  'package', 'packages', 'requirements', 'version', 'system', 'logger',
  'failed', 'restoring', 'using', 'with', 'without', 'work', 'may',
  'not', 'on', 'old', 'payload', 'relying',
]);
const APT_STOP_WORDS = new Set([
  'package', 'packages', 'apt', 'install',
]);

// Strip noise from shell text BEFORE matching install commands:
//  - whole-line comments
//  - the *contents* of quoted strings (so `echo "pip install foo"` doesn't
//    register as an install command)
// Quote bodies are replaced with empty content; the surrounding quotes
// stay so multi-line constructs don't shift.
function stripShellNoise(body) {
  body = body.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  body = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  body = body.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return body;
}

export async function detect({ buildDir }) {
  const srcDir = path.join(buildDir, 'src');
  if (!existsSync(srcDir)) {
    throw new Error(`No staged source at ${srcDir} — run ingest first.`);
  }

  const files = await walk(srcDir);
  const entryPoints = pickEntryPoints(files, srcDir);
  const deps        = await extractDependencies(files);
  const hardware    = await detectHardware(files);
  const arch        = await detectArchitecture(files);
  const meta        = await extractMeta(srcDir, files);

  return {
    name:          meta.name,
    version:       meta.version,
    type:          'pi-build',
    entry_points:  entryPoints,
    dependencies:  deps,
    hardware,
    architecture:  arch,
    files_scanned: files.length,
  };
}

// ── Entry points ─────────────────────────────────────────────────────
function pickEntryPoints(files, srcDir) {
  const rels = files.map(f => path.relative(srcDir, f));
  const matched = [];
  for (const pattern of ENTRY_POINT_PRIORITY) {
    const hits = rels.filter(r => matchesEntryPattern(r, pattern));
    // sort install_*.sh by mtime newest-first would be ideal, but we
    // can't easily get mtime here without re-statting; lexicographic
    // is good enough and deterministic.
    hits.sort();
    for (const h of hits) {
      if (!matched.includes(h)) matched.push(h);
    }
  }
  return matched;
}

function matchesEntryPattern(rel, pattern) {
  const base = path.basename(rel);
  if (pattern instanceof RegExp) return pattern.test(base);
  return base === pattern;
}

// ── Dependencies ─────────────────────────────────────────────────────
// Real-world shell scripts hide deps inside loops, arrays, and log
// strings. We accept some false negatives in exchange for keeping the
// dep set clean — the operator can always edit manifest.json before
// compile. A token must look like a package name (alpha-leading,
// [a-z0-9._-] only, 2-64 chars) to be accepted.
const PKG_TOKEN_RX = /^[a-zA-Z][a-zA-Z0-9._-]{1,63}$/;
async function extractDependencies(files) {
  const apt = new Set();
  const pip = new Set();

  // requirements.txt → pip
  for (const f of files) {
    if (path.basename(f) !== 'requirements.txt') continue;
    const lines = (await readFile(f, 'utf8')).split('\n');
    for (const raw of lines) {
      const line = raw.split('#')[0].trim();
      if (!line)              continue;
      if (line.startsWith('-')) continue;   // -r other.txt, --extra-index-url, etc.
      const name = stripPackageDecoration(line);
      if (name && PKG_TOKEN_RX.test(name)) pip.add(name);
    }
  }

  // shell scripts + Makefile → grep for apt-get install / pip install
  for (const f of files) {
    const base = path.basename(f);
    if (!/\.(sh|bash)$/i.test(f) && base !== 'Makefile') continue;
    let body;
    try { body = await readFile(f, 'utf8'); } catch { continue; }
    body = stripShellNoise(body);

    for (const m of body.matchAll(APT_INSTALL_RX)) {
      for (const pkg of splitPackages(m[1])) {
        if (APT_STOP_WORDS.has(pkg.toLowerCase())) continue;
        apt.add(pkg);
      }
    }
    for (const m of body.matchAll(PIP_INSTALL_RX)) {
      for (const pkg of splitPackages(m[1])) {
        if (PIP_STOP_WORDS.has(pkg.toLowerCase())) continue;
        pip.add(pkg);
      }
    }
  }

  return {
    apt: [...apt].sort(),
    pip: [...pip].sort(),
  };
}

function stripPackageDecoration(s) {
  // "Pillow>=10.0" → "Pillow"; "requests[security]" → "requests"
  return s.replace(/[<>=!~].*/, '').replace(/\[.*\]/, '').replace(/^['"]|['"]$/g, '').trim();
}

function splitPackages(blob) {
  const out = [];
  for (let tok of blob.split(/[\s\\]+/)) {
    tok = tok.trim();
    if (!tok) continue;
    // strip surrounding quotes and trailing commas/semicolons
    tok = tok.replace(/^['"]|['"]$/g, '').replace(/[,;]+$/, '');
    // reject shell metachars / variable refs / redirects
    if (/[\$\{\}\[\]<>&|()=\/]/.test(tok)) continue;
    if (tok.startsWith('-')) continue;        // flags
    if (/^\d+$/.test(tok))   continue;        // bare numbers
    if (/\.(txt|json|yml|yaml|cfg|conf|ini|md)$/i.test(tok)) continue;  // filenames, not pkgs
    tok = stripPackageDecoration(tok);
    if (PKG_TOKEN_RX.test(tok)) out.push(tok);
  }
  return out;
}

// ── Hardware ─────────────────────────────────────────────────────────
async function detectHardware(files) {
  // Default: GPIO assumed on (it's the headline Pi feature, almost
  // every build at least imports it). SPI/I2C/LCD default off.
  const flags = { spi: false, i2c: false, gpio: true, lcd: false };

  for (const f of files) {
    if (!/\.(py|sh|cfg|conf|ini|md|txt|json|yaml|yml)$/i.test(f)) continue;
    let body;
    try { body = await readFile(f, 'utf8'); } catch { continue; }
    for (const [flag, patterns] of Object.entries(HARDWARE_KEYWORDS)) {
      if (flags[flag]) continue;
      for (const p of patterns) {
        if (p.test(body)) { flags[flag] = true; break; }
      }
    }
  }
  return flags;
}

// ── Architecture ─────────────────────────────────────────────────────
// Default-permissive: pure-Python / shell builds work on every arch.
// Narrow only when we find compiled artifacts (.so files) whose ELF
// header pins them to a specific machine. ELF parsing is just the
// first 20 bytes of the file, so this is fast even on big trees.
async function detectArchitecture(files) {
  let armv6 = true, armv7 = true, arm64 = true;
  const soFiles = [];

  for (const f of files) {
    const base = path.basename(f);
    if (base === 'package.json') {
      try {
        const j = JSON.parse(await readFile(f, 'utf8'));
        if (j.cpu && Array.isArray(j.cpu)) {
          if (!j.cpu.includes('arm'))   armv6 = armv7 = false;
          if (!j.cpu.includes('arm64')) arm64 = false;
        }
      } catch {}
    }
    if (base.endsWith('.so') || /\.so\.\d+/.test(base)) {
      soFiles.push(f);
    }
  }

  // Read ELF e_machine field from each .so. If ANY .so is arm64-only,
  // drop armv6/v7 (they can't run it). If ANY .so is armv7, drop
  // armv6. We can't run heterogeneous binaries from one package; the
  // narrowest .so is the binding constraint.
  if (soFiles.length > 0) {
    const machines = new Set();
    for (const f of soFiles.slice(0, 30)) {  // cap for big vendor trees
      try {
        const fh = await import('node:fs/promises');
        const buf = Buffer.alloc(20);
        const file = await fh.open(f, 'r');
        try {
          await file.read(buf, 0, 20, 0);
          if (buf[0] !== 0x7f || buf.toString('ascii', 1, 4) !== 'ELF') continue;
          const eiClass = buf[4];                 // 1=32-bit, 2=64-bit
          // e_machine is little-endian uint16 at offset 18 (assumes
          // ELFDATA2LSB which is the only relevant endian for arm).
          const eMachine = buf.readUInt16LE(18);
          if (eMachine === 40) machines.add(eiClass === 2 ? 'arm64' : 'armv7');  // EM_ARM (often armv7 on Pi 3/4 32-bit)
          else if (eMachine === 183) machines.add('arm64');  // EM_AARCH64
        } finally { await file.close(); }
      } catch { /* unreadable .so — skip */ }
    }
    if (machines.size > 0) {
      if (machines.has('arm64') && !machines.has('armv7')) {
        armv6 = armv7 = false;  // only arm64 binaries present
      } else if (machines.has('armv7') && !machines.has('arm64')) {
        armv6 = false;  // armv7 binaries; armv6 incompatible
      }
      // mixed → keep permissive (operator likely has fat / multi-arch builds)
    }
  }
  return [armv6 && 'armv6', armv7 && 'armv7', arm64 && 'arm64'].filter(Boolean);
}

// ── Build metadata ───────────────────────────────────────────────────
// Prefer root-level metadata over anything nested under vendor/, third_party/,
// node_modules/ etc. so a forked-in dependency doesn't masquerade as the
// build's own identity.
async function extractMeta(srcDir, files) {
  const meta = { name: null, version: 'auto-detected' };

  const VENDOR_DIR_RX = /(^|\/)(vendor|third_party|node_modules|submodules|deps|lib(?:s)?)\//;
  const isRootIsh = (f) => {
    const rel = path.relative(srcDir, f);
    if (VENDOR_DIR_RX.test(rel)) return false;
    return rel.split(path.sep).length <= 2;  // root or one subdir down
  };
  const byDepth = (a, b) => relDepth(a, srcDir) - relDepth(b, srcDir);
  const pkgJsons    = files.filter(f => path.basename(f) === 'package.json'  && isRootIsh(f)).sort(byDepth);
  const pyprojects  = files.filter(f => path.basename(f) === 'pyproject.toml' && isRootIsh(f)).sort(byDepth);
  const setupPys    = files.filter(f => path.basename(f) === 'setup.py'      && isRootIsh(f)).sort(byDepth);

  for (const f of pkgJsons) {
    try {
      const j = JSON.parse(await readFile(f, 'utf8'));
      if (!meta.name    && j.name)    meta.name    = j.name;
      if (j.version && meta.version === 'auto-detected') meta.version = j.version;
    } catch {}
    if (meta.name) break;
  }
  for (const f of pyprojects) {
    if (meta.name) break;
    try {
      const body = await readFile(f, 'utf8');
      const n = body.match(/^name\s*=\s*"([^"]+)"/m);
      const v = body.match(/^version\s*=\s*"([^"]+)"/m);
      if (n) meta.name = n[1];
      if (v && meta.version === 'auto-detected') meta.version = v[1];
    } catch {}
  }
  for (const f of setupPys) {
    if (meta.name) break;
    try {
      const body = await readFile(f, 'utf8');
      const n = body.match(/name\s*=\s*['"]([^'"]+)['"]/);
      if (n) meta.name = n[1];
    } catch {}
  }
  // Repo / build dir name as final fallback
  if (!meta.name) meta.name = path.basename(srcDir.replace(/\/src$/, ''));
  return meta;
}

function relDepth(file, root) {
  return path.relative(root, file).split(path.sep).length;
}

// ── Walk helper ──────────────────────────────────────────────────────
async function walk(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}
