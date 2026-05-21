// Ark build-plan generator.
//
// Per the architecture spec: the manifest describes WHAT the device
// should be; the build plan describes WHAT TO DO to build it. Same
// principle as Terraform's plan or a Makefile's dependency tree —
// separate the declarative model from execution.
//
// The plan is a deterministic JSON document. Both the browser-side
// config generator (dietpiTxt / automationScript) AND the Linux-side
// image builder (Ark/builder/ark-builder.mjs) consume the SAME plan.
// That guarantees the dietpi.txt your browser previews is exactly
// what the image builder will write into the boot partition.

import { validateManifest } from './manifest.js';

export const BUILD_PLAN_VERSION = 1;

/**
 * Build a plan from a manifest.
 * Returns { version, generated_at, manifest, steps, env, warnings }.
 *
 * Steps are typed actions: pkg.install / svc.enable / file.write /
 * boot.patch / chroot.run. Each step is independently re-runnable.
 */
export function buildPlan(manifest) {
  const m = manifest;
  const headless = m.identity.role === 'headless' || m.software.boot_target === 'headless';
  const warnings = validateManifest(m);

  const steps = [];

  // ── STAGE 1: BOOT partition writes ──────────────────────────────
  steps.push({
    id: 'boot.write_dietpi_txt',
    stage: 'boot-partition',
    action: 'file.write',
    path: '/boot/dietpi.txt',
    note: 'DietPi unattended-install configuration (locale, network, software IDs)',
    produces: 'dietpi.txt',
  });
  steps.push({
    id: 'boot.write_automation',
    stage: 'boot-partition',
    action: 'file.write',
    path: '/boot/Automation_Custom_Script.sh',
    mode: '0755',
    note: 'First-boot hook DietPi runs after software install',
    produces: 'Automation_Custom_Script.sh',
  });

  // ── STAGE 2: package install (in chroot) ────────────────────────
  if (!headless) {
    for (const pkg of m.software.packages || []) {
      steps.push({
        id: `pkg.install.${pkg}`,
        stage: 'chroot',
        action: 'pkg.install',
        package: pkg,
        note: `apt-get install -y ${pkg}`,
      });
    }
    if (m.kiosk.hide_cursor) {
      steps.push({ id: 'pkg.install.unclutter', stage: 'chroot', action: 'pkg.install', package: 'unclutter' });
    }
    if (m.kiosk.auto_reload_min > 0) {
      steps.push({ id: 'pkg.install.xdotool', stage: 'chroot', action: 'pkg.install', package: 'xdotool' });
    }
  }

  // ── STAGE 3: services ────────────────────────────────────────────
  if (m.network.ssh_enabled) {
    steps.push({ id: 'svc.enable.ssh', stage: 'chroot', action: 'svc.enable', service: 'ssh' });
  }
  if (!headless) {
    steps.push({ id: 'svc.write.kiosk', stage: 'chroot', action: 'file.write', path: '/var/lib/dietpi/dietpi-autostart/custom.sh', mode: '0755', note: 'Kiosk autostart' });
  }
  if (m.behaviour.watchdog) {
    steps.push({ id: 'svc.enable.watchdog', stage: 'chroot', action: 'svc.enable', service: 'watchdog', note: '(stub — config not yet written by Phase 1)' });
  }

  // ── STAGE 4: SSH keys ───────────────────────────────────────────
  if (m.network.ssh_pubkeys && m.network.ssh_pubkeys.length > 0) {
    steps.push({
      id: 'file.write.authorized_keys',
      stage: 'chroot',
      action: 'file.write',
      path: '/root/.ssh/authorized_keys',
      mode: '0600',
      note: `${m.network.ssh_pubkeys.length} key(s) from manifest`,
    });
  }

  // ── STAGE 5: display rotation (if non-default) ──────────────────
  if (!headless && m.kiosk.rotation && m.kiosk.rotation !== 'normal') {
    steps.push({
      id: 'file.write.xorg_rotate',
      stage: 'chroot',
      action: 'file.write',
      path: '/etc/X11/xorg.conf.d/40-rotate.conf',
      note: `display rotation: ${m.kiosk.rotation}`,
    });
  }

  // ── STAGE 6: auto-reload cron (if enabled) ──────────────────────
  if (!headless && m.kiosk.auto_reload_min > 0) {
    steps.push({
      id: 'cron.write.kiosk_reload',
      stage: 'chroot',
      action: 'cron.write',
      schedule: `*/${m.kiosk.auto_reload_min} * * * *`,
      command: 'DISPLAY=:0 xdotool key F5 >/dev/null 2>&1',
      note: `auto-reload every ${m.kiosk.auto_reload_min} min`,
    });
  }

  // ── STAGE 7: sanitisation (image-mode only) ──────────────────────
  steps.push({
    id: 'image.sanitise',
    stage: 'finalise',
    action: 'sanitise',
    targets: ['/tmp/*', '/var/log/*', '/root/.bash_history'],
    note: 'Image-mode only — drops on every flash; no-op for config-mode',
  });

  // ── STAGE 8: image export ────────────────────────────────────────
  steps.push({
    id: 'image.export',
    stage: 'export',
    action: 'image.export',
    filename: `ark-${m.identity.name}-v${m.identity.version || 1}.img`,
    compress: 'xz',
    checksum: 'sha256',
    note: 'Image-mode only — config-mode skips this',
  });

  // Env values referenced by multiple steps (so the executor doesn't
  // re-derive them from the manifest each time)
  const env = {
    role: m.identity.role,
    headless,
    hostname: m.network.hostname,
    timezone: m.software.timezone,
    kiosk_url: m.kiosk.url,
    pi_model: m.hardware.model,
    base_image: 'DietPi_RPi5-ARMv8-Trixie.img',
  };

  return {
    version: BUILD_PLAN_VERSION,
    generated_at: new Date().toISOString(),
    manifest_name: m.identity.name,
    manifest_role: m.identity.role,
    schema_version: m.schema_version,
    env,
    steps,
    warnings,
  };
}

// Convenience: stringify a build plan for display / download.
export function buildPlanJson(plan) {
  return JSON.stringify(plan, null, 2);
}
