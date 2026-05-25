// Fleet view — persistent device roster + health + drift + per-device drilldown.
//
// Distinct from Network Landscape's "Devices" tab:
//   - Network Landscape > Devices = LIVE LAN scan (current tick)
//   - Fleet                       = PERSISTENT roster from the Hub's
//                                   SQLite store, plus health/drift signals
//                                   from telemetry the Agent reports.
//
// Phase 4 (backend) shipped earlier; this is the UI surface.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Server, AlertTriangle, Activity, X as XIcon, Download } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://192.168.4.167:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

const STATE_COLOURS = {
  healthy:  COLORS.success,
  degraded: COLORS.warning,
  offline:  COLORS.error,
  unknown:  COLORS.textMuted,
};
const STATE_LABELS = {
  healthy:  'Healthy',
  degraded: 'Degraded',
  offline:  'Offline',
  unknown:  'Unknown',
};
const STATE_ORDER = ['healthy', 'degraded', 'offline', 'unknown'];

export default function Fleet() {
  const hubUrl = readHubUrl();
  const [state, setState] = useState({ status: 'loading', fleet: [], drift: [], error: null });
  const [filter, setFilter]   = useState('all');
  const [selected, setSelected] = useState(null);   // device_id of drilldown

  const refresh = useCallback(async () => {
    try {
      const [fleetRes, driftRes] = await Promise.all([
        fetch(`${hubUrl}/api/health/fleet`, { cache: 'no-cache' }),
        fetch(`${hubUrl}/api/drift`,        { cache: 'no-cache' }),
      ]);
      if (!fleetRes.ok) throw new Error(`HTTP ${fleetRes.status}`);
      const fleetData = await fleetRes.json();
      const driftData = driftRes.ok ? await driftRes.json() : { events: [] };
      setState({ status: 'ok', fleet: fleetData.fleet || [], drift: driftData.events || [], error: null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    }
  }, [hubUrl]);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const t = setInterval(() => { if (!cancelled) refresh(); }, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [refresh]);

  // Pre-compute drift counts per device for the row badges
  const driftByDevice = useMemo(() => {
    const m = {};
    for (const e of state.drift) m[e.device_id] = (m[e.device_id] || 0) + 1;
    return m;
  }, [state.drift]);

  const counts = useMemo(() => {
    const c = { all: state.fleet.length, healthy: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const f of state.fleet) c[f.state] = (c[f.state] || 0) + 1;
    return c;
  }, [state.fleet]);

  const filtered = useMemo(() => {
    if (filter === 'all') return state.fleet;
    return state.fleet.filter(f => f.state === filter);
  }, [filter, state.fleet]);

  if (state.status === 'error') {
    return (
      <div style={{
        padding: 20, background: 'rgba(245,180,90,0.08)',
        border: `1px solid ${COLORS.warning}`, borderRadius: 10,
        display: 'flex', gap: 14, alignItems: 'flex-start',
      }}>
        <AlertTriangle size={20} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
        <div>
          <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.warning }}>
            Can't reach Ark Hub
          </h3>
          <p style={{ margin: 0, color: COLORS.textSecondary, fontSize: 13, lineHeight: 1.6 }}>
            Fleet view reads from the Hub at <code>{hubUrl}</code>.{' '}
            Start it with <code>node hub/src/index.mjs</code> or check it's running:{' '}
            <code>launchctl print gui/$(id -u)/co.sinsera.ark.hub</code>.
          </p>
          <p style={{ margin: '8px 0 0', color: COLORS.textMuted, fontSize: 12, fontFamily: FONT_MONO }}>
            error: {state.error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{
          fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500,
          letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary,
        }}>Fleet</h2>
        <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13 }}>
          Persistent device roster · health from agent telemetry · drift from manifest compares.
        </p>
      </header>

      {/* Stat tiles + filter chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatChip label="All"      count={counts.all}      active={filter === 'all'}      onClick={() => setFilter('all')}    color={COLORS.textPrimary}/>
        {STATE_ORDER.map(s => (
          <StatChip key={s} label={STATE_LABELS[s]} count={counts[s] || 0} active={filter === s}
                    onClick={() => setFilter(s)} color={STATE_COLOURS[s]}/>
        ))}
        <div style={{ flex: 1 }}/>
        <a href={`${hubUrl}/api/export/snapshot.json`} target="_blank" rel="noreferrer" style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', textDecoration: 'none',
          background: COLORS.bgPanel, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8,
          fontFamily: FONT_BODY, fontSize: 13,
        }}>
          <Download size={14}/> Export snapshot
        </a>
      </div>

      {/* Device table */}
      <div style={{
        border: `1px solid ${COLORS.border}`, borderRadius: 10,
        overflow: 'hidden', background: COLORS.bgPanel,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <Th>·</Th>
              <Th>Device</Th>
              <Th>Health</Th>
              <Th>Drift</Th>
              <Th>Last reported</Th>
              <Th>Telemetry signals</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 28, textAlign: 'center', color: COLORS.textMuted }}>
                {state.fleet.length === 0
                  ? 'No devices on record yet. Once an Ark Agent reports in (or the Hub scans the LAN), devices will appear here.'
                  : `No devices matching filter "${filter}".`}
              </td></tr>
            ) : filtered.map(f => (
              <FleetRow key={f.device_id} f={f} driftCount={driftByDevice[f.device_id] || 0}
                        onSelect={() => setSelected(f.device_id)}/>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO, margin: 0 }}>
        Health from <code>/api/health/fleet</code> · drift from <code>/api/drift</code> · auto-refreshing every 8s.
      </p>

      {selected && (
        <DeviceDetail
          hubUrl={hubUrl}
          deviceId={selected}
          onClose={() => setSelected(null)}
          onResolveDrift={async (id) => { await fetch(`${hubUrl}/api/drift/${id}/resolve`, { method: 'POST' }); refresh(); }}
        />
      )}
    </div>
  );
}

