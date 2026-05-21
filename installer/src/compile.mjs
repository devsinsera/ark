// Execution Pipeline — INIT → VALIDATE → PREPARE → INSTALL → CONFIGURE → FINALISE
//
// The engine itself doesn't execute on the Pi. It compiles a
// deterministic install plan (bash script + JSON audit record) that
// the Pi runs at first boot via DietPi's Automation_Custom_Script.sh
// hook.
//
// Each stage produces a typed step record; the script renderer turns
// records into bash. Same input → same output.

import { writeFile, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { manifestFromDetection, reconcileManifest, readShippedManifest, validateManifest, writeManifest, ALL_ARCHITECTURES } from './manifest.mjs';

const BASE_PACKAGES = ['git', 'python3', 'python3-pip', 'curl', 'ca-certificates'];

export const STAGES = ['init', 'validate', 'prepare', 'install', 'configure', 'finalise'];

/**
 * Compile a build into an install plan.
 * @param {object} opts
 * @param {string} opts.buildDir         — absolute path to builds/<name>/
 * @param {object} opts.detection        — detection report from detect()
 * @param {object} [opts.profile]        — optional build profile (e.g. raspyjack)
 * @param {string} [opts.targetArch]     — operator-chosen target arch (default: arm64)
 * @returns {Promise<{ manifest, plan, plan_path, script_path, log_path }>}
 */
export async function compile({ buildDir, detection, profile, targetArch = 'arm64' }) {
  const log = openLog(buildDir);
  await log.write(`compile started @ ${new Date().toISOString()}`);

  // ── INIT ──
  await log.stage('init');
  const shipped = await readShippedManifest(buildDir);
  let manifest = manifestFromDetection(detection);
  manifest = reconcileManifest(shipped, manifest);
  if (profile?.name && !manifest.profile) manifest.profile = profile.name;
  await writeManifest(buildDir, manifest);
  await log.write(`manifest: ${manifest.name}@${manifest.version}, ${manifest.entry_points.length} entry-points, ${manifest.dependencies.apt.length} apt + ${manifest.dependencies.pip.length} pip`);

  // ── VALIDATE ──
  await log.stage('validate');
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    await log.write(`validation failed: ${validation.errors.join(', ')}`);
    throw new Error(`Manifest validation failed: ${validation.errors.join(', ')}`);
  }
  if (!manifest.architecture.includes(targetArch)) {
    await log.write(`WARN: target arch ${targetArch} not in supported set [${manifest.architecture.join(',')}] — operator override required`);
  }
  if (manifest.entry_points.length === 0) {
    await log.write(`WARN: no entry-points detected — plan will FALLBACK_MANUAL`);
  }

  // ── PREPARE / INSTALL / CONFIGURE / FINALISE ──
  // Build a typed step list. The renderer (renderPlanScript below)
  // turns this into the actual first-boot bash.
  const steps = [];

  // PREPARE
  steps.push({ stage: 'prepare', type: 'apt.install', packages: dedupe([...BASE_PACKAGES, ...manifest.dependencies.apt]) });
  if (manifest.dependencies.pip.length > 0) {
    steps.push({ stage: 'prepare', type: 'pip.install', packages: manifest.dependencies.pip });
  }

  // INSTALL — runs the resolved entry point. If multiple, run only
  // the highest-priority one; the rest are recorded but not executed.
  const chosenEntry = manifest.entry_points[0] || null;
  if (chosenEntry) {
    steps.push({
      stage:       'install',
      type:        runnerTypeFor(chosenEntry),
      entry_point: chosenEntry,
      working_dir: '/ark/builds/' + manifest.name + '/src',
    });
  } else {
    steps.push({ stage: 'install', type: 'fallback.manual', reason: 'no entry-point detected' });
  }

  // CONFIGURE — hardware enablement
  if (manifest.hardware.spi)  steps.push({ stage: 'configure', type: 'raspi-config', op: 'do_spi'  });
  if (manifest.hardware.i2c)  steps.push({ stage: 'configure', type: 'raspi-config', op: 'do_i2c'  });
  // GPIO doesn't need raspi-config; it's always available
  if (manifest.hardware.lcd)  steps.push({ stage: 'configure', type: 'note', text: 'LCD hardware referenced — verify drivers in entry-point' });
  steps.push({ stage: 'configure', type: 'chmod.recursive', path: '/ark/builds/' + manifest.name + '/src', mode: '+x', filter: '*.sh' });

  if (profile?.services?.auto_start_on_boot) {
    steps.push({
      stage: 'configure',
      type:  'systemd.unit',
      name:  profile.services.systemd_unit_name || manifest.name,
      exec:  chosenEntry ? `/ark/builds/${manifest.name}/src/${chosenEntry}` : null,
      user:  profile.services.user || 'root',
      restart: profile.services.restart_policy || 'on-failure',
    });
  }

  // FINALISE — register the build with the Ark Agent (file marker;
  // the Agent picks it up on next telemetry tick and reports back to
  // the Hub)
  steps.push({
    stage: 'finalise',
    type:  'register',
    path:  '/ark/registry/' + manifest.name + '.json',
    payload: {
      name:        manifest.name,
      version:     manifest.version,
      installed_at: '$INSTALLED_AT',   // bash will interpolate
      entry_point: chosenEntry,
      profile:     profile?.name || null,
    },
  });

  const plan = {
    schema_version: 1,
    build_name:    manifest.name,
    target_arch:   targetArch,
    base_packages: BASE_PACKAGES,
    chosen_entry_point: chosenEntry,
    stages: STAGES,
    steps,
    generated_at: new Date().toISOString(),
  };

  // Render artefacts
  const planPath   = path.join(buildDir, 'install.plan.json');
  const scriptPath = path.join(buildDir, 'install.plan.sh');
  await writeFile(planPath,   JSON.stringify(plan, null, 2) + '\n');
  await writeFile(scriptPath, renderPlanScript(plan, manifest), { mode: 0o755 });

  await log.stage('finalise');
  await log.write(`plan written: ${planPath}`);
  await log.write(`script written: ${scriptPath}`);
  await log.write(`compile complete @ ${new Date().toISOString()}`);

  return {
    manifest,
    plan,
    plan_path:   planPath,
    script_path: scriptPath,
    log_path:    log.file,
  };
}

