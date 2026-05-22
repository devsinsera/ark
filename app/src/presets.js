// Phase 2 — Presets.
//
// Three composable preset axes — hardware × purpose × OS — that
// combine to seed a device manifest with sensible defaults. Picking
// "Pi 5 8GB" + "Kiosk" + "Pi OS Desktop" should give an operator a
// near-correct manifest with a single click; from there they tweak.
//
// Presets are IMMUTABLE + VERSIONED. Once a manifest references a
// preset_id, that combination is recorded so the manifest stays
// reproducible even if the preset itself changes later.

export const PRESETS_SCHEMA_VERSION = 1;

// ── Hardware presets ────────────────────────────────────────────────
export const HARDWARE_PRESETS = {
  'pi-zero-2w': {
    id: 'pi-zero-2w',
    label: 'Pi Zero 2 W',
    family: 'pi-zero',
    arch: 'armv7',
    cpu_cores: 4,
    ram_mb: 512,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: false,
    has_hdmi: 'mini',
    has_gpio: true,
    power_w_typical: 2,
    notes: 'Tiny + cheap. Good for portable utility nodes and sensors.',
    suggested_purposes: ['portable-node', 'service'],
  },
  'pi-3b-plus': {
    id: 'pi-3b-plus',
    label: 'Pi 3 B+',
    family: 'pi-3',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 1024,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: '100mbit',
    has_hdmi: 'full',
    has_gpio: true,
    power_w_typical: 4,
    notes: 'Solid GPIO + dual-band Wi-Fi. Slow for desktop, fine headless.',
    suggested_purposes: ['kiosk', 'dashboard', 'service', 'signage'],
  },
  'pi-4-4gb': {
    id: 'pi-4-4gb',
    label: 'Pi 4 (4 GB)',
    family: 'pi-4',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 4096,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: 'gigabit',
    has_hdmi: 'micro-x2',
    has_gpio: true,
    power_w_typical: 5,
    notes: 'Sweet spot for kiosks + dashboards. Two displays supported.',
    suggested_purposes: ['kiosk', 'dashboard', 'signage', 'service'],
  },
  'pi-4-8gb': {
    id: 'pi-4-8gb',
    label: 'Pi 4 (8 GB)',
    family: 'pi-4',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 8192,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: 'gigabit',
    has_hdmi: 'micro-x2',
    has_gpio: true,
    power_w_typical: 5,
    notes: 'More headroom than a 4 GB Pi 4. Good for desktop or multi-service.',
    suggested_purposes: ['kiosk', 'dashboard', 'service'],
  },
  'pi-5-4gb': {
    id: 'pi-5-4gb',
    label: 'Pi 5 (4 GB)',
    family: 'pi-5',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 4096,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: 'gigabit',
    has_hdmi: 'micro-x2',
    has_gpio: true,
    has_pcie: true,
    power_w_typical: 7,
    notes: 'Significantly faster than Pi 4. Hot — plan cooling for sustained loads.',
    suggested_purposes: ['kiosk', 'dashboard', 'service', 'signage'],
  },
  'pi-5-8gb': {
    id: 'pi-5-8gb',
    label: 'Pi 5 (8 GB)',
    family: 'pi-5',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 8192,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: 'gigabit',
    has_hdmi: 'micro-x2',
    has_gpio: true,
    has_pcie: true,
    power_w_typical: 7,
    notes: 'Recommended for new builds. Verified live on the SinseraCore node.',
    suggested_purposes: ['kiosk', 'dashboard', 'service', 'signage', 'portable-node'],
  },
  'pi-5-16gb': {
    id: 'pi-5-16gb',
    label: 'Pi 5 (16 GB)',
    family: 'pi-5',
    arch: 'arm64',
    cpu_cores: 4,
    ram_mb: 16384,
    has_wifi: true,
    has_bluetooth: true,
    has_ethernet: 'gigabit',
    has_hdmi: 'micro-x2',
    has_gpio: true,
    has_pcie: true,
    power_w_typical: 7,
    notes: 'Newest, most RAM. Useful for AI / large in-memory caches.',
    suggested_purposes: ['service', 'dashboard'],
  },
  'headless-node': {
    id: 'headless-node',
    label: 'Headless ARM64 node',
    family: 'generic',
    arch: 'arm64',
    cpu_cores: null,
    ram_mb: null,
    has_wifi: null,
    has_bluetooth: null,
    has_ethernet: 'unknown',
    has_hdmi: false,
    has_gpio: false,
    power_w_typical: null,
    notes: 'Catch-all for non-Pi ARM64 hosts (Orange Pi, Radxa, etc.).',
    suggested_purposes: ['service'],
  },
};

