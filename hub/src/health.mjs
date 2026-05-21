// Health score — Phase 4.6.
//
// Pure derivation function: takes a device + its latest telemetry and
// returns one of HEALTHY / DEGRADED / OFFLINE / UNKNOWN plus the list
// of individual signal verdicts so the UI can explain WHY.
//
// Thresholds picked from the architecture doc:
//   heartbeat freshness  → last Agent report < 60s
//   uptime stability     → no unexpected reboot in the last hour
//   CPU temp             → < 70°C
//   services available   → all declared services running
//   network consistency  → IP stable across last 5 scans

const HEARTBEAT_FRESH_S = 60;
const HEARTBEAT_STALE_S = 300;   // beyond this = OFFLINE
const CPU_WARN_C        = 70;
const CPU_HOT_C         = 85;
const REBOOT_RECENT_S   = 3600;

export const HEALTH_STATES = {
  HEALTHY:  'healthy',
  DEGRADED: 'degraded',
  OFFLINE:  'offline',
  UNKNOWN:  'unknown',
};

/**
 * Compute a device's health state from its latest telemetry record
 * and (optionally) recent sightings for network-consistency.
 *
 * @param {object} input
 * @param {object|null} input.telemetry  — most recent row from store.latestTelemetry()
 * @param {Array}   [input.sightings]    — recent rows from store.listDeviceSightings()
 * @param {string|null} [input.manifestId]
 * @returns {{ state, signals, last_reported_at }}
 */
export function computeHealth({ telemetry, sightings, manifestId } = {}) {
  if (!telemetry) {
    return { state: HEALTH_STATES.UNKNOWN, signals: [], last_reported_at: null };
  }

  const reportedAt = telemetry.reported_at ? new Date(telemetry.reported_at).getTime() : 0;
  const nowMs = Date.now();
  const ageSec = (nowMs - reportedAt) / 1000;

  const signals = [];

  // Heartbeat freshness
  signals.push({
    key: 'heartbeat',
    ok: ageSec <= HEARTBEAT_FRESH_S,
    severity: ageSec <= HEARTBEAT_FRESH_S ? 'ok' :
              ageSec <= HEARTBEAT_STALE_S ? 'warn' : 'fail',
    detail: `last reported ${Math.round(ageSec)}s ago`,
  });

  // CPU temp
  if (telemetry.cpu_temp_c != null) {
    signals.push({
      key: 'cpu_temp',
      ok: telemetry.cpu_temp_c < CPU_WARN_C,
      severity: telemetry.cpu_temp_c < CPU_WARN_C ? 'ok' :
                telemetry.cpu_temp_c < CPU_HOT_C  ? 'warn' : 'fail',
      detail: `${telemetry.cpu_temp_c}°C`,
    });
  }

  // Uptime stability — flag recent reboot
  if (telemetry.uptime_s != null) {
    const recentReboot = telemetry.uptime_s < REBOOT_RECENT_S;
    signals.push({
      key: 'uptime',
      ok: !recentReboot,
      severity: recentReboot ? 'warn' : 'ok',
      detail: `uptime ${Math.round(telemetry.uptime_s / 60)} min`,
    });
  }

  // Memory + disk — informational, only fail at extreme values
  if (telemetry.memory_used_pct != null) {
    signals.push({
      key: 'memory',
      ok: telemetry.memory_used_pct < 90,
      severity: telemetry.memory_used_pct < 80 ? 'ok' : telemetry.memory_used_pct < 95 ? 'warn' : 'fail',
      detail: `${telemetry.memory_used_pct}% used`,
    });
  }
  if (telemetry.disk_used_pct != null) {
    signals.push({
      key: 'disk',
      ok: telemetry.disk_used_pct < 90,
      severity: telemetry.disk_used_pct < 85 ? 'ok' : telemetry.disk_used_pct < 95 ? 'warn' : 'fail',
      detail: `${telemetry.disk_used_pct}% used`,
    });
  }

  // Network consistency — if we have ≥3 sightings and the IP changed
  // recently, flag as warn.
  if (Array.isArray(sightings) && sightings.length >= 3) {
    const ips = new Set(sightings.slice(0, 5).map(s => s.ip).filter(Boolean));
    signals.push({
      key: 'network',
      ok: ips.size <= 1,
      severity: ips.size <= 1 ? 'ok' : ips.size <= 2 ? 'warn' : 'fail',
      detail: ips.size === 1 ? 'stable IP' : `${ips.size} IPs in last 5 sightings`,
    });
  }

  // No manifest? — informational
  if (!manifestId) {
    signals.push({
      key: 'manifest',
      ok: true,
      severity: 'info',
      detail: 'no manifest linked',
    });
  }

  const state = rollupState(signals, ageSec);
  return {
    state,
    signals,
    last_reported_at: telemetry.reported_at,
  };
}

function rollupState(signals, ageSec) {
  if (ageSec > HEARTBEAT_STALE_S) return HEALTH_STATES.OFFLINE;
  const failing = signals.some(s => s.severity === 'fail');
  if (failing) return HEALTH_STATES.DEGRADED;
  const warning = signals.some(s => s.severity === 'warn');
  if (warning) return HEALTH_STATES.DEGRADED;
  return HEALTH_STATES.HEALTHY;
}