function runnerTypeFor(entry) {
  if (entry.endsWith('.py'))  return 'exec.python';
  if (entry === 'Makefile')   return 'exec.make';
  return 'exec.bash';
}

function dedupe(arr) { return [...new Set(arr)].filter(Boolean).sort(); }

// ── Plan script renderer ────────────────────────────────────────────
// Produces the bash script that the Pi runs at first boot. The script
// is generated deterministically from `plan`; same plan → same bytes.
function renderPlanScript(plan, manifest) {
  const lines = [];
  lines.push('#!/bin/bash');
  lines.push('# Auto-generated by ARK Installer Engine. DO NOT EDIT — re-compile from manifest.');
  lines.push(`# Build:   ${manifest.name}@${manifest.version}`);
  lines.push(`# Plan:    ${plan.generated_at}`);
  lines.push(`# Target:  ${plan.target_arch}`);
  lines.push('set -e');
  lines.push('set -o pipefail');
  lines.push('');
  lines.push('LOG=/var/log/ark-install.log');
  lines.push('INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)');
  lines.push('mkdir -p /ark/builds /ark/registry');
  lines.push('echo "[ark] install plan begin: ' + manifest.name + '" | tee -a "$LOG"');
  lines.push('');

  // Helper functions
  lines.push('ark_log()      { echo "[ark][$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }');
  lines.push('ark_run()      { ark_log "RUN: $*"; "$@" 2>&1 | tee -a "$LOG"; }');
  lines.push('ark_ensure_bin(){ command -v "$1" >/dev/null 2>&1 || ark_run apt-get install -y "$1"; }');
  lines.push('');
  lines.push('# Bootstrap: make sure apt itself is usable');
  lines.push('ark_run apt-get update -y || true');
  lines.push('');

  for (const stage of plan.stages) {
    const stageSteps = plan.steps.filter(s => s.stage === stage);
    if (stageSteps.length === 0) continue;
    lines.push(`# ── STAGE: ${stage.toUpperCase()} ──`);
    lines.push(`ark_log "stage:${stage}"`);
    for (const step of stageSteps) lines.push(renderStep(step));
    lines.push('');
  }

  lines.push('ark_log "install plan complete: ' + manifest.name + '"');
  lines.push('exit 0');
  return lines.join('\n') + '\n';
}