// ── Purpose presets ────────────────────────────────────────────────
// Each purpose declares default APT/pip packages, a role, and
// whether a display is required.
export const PURPOSE_PRESETS = {
  'kiosk': {
    id: 'kiosk',
    label: 'Kiosk',
    role: 'kiosk',
    description: 'Full-screen browser pointed at a single URL. Auto-restarts on crash.',
    requires_display: true,
    apt: ['chromium-browser', 'unclutter', 'xdotool'],
    pip: [],
    services: ['kiosk-browser'],
    suggested_os: ['pi-os-desktop', 'dietpi'],
  },
  'dashboard': {
    id: 'dashboard',
    label: 'Dashboard',
    role: 'dashboard',
    description: 'Always-on data display. Like kiosk, but assumes a managed dashboard URL (Grafana, Home Assistant, etc.).',
    requires_display: true,
    apt: ['chromium-browser', 'unclutter'],
    pip: [],
    services: ['dashboard-browser'],
    suggested_os: ['pi-os-desktop', 'dietpi'],
  },
  'portable-node': {
    id: 'portable-node',
    label: 'Portable node',
    role: 'portable_node',
    description: 'Battery-powered toolkit (Shark Jack / RaspyJack style). Headless by default; LCD optional.',
    requires_display: false,
    apt: ['python3-pip', 'nmap', 'tcpdump'],
    pip: ['scapy'],
    services: [],
    suggested_os: ['dietpi', 'pi-os-lite'],
  },
  'signage': {
    id: 'signage',
    label: 'Signage',
    role: 'signage',
    description: 'Scheduled media playback. Video walls, ad screens, info displays.',
    requires_display: true,
    apt: ['vlc', 'omxplayer'],
    pip: [],
    services: ['signage-player'],
    suggested_os: ['pi-os-desktop'],
  },
  'service': {
    id: 'service',
    label: 'Service host',
    role: 'service',
    description: 'Headless Linux server. Hosts long-running services (Hub, MQTT, Home Assistant).',
    requires_display: false,
    apt: ['curl', 'git', 'python3-pip'],
    pip: [],
    services: [],
    suggested_os: ['dietpi', 'pi-os-lite', 'ubuntu-server'],
  },
};

// ── OS presets ─────────────────────────────────────────────────────
export const OS_PRESETS = {
  'dietpi': {
    id: 'dietpi',
    label: 'DietPi',
    description: 'Minimal Debian-based OS optimised for Pi. Sub-1 GB image, scriptable first-boot.',
    base_image_glob: 'DietPi_*.img',
    package_manager: 'apt',
    default_user: 'root',
    has_systemd: true,
    suggested_hardware: ['pi-zero-2w', 'pi-3b-plus', 'pi-4-4gb', 'pi-4-8gb', 'pi-5-4gb', 'pi-5-8gb'],
  },
  'pi-os-lite': {
    id: 'pi-os-lite',
    label: 'Pi OS Lite (64-bit)',
    description: 'Official Raspberry Pi OS, headless. Most up-to-date kernel + firmware.',
    base_image_glob: '*raspios*lite*.img',
    package_manager: 'apt',
    default_user: 'pi',
    has_systemd: true,
    suggested_hardware: ['pi-3b-plus', 'pi-4-4gb', 'pi-4-8gb', 'pi-5-4gb', 'pi-5-8gb', 'pi-5-16gb'],
  },
  'pi-os-desktop': {
    id: 'pi-os-desktop',
    label: 'Pi OS Desktop (64-bit)',
    description: 'Official Pi OS with the LXDE desktop environment. Needed for kiosk / signage / dashboard.',
    base_image_glob: '*raspios*desktop*.img',
    package_manager: 'apt',
    default_user: 'pi',
    has_systemd: true,
    suggested_hardware: ['pi-4-4gb', 'pi-4-8gb', 'pi-5-4gb', 'pi-5-8gb', 'pi-5-16gb'],
  },
  'ubuntu-server': {
    id: 'ubuntu-server',
    label: 'Ubuntu Server (arm64)',
    description: 'Server-grade Ubuntu. Long support cycle. Heavier than DietPi.',
    base_image_glob: '*ubuntu*server*.img',
    package_manager: 'apt',
    default_user: 'ubuntu',
    has_systemd: true,
    suggested_hardware: ['pi-4-4gb', 'pi-4-8gb', 'pi-5-4gb', 'pi-5-8gb', 'pi-5-16gb'],
  },
  'ark-minimal': {
    id: 'ark-minimal',
    label: 'Ark Minimal',
    description: 'PLANNED — a hand-tuned base image, just the kernel + busybox + Ark Agent + python3. Not built yet.',
    base_image_glob: 'ark-minimal_*.img',
    package_manager: 'apt',
    default_user: 'root',
    has_systemd: true,
    placeholder: true,
    suggested_hardware: ['pi-zero-2w', 'pi-3b-plus', 'pi-4-4gb', 'pi-5-4gb', 'pi-5-8gb'],
  },
};

