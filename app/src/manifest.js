// Ark device manifest — the canonical data model for an Ark-managed
// device. Every config / image / clone is derived from a manifest.
//
// Manifests are stored in localStorage during Phase 1 (single-user,
// no backend). The shape here is the source of truth; output
// generators in output.js consume manifests, never raw form values.

export const MANIFEST_SCHEMA_VERSION = 1;

export const ROLES = [
  { id: 'kiosk',     label: 'Kiosk',     desc: 'Fullscreen Chromium pointed at a URL' },
  { id: 'signage',   label: 'Signage',   desc: 'Rotating slides / images / video (Phase 2)' },
  { id: 'portable',  label: 'Portable',  desc: 'Pi Zero 2 W + PiSugar — wearable / pocketable' },
  { id: 'dashboard', label: 'Dashboard', desc: 'Same as Kiosk but with autoreload + telemetry' },
  { id: 'headless',  label: 'Headless',  desc: 'No GUI — service node only (e.g. OBD bridge)' },
];

export const MODELS = [
  { id: 'pi-zero-2-w', label: 'Pi Zero 2 W',   note: 'Primary target — small, cheap, ARM v8 quad-core' },
  { id: 'pi-4',        label: 'Pi 4',          note: 'Heavier-duty workloads' },
  { id: 'pi-5',        label: 'Pi 5',          note: 'Recent flagship; needs official 5V/5A PSU' },
];

export const DISPLAYS = [
  { id: 'hdmi',     label: 'HDMI' },
  { id: 'lcd-spi',  label: 'LCD via SPI (small panels)' },
  { id: 'dsi',      label: 'Official DSI display' },
  { id: 'headless', label: 'None / headless' },
];

export const TIMEZONES = [
  'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne',
  'Australia/Adelaide', 'Australia/Perth', 'Australia/Darwin',
  'Pacific/Auckland', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'UTC',
];

export const URL_PRESETS = [
  { id: 'garage',   label: 'Garage dashboard',  url: 'https://sinsera.co/garage' },
  { id: 'obd',      label: 'Garage OBD live',   url: 'https://sinsera.co/garage', hint: 'Navigate to /:carId/obd after sign-in' },
  { id: 'core',     label: 'Sinsera Core home', url: 'https://sinsera.co' },
  { id: 'darkhaus', label: 'DarkHaus admin',    url: 'https://sinsera.co/darkhaus' },
  { id: 'payroll',  label: 'Payroll dashboard', url: 'https://sinsera.co/payroll' },
];

export function emptyManifest(name = 'ark-device-01') {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    identity: {
      name,
      role: 'kiosk',
      version: 1,
      // Free-form operator description — "what does this Pi do?"
      // Inherited by every build derived from this manifest, surfaced
      // in Builds list + Flash Images registry.
      description: '',
    },
    hardware: {
      model: 'pi-zero-2-w',
      pisugar: false,
      display: 'hdmi',
      ethernet: false,
      gpio: [],
      power_note: '',
    },
    network: {
      hostname: name,
      wifi_ssid: '',
      wifi_password: '',
      wifi_security: 'wpa2',
      static_ip: null,
      ssh_enabled: true,
      ssh_pubkeys: [],
      mdns: true,
    },
    software: {
      os: 'dietpi',
      packages: ['chromium', 'lxde'],
      boot_target: 'kiosk',
      timezone: 'Australia/Brisbane',
      root_password: 'sinsera-kiosk',
    },
    kiosk: {
      url: 'https://sinsera.co',
      fullscreen: true,
      auto_reload_min: 0,
      hide_cursor: true,
      disable_blanking: true,
      rotation: 'normal',
      fallback_html: null,
    },
    behaviour: {
      watchdog: false,
      auto_reboot_schedule: null,
      offline_fallback: false,
      recovery_rules: [],
    },
  };
}