function StatChip({ label, count, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 14px', cursor: 'pointer',
      background: active ? 'rgba(6,182,212,0.10)' : COLORS.bgPanel,
      color: active ? COLORS.accentBright : COLORS.textSecondary,
      border: `1px solid ${active ? COLORS.accentBorder : COLORS.border}`,
      borderRadius: 8, fontFamily: FONT_BODY, fontSize: 13, fontWeight: 500,
    }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color }}/>
      {label}
      <span style={{ marginLeft: 4, color: COLORS.textMuted, fontVariantNumeric: 'tabular-nums', fontFamily: FONT_MONO, fontSize: 12 }}>{count}</span>
    </button>
  );
}

function Th({ children }) {
  return <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` }}>{children}</th>;
}
function Td({ children, mono = false, dim = false, style = {} }) {
  return <td style={{
    padding: '10px 14px',
    borderBottom: `1px solid ${COLORS.border}`,
    color: dim ? COLORS.textMuted : COLORS.textPrimary,
    fontFamily: mono ? FONT_MONO : FONT_BODY,
    fontSize: mono ? 12 : 13,
    whiteSpace: 'nowrap',
    ...style,
  }}>{children}</td>;
}

function FleetRow({ f, driftCount, onSelect }) {
  const lastReportedAge = f.last_reported_at
    ? humanAge(new Date(f.last_reported_at).getTime())
    : '—';
  const colour = STATE_COLOURS[f.state] || COLORS.textMuted;
  const sigs = (f.signals || []).filter(s => s.severity !== 'info').slice(0, 4);
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onSelect}>
      <Td>
        <span title={`health: ${f.state}`} style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: colour,
          boxShadow: f.state === 'degraded' ? `0 0 6px ${colour}` : 'none',
        }}/>
      </Td>
      <Td>
        <span style={{ color: COLORS.textPrimary }}>{f.device_name || f.device_id}</span>
        <span style={{ marginLeft: 6, color: COLORS.textMuted, fontFamily: FONT_MONO, fontSize: 11 }}>
          {f.device_id !== f.device_name ? f.device_id : ''}
        </span>
      </Td>
      <Td>
        <span style={{
          padding: '2px 8px', fontSize: 11, borderRadius: 4,
          background: colour + '22', color: colour,
          textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
        }}>{f.state}</span>
      </Td>
      <Td>
        {driftCount > 0 ? (
          <span style={{
            padding: '2px 8px', fontSize: 11, borderRadius: 4,
            background: 'rgba(245,180,90,0.16)', color: COLORS.warning,
            fontFamily: FONT_MONO, fontWeight: 600,
          }}>{driftCount}</span>
        ) : <span style={{ color: COLORS.textMuted, fontSize: 12 }}>—</span>}
      </Td>
      <Td mono dim>{lastReportedAge}</Td>
      <Td>
        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {sigs.length === 0
            ? <span style={{ color: COLORS.textMuted, fontSize: 11 }}>no telemetry</span>
            : sigs.map(s => <SignalChip key={s.key} sig={s}/>)
          }
        </span>
      </Td>
    </tr>
  );
}

function SignalChip({ sig }) {
  const c = sig.severity === 'ok' ? COLORS.success
          : sig.severity === 'warn' ? COLORS.warning
          : sig.severity === 'fail' ? COLORS.error
          : COLORS.textMuted;
  return (
    <span title={sig.detail} style={{
      padding: '1px 6px', fontSize: 10, borderRadius: 3,
      background: c + '14', color: c,
      fontFamily: FONT_MONO, letterSpacing: 0.2,
    }}>{sig.key}</span>
  );
}

// ── Device drilldown modal ─────────────────────────────────────────
function DeviceDetail({ hubUrl, deviceId, onClose, onResolveDrift }) {
  const [data, setData]   = useState(null);
  const [drift, setDrift] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [devRes, driftRes] = await Promise.all([
          fetch(`${hubUrl}/api/devices/${encodeURIComponent(deviceId)}`),
          fetch(`${hubUrl}/api/devices/${encodeURIComponent(deviceId)}/drift`),
        ]);
        if (!devRes.ok) throw new Error(`HTTP ${devRes.status}`);
        const j = await devRes.json();
        const d = driftRes.ok ? await driftRes.json() : { events: [] };
        if (cancelled) return;
        setData(j);
        setDrift(d.events || []);
      } catch (e) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; };
  }, [hubUrl, deviceId]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`,
        borderRadius: 12, width: '100%', maxWidth: 820, maxHeight: '90vh',
        overflow: 'auto', color: COLORS.textPrimary, padding: '20px 22px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: FONT_HEADING, fontSize: 22, fontWeight: 500 }}>
              {data?.device?.device_name || deviceId}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
              {deviceId} · {data?.device?.vendor || 'unknown vendor'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', color: COLORS.textMuted,
            fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: 4,
          }}>×</button>
        </div>

        {error && <div style={{ padding: 12, background: 'rgba(239,111,92,0.08)', border: `1px solid ${COLORS.error}`, borderRadius: 8, color: COLORS.error, fontSize: 12, marginBottom: 16 }}>error: {error}</div>}

        {/* Stats */}
        {data?.device && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 18 }}>
            <Stat label="Hostname"      value={data.device.hostname || '—'}/>
            <Stat label="OS"            value={data.device.os || '—'}/>
            <Stat label="Trust"         value={data.device.trust_state || 'unknown'}/>
            <Stat label="First seen"    value={(data.device.first_seen || '').slice(0, 16).replace('T', ' ')}/>
            <Stat label="Last seen"     value={(data.device.last_seen || '').slice(0, 16).replace('T', ' ')}/>
            <Stat label="Manifest"      value={data.device.manifest_id || '—'}/>
          </div>
        )}

        {/* Telemetry sparklines */}
        {data?.telemetry?.length > 0 && (
          <Section title={`Telemetry · ${data.telemetry.length} samples`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              <Spark series={data.telemetry} field="cpu_temp_c"      label="CPU temp (°C)"  warnAt={70} hotAt={85}/>
              <Spark series={data.telemetry} field="memory_used_pct" label="Memory % used"   warnAt={80} hotAt={95}/>
              <Spark series={data.telemetry} field="disk_used_pct"   label="Disk % used"     warnAt={85} hotAt={95}/>
              <Spark series={data.telemetry} field="load_1m"         label="Load (1m)"        warnAt={2}  hotAt={4}/>
            </div>
          </Section>
        )}

        {/* Drift events */}
        <Section title={`Drift events · ${drift.length}`}>
          {drift.length === 0 ? (
            <div style={{ color: COLORS.textMuted, fontSize: 12, padding: '6px 0' }}>No unresolved drift for this device.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Kind</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Field</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Expected</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Actual</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>When</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {drift.map(d => (
                  <tr key={d.id}>
                    <td style={{ padding: '6px 8px', color: COLORS.warning }}>{d.kind}</td>
                    <td style={{ padding: '6px 8px', fontFamily: FONT_MONO, color: COLORS.textSecondary }}>{d.field || '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: FONT_MONO }}>{truncate(d.expected, 30)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: FONT_MONO }}>{truncate(d.actual, 30)}</td>
                    <td style={{ padding: '6px 8px', fontFamily: FONT_MONO, color: COLORS.textMuted }}>{humanAge(new Date(d.detected_at).getTime())}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <button onClick={() => onResolveDrift(d.id)} style={{
                        padding: '4px 10px', fontSize: 11, background: 'transparent',
                        border: `1px solid ${COLORS.border}`, color: COLORS.accent,
                        borderRadius: 4, cursor: 'pointer',
                      }}>resolve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <a href={`${hubUrl}/api/export/device/${encodeURIComponent(deviceId)}.json`}
             target="_blank" rel="noreferrer"
             style={{
               padding: '8px 14px', background: 'transparent',
               border: `1px solid ${COLORS.border}`, borderRadius: 8,
               color: COLORS.accent, fontSize: 13, textDecoration: 'none',
               display: 'inline-flex', alignItems: 'center', gap: 6,
             }}>
            <Download size={12}/> Export device JSON
          </a>
          <button onClick={onClose} style={{
            padding: '8px 14px', background: COLORS.accent,
            border: 'none', borderRadius: 8, color: '#0a0a0a',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.025)', border: `1px solid ${COLORS.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2, color: COLORS.textPrimary, fontVariantNumeric: 'tabular-nums', fontFamily: FONT_MONO }}>{String(value).slice(0, 40)}</div>
    </div>
  );
}

// SVG sparkline for one telemetry field. Series is ordered newest→
// oldest (the API's natural order); we flip for the chart so time
// flows left→right.
function Spark({ series, field, label, warnAt, hotAt }) {
  const W = 320, H = 70, PAD_L = 28, PAD_R = 6, PAD_T = 8, PAD_B = 14;
  const points = [...series].reverse()
    .map(t => ({ x: new Date(t.reported_at).getTime(), y: t[field] }))
    .filter(p => p.y != null);

  if (points.length < 2) {
    return (
      <div style={{
        height: H, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,0.02)', borderRadius: 6,
        color: COLORS.textMuted, fontSize: 11,
      }}>
        <span>{label}: not enough samples</span>
      </div>
    );
  }

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(...ys, hotAt || warnAt || 1);
  const yMin = 0;

  const xPx = (x) => PAD_L + (xMax === xMin ? 0 : (x - xMin) / (xMax - xMin)) * (W - PAD_L - PAD_R);
  const yPx = (y) => PAD_T + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - PAD_T - PAD_B);

  let d = `M ${xPx(points[0].x).toFixed(1)} ${yPx(points[0].y).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${xPx(points[i].x).toFixed(1)} ${yPx(points[i].y).toFixed(1)}`;

  const lastY = points[points.length - 1].y;
  const stroke = (hotAt && lastY >= hotAt) ? COLORS.error
                : (warnAt && lastY >= warnAt) ? COLORS.warning
                : COLORS.accent;

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 6, padding: '6px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: COLORS.textMuted, marginBottom: 2 }}>
        <span>{label}</span>
        <span style={{ fontFamily: FONT_MONO, color: stroke }}>{lastY.toFixed?.(1) ?? lastY}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {warnAt && warnAt < yMax && (
          <line x1={PAD_L} y1={yPx(warnAt)} x2={W - PAD_R} y2={yPx(warnAt)} stroke={COLORS.warning} strokeWidth={0.5} strokeDasharray="2,3" opacity={0.6}/>
        )}
        <text x={PAD_L - 4} y={yPx(yMin) + 3} fill={COLORS.textMuted} fontSize={8} textAnchor="end" fontFamily="ui-monospace, monospace">0</text>
        <text x={PAD_L - 4} y={yPx(yMax) + 3} fill={COLORS.textMuted} fontSize={8} textAnchor="end" fontFamily="ui-monospace, monospace">{Math.round(yMax)}</text>
        <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round"/>
        <circle cx={xPx(points[points.length-1].x)} cy={yPx(lastY)} r={2.5} fill={stroke}/>
      </svg>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────
function humanAge(ts) {
  if (!ts) return '—';
  const diffS = (Date.now() - ts) / 1000;
  if (diffS < 60)   return `${Math.round(diffS)}s ago`;
  if (diffS < 3600) return `${Math.round(diffS/60)}m ago`;
  if (diffS < 86400) return `${Math.round(diffS/3600)}h ago`;
  return `${Math.round(diffS/86400)}d ago`;
}
function truncate(s, n) {
  if (!s) return '—';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