// ── Composition ────────────────────────────────────────────────────
// Apply a preset stack as DEFAULTS into a manifest. Operator-set fields
// already in the manifest win; presets only fill blanks. Returns a
// new manifest object — does NOT mutate input.
export function applyPresetStack({ hardware, purpose, os } = {}, manifest = {}) {
  const out = JSON.parse(JSON.stringify(manifest));
  out.presets = out.presets || {};

  if (hardware && HARDWARE_PRESETS[hardware]) {
    const h = HARDWARE_PRESETS[hardware];
    out.presets.hardware = h.id;
    out.hardware = out.hardware || {};
    out.hardware.model     = out.hardware.model     || h.label;
    out.hardware.cpu_cores = out.hardware.cpu_cores || h.cpu_cores;
    out.hardware.ram_mb    = out.hardware.ram_mb    || h.ram_mb;
    out.hardware.has_gpio  = (out.hardware.has_gpio === undefined) ? !!h.has_gpio : out.hardware.has_gpio;
    out.architecture = out.architecture || (h.arch ? [h.arch] : undefined);
  }

  if (purpose && PURPOSE_PRESETS[purpose]) {
    const p = PURPOSE_PRESETS[purpose];
    out.presets.purpose = p.id;
    out.role = out.role || p.role;
    out.requires_display = (out.requires_display === undefined) ? p.requires_display : out.requires_display;
    out.dependencies = out.dependencies || { apt: [], pip: [] };
    out.dependencies.apt = dedupe([...(out.dependencies.apt || []), ...(p.apt || [])]);
    out.dependencies.pip = dedupe([...(out.dependencies.pip || []), ...(p.pip || [])]);
    out.expected_services = dedupe([...(out.expected_services || []), ...(p.services || [])]);
  }

  if (os && OS_PRESETS[os]) {
    const o = OS_PRESETS[os];
    out.presets.os = o.id;
    out.os = out.os || o.label;
    out.os_id = out.os_id || o.id;
  }

  out.presets.schema_version = PRESETS_SCHEMA_VERSION;
  return out;
}

function dedupe(arr) { return [...new Set(arr)]; }

// Convenience: given a hardware preset, which purposes are sensible?
export function compatiblePurposes(hardwareId) {
  const h = HARDWARE_PRESETS[hardwareId];
  if (!h) return Object.keys(PURPOSE_PRESETS);
  return h.suggested_purposes || Object.keys(PURPOSE_PRESETS);
}
export function compatibleOses(hardwareId) {
  const h = HARDWARE_PRESETS[hardwareId];
  if (!h) return Object.keys(OS_PRESETS);
  return Object.values(OS_PRESETS)
    .filter(o => !o.suggested_hardware || o.suggested_hardware.includes(hardwareId))
    .map(o => o.id);
}