function renderStep(s) {
  switch (s.type) {
    case 'apt.install':
      return `ark_run apt-get install -y ${s.packages.map(shellQuote).join(' ')}`;
    case 'pip.install':
      return `ark_run pip3 install --break-system-packages ${s.packages.map(shellQuote).join(' ')}`;
    case 'exec.bash':
      return `cd ${shellQuote(s.working_dir)} && chmod +x ${shellQuote(s.entry_point)} && ark_run bash ./${s.entry_point}`;
    case 'exec.python':
      return `cd ${shellQuote(s.working_dir)} && ark_run python3 ./${s.entry_point}`;
    case 'exec.make':
      return `cd ${shellQuote(s.working_dir)} && ark_run make install`;
    case 'fallback.manual':
      return `ark_log "FALLBACK_MANUAL: ${s.reason}. Operator must SSH in and install by hand."`;
    case 'raspi-config':
      return `ark_run raspi-config nonint ${s.op} 0`;
    case 'chmod.recursive':
      return `find ${shellQuote(s.path)} -name '${s.filter}' -exec chmod ${s.mode} {} +`;
    case 'note':
      return `ark_log "NOTE: ${s.text.replace(/"/g, '\\"')}"`;
    case 'systemd.unit':
      return renderSystemdUnit(s);
    case 'register':
      return renderRegister(s);
    default:
      return `ark_log "WARN: unknown step type: ${s.type}"`;
  }
}

function renderSystemdUnit(s) {
  if (!s.exec) return `ark_log "skip systemd unit: no entry-point"`;
  const unit = `[Unit]
Description=ARK build ${s.name}
After=network-online.target

[Service]
ExecStart=${s.exec}
Restart=${s.restart}
User=${s.user}

[Install]
WantedBy=multi-user.target
`;
  // heredoc into the unit file
  return [
    `cat > /etc/systemd/system/${s.name}.service <<'ARKUNIT'`,
    unit.trim(),
    'ARKUNIT',
    `ark_run systemctl daemon-reload`,
    `ark_run systemctl enable --now ${s.name}.service`,
  ].join('\n');
}

function renderRegister(s) {
  // Use printf with a %s placeholder for $INSTALLED_AT — sidesteps the
  // nested single/double quote dance that echo would require.
  const tmpl = JSON.stringify({ ...s.payload, installed_at: '%s' });
  return `printf ${shellQuote(tmpl + '\\n')} "$INSTALLED_AT" > ${shellQuote(s.path)} && ark_log "registered: ${s.path}"`;
}

function shellQuote(s) {
  const str = String(s);
  if (/^[a-zA-Z0-9_\-\.\/=:]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ── Log helper ──────────────────────────────────────────────────────
function openLog(buildDir) {
  const file = path.join(buildDir, 'install.log');
  return {
    file,
    async write(msg) {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      await appendFile(file, line);
      process.stdout.write(line);
    },
    async stage(name) {
      const line = `\n── STAGE: ${name.toUpperCase()} ──\n`;
      await appendFile(file, line);
      process.stdout.write(line);
    },
  };
}