// When role changes, several layers update automatically. Keep
// manifests internally consistent.
export function applyRoleDefaults(manifest, role) {
  const next = structuredClone(manifest);
  next.identity.role = role;
  switch (role) {
    case 'headless':
      next.software.packages = [];
      next.software.boot_target = 'headless';
      next.hardware.display = 'headless';
      next.kiosk.url = '';
      next.kiosk.fullscreen = false;
      break;
    case 'kiosk':
    case 'dashboard':
      next.software.packages = ['chromium', 'lxde'];
      next.software.boot_target = 'kiosk';
      if (next.hardware.display === 'headless') next.hardware.display = 'hdmi';
      next.kiosk.fullscreen = true;
      if (role === 'dashboard' && next.kiosk.auto_reload_min === 0) {
        next.kiosk.auto_reload_min = 30;
      }
      break;
    case 'signage':
      next.software.packages = ['chromium', 'lxde'];
      next.software.boot_target = 'kiosk';
      next.kiosk.fullscreen = true;
      // signage URL might be a slideshow page — keep as-is, user picks
      break;
    case 'portable':
      next.software.packages = ['chromium', 'lxde'];
      next.software.boot_target = 'kiosk';
      next.hardware.pisugar = true;     // portable strongly implies battery
      break;
    default: break;
  }
  return next;
}

// Hardware-aware warnings — surfaced in the UI so the user can fix
// invalid combinations before they flash a card and find out.
export function validateManifest(m) {
  const warnings = [];
  if (m.software.boot_target === 'headless' && m.hardware.display !== 'headless') {
    warnings.push({ severity: 'warn', text: `Headless boot target but display is "${m.hardware.display}" — set display to "None / headless" or pick a non-headless role.` });
  }
  if (m.hardware.display === 'headless' && m.identity.role !== 'headless') {
    warnings.push({ severity: 'warn', text: 'Display is headless but role is not — the kiosk URL will never be rendered.' });
  }
  if (m.identity.role !== 'headless' && !m.kiosk.url) {
    warnings.push({ severity: 'warn', text: 'No kiosk URL set — first boot will install Chromium but show a blank page.' });
  }
  if (!m.network.wifi_ssid && !m.hardware.ethernet) {
    warnings.push({ severity: 'info', text: 'No WiFi SSID and no ethernet HAT — the Pi will be offline. Fine if intentional.' });
  }
  if (!m.network.ssh_enabled && (!m.network.ssh_pubkeys || m.network.ssh_pubkeys.length === 0)) {
    warnings.push({ severity: 'info', text: 'SSH is disabled — if first boot fails you will need a keyboard + monitor to debug.' });
  }
  if (m.hardware.pisugar && m.software.boot_target === 'headless' && m.identity.role !== 'portable') {
    warnings.push({ severity: 'info', text: 'PiSugar HAT enabled — battery monitoring service still useful in headless mode but no UI to show it.' });
  }
  if (!/^[a-z0-9-]{1,63}$/.test(m.network.hostname || '')) {
    warnings.push({ severity: 'error', text: 'Hostname must be 1-63 chars, lowercase letters / digits / hyphens only.' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(m.identity.name || '')) {
    warnings.push({ severity: 'error', text: 'Identity name must start with a letter/digit and use letters, digits, underscore, or hyphen only.' });
  }
  return warnings;
}

// localStorage backing — Phase 1 single-user. Phase 4 graduates to
// Supabase for cross-device.
const STORAGE_KEY = 'ark.manifests.v1';
const ACTIVE_KEY  = 'ark.activeManifest.v1';

export function loadManifests() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
export function saveManifests(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
}
export function loadActiveId() {
  try { return localStorage.getItem(ACTIVE_KEY) || null; } catch { return null; }
}
export function saveActiveId(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
}
export function cloneManifest(source, newName) {
  const next = structuredClone(source);
  next.identity.name = newName;
  next.identity.version = 1;
  next.network.hostname = newName;
  return next;
}
