// NetworkLandscape — the "Tab 3" device spreadsheet view, packaged
// as the four-tab Network Landscape view spec'd in
// docs/NETWORK_LANDSCAPE.md.
//
// Talks to the local Ark Hub (typically http://localhost:7400). The
// browser cannot do ARP / mDNS itself; the Hub does the discovery
// and exposes the data via JSON. This component is the operator's
// window onto whatever the Hub currently knows about.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Wifi, Cpu, Network as NetworkIcon, Share2, RefreshCw, AlertTriangle, Search } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';

function readHubUrl() {
  try {
    const stored = window.localStorage.getItem(HUB_KEY);
    return (stored && stored.replace(/\/+$/, '')) || DEFAULT_HUB;
  } catch { return DEFAULT_HUB; }
}

const TABS = [
  { id: 'devices', label: 'Devices',  icon: Cpu,         desc: 'Live LAN device spreadsheet' },
  { id: 'wifi',    label: 'Wi-Fi',    icon: Wifi,        desc: 'Active + nearby networks' },
  { id: 'active',  label: 'Networks', icon: NetworkIcon, desc: 'Networks Ark has observed' },
  { id: 'graph',   label: 'Graph',    icon: Share2,      desc: 'Network ↔ device topology' },
];

export default function NetworkLandscape() {
  const [tab, setTab] = useState('devices');
  const [hubUrl, setHubUrl] = useState(readHubUrl);

  const tabDef = TABS.find(t => t.id === tab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{
          fontFamily: FONT_HEADING,
          fontSize: 28, fontWeight: 500, letterSpacing: -0.5,
          margin: 0, color: COLORS.textPrimary,
        }}>Network Landscape</h2>
        <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13 }}>
          {tabDef?.desc} · via Hub at <code style={{ color: COLORS.accent }}>{hubUrl}</code>
        </p>
      </header>

      <TabBar tab={tab} setTab={setTab} />

      {tab === 'devices' && <DevicesTab hubUrl={hubUrl}/>}
      {tab === 'wifi'    && <WifiTab    hubUrl={hubUrl}/>}
      {tab === 'active'  && <ActiveTab  hubUrl={hubUrl}/>}
      {tab === 'graph'   && <GraphTab hubUrl={hubUrl}/>}

      <HubFooter hubUrl={hubUrl} setHubUrl={setHubUrl}/>
    </div>
  );
}

// ── Tab bar ─────────────────────────────────────────────────────────
function TabBar({ tab, setTab }) {
  return (
    <div style={{
      display: 'flex', gap: 4, padding: 4,
      background: COLORS.bgPanel, borderRadius: 10,
      border: `1px solid ${COLORS.border}`, width: 'fit-content',
    }}>
      {TABS.map(t => {
        const Icon = t.icon;
        const isActive = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 14px',
            background: isActive ? COLORS.bgActive : 'transparent',
            color: isActive ? COLORS.accentBright : COLORS.textSecondary,
            border: `1px solid ${isActive ? COLORS.accentBorder : 'transparent'}`,
            borderRadius: 8, cursor: 'pointer', fontSize: 13,
            fontFamily: FONT_BODY, fontWeight: 500,
            transition: 'all 120ms ease',
          }}>
            <Icon size={14}/> {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Devices tab (the spec'd Tab 3) ─────────────────────────────────
function DevicesTab({ hubUrl }) {
  const [state, setState] = useState({ status: 'loading', devices: [], scanned_at: null, error: null });
  const [healthByDevice, setHealthByDevice] = useState({});  // Phase 4.6
  const [driftCount, setDriftCount]         = useState(0);   // Phase 4.5
  const [filter, setFilter] = useState('');
  const [busy,   setBusy]   = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      const [devRes, healthRes, driftRes] = await Promise.all([
        fetch(`${hubUrl}/api/devices`,       { cache: 'no-cache' }),
        fetch(`${hubUrl}/api/health/fleet`,  { cache: 'no-cache' }).catch(() => null),
        fetch(`${hubUrl}/api/drift`,         { cache: 'no-cache' }).catch(() => null),
      ]);
      if (!devRes.ok) throw new Error(`HTTP ${devRes.status}`);
      const data = await devRes.json();
      const health = healthRes && healthRes.ok ? await healthRes.json() : { fleet: [] };
      const drift  = driftRes  && driftRes.ok  ? await driftRes.json()  : { events: [] };
      const hmap = {};
      for (const f of health.fleet || []) hmap[f.device_id] = f.state;
      setState({ status: 'ok', devices: data.devices || [], scanned_at: data.scanned_at, count: data.device_count, error: null });
      setHealthByDevice(hmap);
      setDriftCount((drift.events || []).length);
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    }
  }, [hubUrl]);

  useEffect(() => {
    let cancelled = false;
    fetchDevices();
    const t = setInterval(() => { if (!cancelled) fetchDevices(); }, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [fetchDevices]);

  const onScanNow = async () => {
    setBusy(true);
    try { await fetch(`${hubUrl}/api/scan`, { method: 'POST' }); await fetchDevices(); }
    catch { /* fetchDevices surfaces the error */ }
    finally { setBusy(false); }
  };

  const filtered = useMemo(() => {
    if (!filter) return state.devices;
    const q = filter.toLowerCase();
    return state.devices.filter(d =>
      (d.ip || '').includes(q) ||
      (d.device_name || '').toLowerCase().includes(q) ||
      (d.hostname || '').toLowerCase().includes(q) ||
      (d.mac || '').toLowerCase().includes(q) ||
      (d.vendor || '').toLowerCase().includes(q)
    );
  }, [filter, state.devices]);

  if (state.status === 'error') return <HubUnreachable hubUrl={hubUrl} error={state.error}/>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {driftCount > 0 && <DriftBanner hubUrl={hubUrl} count={driftCount}/>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', top: 11, left: 10, color: COLORS.textMuted }}/>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter by IP, MAC, hostname, vendor…"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 12px 8px 32px',
              background: COLORS.bgPanel, color: COLORS.textPrimary,
              border: `1px solid ${COLORS.border}`, borderRadius: 8,
              fontFamily: FONT_BODY, fontSize: 13, outline: 'none',
            }}
          />
        </div>
        <button onClick={onScanNow} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          background: busy ? COLORS.bgPanel : COLORS.bgActive,
          color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`,
          borderRadius: 8, fontFamily: FONT_BODY, fontSize: 13,
          cursor: busy ? 'wait' : 'pointer',
        }}>
          <RefreshCw size={14} className={busy ? 'spin' : ''}/> {busy ? 'scanning…' : 'Scan now'}
        </button>
        <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
          {state.scanned_at ? `last: ${state.scanned_at.slice(11, 19)} · ${state.count} device${state.count === 1 ? '' : 's'}` : 'awaiting first scan…'}
        </span>
      </div>

      <div style={{
        border: `1px solid ${COLORS.border}`, borderRadius: 10,
        overflow: 'hidden', background: COLORS.bgPanel,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <Th>·</Th>
              <Th>IP</Th>
              <Th>Hostname / name</Th>
              <Th>MAC</Th>
              <Th>Vendor</Th>
              <Th>Sources</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && state.status === 'ok' && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: COLORS.textMuted }}>
                {state.devices.length === 0 ? 'No devices visible yet — first scan still running, or this network is empty.' : 'No matches for that filter.'}
              </td></tr>
            )}
            {filtered.length === 0 && state.status === 'loading' && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: COLORS.textMuted }}>Loading…</td></tr>
            )}
            {filtered.map(d => <DeviceRow key={d.id || (d.ip + d.mac)} d={d} health={healthByDevice[d.mac || d.id || d.ip]}/>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }) {
  return <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` }}>{children}</th>;
}
function Td({ children, mono = false, dim = false }) {
  return <td style={{
    padding: '10px 14px',
    borderBottom: `1px solid ${COLORS.border}`,
    color: dim ? COLORS.textMuted : COLORS.textPrimary,
    fontFamily: mono ? FONT_MONO : FONT_BODY,
    fontSize: mono ? 12 : 13,
    whiteSpace: 'nowrap',
  }}>{children}</td>;
}

function DeviceRow({ d, health }) {
  const isPi = d.os === 'likely Pi' || /Raspberry Pi/i.test(d.vendor || '');
  const hostnameDisplay = d.hostname || d.device_name || '—';
  // Health-state → status-dot colour. Falls back to a neutral green
  // for everything else (network discovery only — no agent telemetry).
  const stateColour = {
    healthy:  COLORS.success,
    degraded: COLORS.warning,
    offline:  COLORS.error,
    unknown:  COLORS.textMuted,
  }[health] || (isPi ? COLORS.accentBright : COLORS.success);
  return (
    <tr style={{ background: isPi ? 'rgba(6,182,212,0.04)' : 'transparent' }}>
      <Td>
        <span title={health ? `health: ${health}` : 'network-discovered only'} style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 4,
          background: stateColour,
          boxShadow: isPi && !health ? `0 0 8px ${COLORS.accent}` : 'none',
        }}/>
      </Td>
      <Td mono>{d.ip}</Td>
      <Td>
        {hostnameDisplay}
        {isPi && (
          <span style={{
            marginLeft: 8, padding: '2px 6px', fontSize: 10,
            background: COLORS.bgActive, color: COLORS.accentBright,
            border: `1px solid ${COLORS.accentBorder}`, borderRadius: 4,
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>Pi</span>
        )}
        {health && health !== 'unknown' && (
          <span style={{
            marginLeft: 8, padding: '2px 6px', fontSize: 10,
            background: health === 'healthy' ? 'rgba(34,197,94,0.15)'
                       : health === 'degraded' ? 'rgba(245,180,90,0.15)'
                       : 'rgba(239,111,92,0.15)',
            color: stateColour, borderRadius: 4,
            textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
          }}>{health}</span>
        )}
      </Td>
      <Td mono dim>{d.mac || '—'}</Td>
      <Td dim>{d.vendor || '—'}</Td>
      <Td dim style={{ fontSize: 11 }}>{(d.sources || []).join(', ') || '—'}</Td>
    </tr>
  );
}

// ── Wi-Fi tab ───────────────────────────────────────────────────────
function WifiTab({ hubUrl }) {
  const [state, setState] = useState({ status: 'loading', active: null, nearby: [], scanned_at: null, error: null });
  const [busy,  setBusy]  = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${hubUrl}/api/wifi`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ status: 'ok', active: data.active, nearby: data.nearby || [], scanned_at: data.scanned_at, error: null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    }
  }, [hubUrl]);

  useEffect(() => { load(); }, [load]);

  const onRescan = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${hubUrl}/api/wifi/refresh`, { method: 'POST' });
      const data = await res.json();
      if (data.ok || data.nearby) setState({ status: 'ok', active: data.active, nearby: data.nearby || [], scanned_at: data.scanned_at, error: data.error || null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    } finally { setBusy(false); }
  };

  if (state.status === 'error') return <HubUnreachable hubUrl={hubUrl} error={state.error}/>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onRescan} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
          background: busy ? COLORS.bgPanel : COLORS.bgActive, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8,
          fontFamily: FONT_BODY, fontSize: 13, cursor: busy ? 'wait' : 'pointer',
        }}><RefreshCw size={14}/> {busy ? 'scanning (5-10s)…' : 'Rescan'}</button>
        <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
          {state.scanned_at ? `last: ${state.scanned_at.slice(11, 19)}` : 'no scan yet — click Rescan'}
        </span>
      </div>

      {state.active && (
        <div style={{ padding: 16, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
          <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.accentBright }}>Connected</h3>
          <WifiRow row={state.active} highlight/>
        </div>
      )}

      <div style={{ padding: 16, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>
          Nearby networks {state.nearby.length > 0 && <span style={{ color: COLORS.textMuted, fontSize: 14 }}>· {state.nearby.length}</span>}
        </h3>
        {state.nearby.length === 0
          ? <div style={{ color: COLORS.textMuted, fontSize: 13 }}>No nearby networks visible. Click Rescan to refresh.</div>
          : state.nearby.map((n, i) => <WifiRow key={n.bssid || i} row={n}/>)}
      </div>
    </div>
  );
}

function WifiRow({ row, highlight }) {
  const rssi = row.rssi;
  const bars = rssi == null ? 0 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '10px 0',
      borderTop: highlight ? 'none' : `1px solid ${COLORS.border}`,
    }}>
      <SignalBars bars={bars}/>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: highlight ? COLORS.accentBright : COLORS.textPrimary }}>
          {row.ssid || '(hidden)'}
        </div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>
          ch {row.channel ?? '—'} · {row.security || 'unknown'} {row.bssid ? `· ${row.bssid}` : ''}
        </div>
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: COLORS.textSecondary, minWidth: 70, textAlign: 'right' }}>
        {rssi != null ? `${rssi} dBm` : '—'}
      </div>
    </div>
  );
}

function SignalBars({ bars }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, width: 18, height: 18 }}>
      {[1,2,3,4].map(b => (
        <div key={b} style={{
          width: 3, height: 4 + b*3,
          background: b <= bars ? COLORS.accent : COLORS.border,
          borderRadius: 1,
        }}/>
      ))}
    </div>
  );
}

// ── Active networks tab — backed by Hub's SQLite store (Phase 4.3) ──
function ActiveTab({ hubUrl }) {
  const [state, setState] = useState({ status: 'loading', networks: [], error: null });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${hubUrl}/api/networks`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setState({ status: 'ok', networks: data.networks || [], error: null });
      } catch (e) {
        if (cancelled) return;
        setState(s => ({ ...s, status: 'error', error: e.message }));
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [hubUrl]);

  if (state.status === 'error') return <HubUnreachable hubUrl={hubUrl} error={state.error}/>;
  if (state.networks.length === 0) {
    return (
      <Placeholder
        title="No networks recorded yet"
        body="The Hub records each network it observes devices on (Wi-Fi SSIDs, Ethernet subnets). Once the first scan tick completes the network will appear here, along with every other network the Hub has ever seen."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        fontSize: 12, color: COLORS.textMuted,
        fontFamily: FONT_MONO,
      }}>
        {state.networks.length} network{state.networks.length === 1 ? '' : 's'} observed · history persisted in <code>~/.ark/ark-hub.db</code>
      </div>
      {state.networks.some(n => n.ssid === '<redacted>') && <RedactionHint/>}
      <div style={{
        border: `1px solid ${COLORS.border}`, borderRadius: 10,
        overflow: 'hidden', background: COLORS.bgPanel,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <Th>Type</Th><Th>SSID / Subnet</Th><Th>Gateway</Th><Th>Devices</Th><Th>First seen</Th><Th>Last seen</Th>
            </tr>
          </thead>
          <tbody>
            {state.networks.map(n => (
              <tr key={n.network_id}>
                <Td><NetworkTypeBadge type={n.type}/></Td>
                <Td>{n.ssid || n.subnet || '—'}</Td>
                <Td mono dim>{n.gateway_ip || '—'} {n.gateway_mac && <span style={{ color: COLORS.textMuted }}>({n.gateway_mac.slice(-8)})</span>}</Td>
                <Td>{n.device_count ?? 0}</Td>
                <Td mono dim>{(n.first_seen || '').slice(0, 16).replace('T', ' ')}</Td>
                <Td mono dim>{(n.last_seen || '').slice(0, 16).replace('T', ' ')}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExportRow hubUrl={hubUrl}/>
    </div>
  );
}

function DriftBanner({ hubUrl, count }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);

  const fetchEvents = useCallback(async () => {
    const r = await fetch(`${hubUrl}/api/drift`, { cache: 'no-cache' });
    const j = await r.json();
    setEvents(j.events || []);
  }, [hubUrl]);

  useEffect(() => { if (open) fetchEvents(); }, [open, fetchEvents]);

  async function resolve(id) {
    await fetch(`${hubUrl}/api/drift/${id}/resolve`, { method: 'POST' });
    fetchEvents();
  }

  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', textAlign: 'left', width: '100%',
        background: 'rgba(245,180,90,0.10)',
        border: `1px solid ${COLORS.warning}`,
        borderRadius: 8, color: COLORS.warning, fontSize: 13,
        cursor: 'pointer',
      }}>
        <AlertTriangle size={14}/> {count} drift event{count === 1 ? '' : 's'} unresolved · click to inspect
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`,
            borderRadius: 12, width: '100%', maxWidth: 880, maxHeight: '85vh',
            overflow: 'auto', color: COLORS.textPrimary, padding: '20px 22px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20 }}>Drift events</h3>
              <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
              An Ark Agent reported state that differs from the device's manifest, or the device appeared on a
              new network. Each event has a stable id so re-detections dedupe automatically.
            </p>
            {events.length === 0 ? (
              <div style={{ color: COLORS.textMuted }}>No unresolved events.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: FONT_BODY }}>
                <thead>
                  <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    <th style={driftTh}>Kind</th><th style={driftTh}>Device</th><th style={driftTh}>Field</th>
                    <th style={driftTh}>Expected</th><th style={driftTh}>Actual</th><th style={driftTh}>When</th><th style={driftTh}></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id}>
                      <td style={driftTd}><span style={{ color: kindColour(e.kind), fontFamily: FONT_MONO, fontSize: 11 }}>{e.kind}</span></td>
                      <td style={{ ...driftTd, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{e.device_id}</td>
                      <td style={{ ...driftTd, fontFamily: FONT_MONO, fontSize: 11 }}>{e.field || '—'}</td>
                      <td style={{ ...driftTd, fontFamily: FONT_MONO, fontSize: 11 }}>{truncate(e.expected, 30)}</td>
                      <td style={{ ...driftTd, fontFamily: FONT_MONO, fontSize: 11 }}>{truncate(e.actual, 30)}</td>
                      <td style={{ ...driftTd, fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted }}>{(e.detected_at || '').slice(11, 19)}</td>
                      <td style={driftTd}>
                        <button onClick={() => resolve(e.id)} style={{
                          padding: '3px 10px', fontSize: 11, background: 'transparent',
                          color: COLORS.accent, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
                        }}>resolve</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <a href={`${hubUrl}/api/drift`} target="_blank" rel="noreferrer" style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.accent, fontSize: 13, textDecoration: 'none' }}>
                Open raw JSON
              </a>
              <button onClick={() => setOpen(false)} style={{ padding: '8px 14px', background: COLORS.accent, border: 'none', borderRadius: 8, color: '#0a0a0a', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const driftTh = { textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${COLORS.border}` };
const driftTd = { padding: '6px 8px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary };
function kindColour(k) {
  return k === 'network' ? COLORS.warning
       : k === 'service' || k === 'kiosk_url' || k === 'packages' ? COLORS.error
       : k === 'manifest_missing' ? COLORS.textMuted
       : COLORS.accent;
}
function truncate(s, n) { if (!s) return '—'; const str = String(s); return str.length > n ? str.slice(0, n-1) + '…' : str; }

function RedactionHint() {
  return (
    <div style={{
      padding: 14, fontSize: 12, lineHeight: 1.6,
      background: 'rgba(245,180,90,0.08)',
      border: `1px solid ${COLORS.warning}`, borderRadius: 8,
      color: COLORS.textSecondary,
    }}>
      <strong style={{ color: COLORS.warning }}>Wi-Fi SSIDs are showing as &lt;redacted&gt;.</strong>{' '}
      This is macOS hiding the SSID from any app without Location Services permission — not Ark. To see real
      SSIDs, grant Location Services to your terminal: <em>System Settings → Privacy &amp; Security → Location Services
      → enable Terminal</em> (or iTerm, or whichever shell you launch <code>node</code> from). Then{' '}
      <code>launchctl kickstart -k gui/$(id -u)/co.sinsera.ark.hub</code>.
    </div>
  );
}

function NetworkTypeBadge({ type }) {
  const colors = {
    wifi:     { bg: 'rgba(34,211,238,0.14)',  fg: COLORS.accentBright },
    ethernet: { bg: 'rgba(245,180,90,0.14)',  fg: COLORS.warning },
    unknown:  { bg: 'rgba(124,132,153,0.14)', fg: COLORS.textMuted },
  };
  const c = colors[type] || colors.unknown;
  return (
    <span style={{
      padding: '2px 8px', fontSize: 11, borderRadius: 4,
      background: c.bg, color: c.fg,
      textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500,
    }}>{type || 'unknown'}</span>
  );
}

function ExportRow({ hubUrl }) {
  const items = [
    { label: 'Devices · CSV',   href: `${hubUrl}/api/export/devices.csv` },
    { label: 'Networks · CSV',  href: `${hubUrl}/api/export/networks.csv` },
    { label: 'Fleet snapshot · JSON', href: `${hubUrl}/api/export/snapshot.json` },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
      <span style={{ fontSize: 11, color: COLORS.textMuted, alignSelf: 'center', fontFamily: FONT_MONO }}>Export:</span>
      {items.map(i => (
        <a key={i.href} href={i.href} target="_blank" rel="noreferrer" style={{
          padding: '6px 12px', fontSize: 12, fontFamily: FONT_BODY,
          background: COLORS.bgPanel, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6,
          textDecoration: 'none',
        }}>{i.label}</a>
      ))}
    </div>
  );
}

function GraphTab({ hubUrl }) {
  return (
    <Placeholder
      title="Network ↔ Device topology"
      body="Force-directed graph view — gated on multi-network data (need at least 2 networks observed) + Agent telemetry from at least one Pi reporting. The data is being collected; this view appears in Phase 4.4."
    />
  );
}

function Placeholder({ title, body }) {
  return (
    <div style={{
      padding: 28, background: COLORS.bgPanel,
      border: `1px dashed ${COLORS.border}`, borderRadius: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20, color: COLORS.textSecondary }}>{title}</h3>
      <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13, lineHeight: 1.6 }}>{body}</p>
    </div>
  );
}

// ── Hub-unreachable error state ─────────────────────────────────────
function HubUnreachable({ hubUrl, error }) {
  return (
    <div style={{
      padding: 20, background: 'rgba(245, 180, 90, 0.06)',
      border: `1px solid ${COLORS.warning}`, borderRadius: 10,
      display: 'flex', gap: 14, alignItems: 'flex-start',
    }}>
      <AlertTriangle size={20} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
      <div>
        <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.warning }}>
          Can't reach the Ark Hub at {hubUrl}
        </h3>
        <p style={{ margin: '0 0 10px', color: COLORS.textSecondary, fontSize: 13, lineHeight: 1.6 }}>
          The Hub runs locally on the operator's machine and does the actual LAN scanning. The browser app talks to it via HTTP. Without the Hub running, no devices show.
        </p>
        <p style={{ margin: '0 0 10px', color: COLORS.textMuted, fontSize: 12, fontFamily: FONT_MONO }}>
          {error ? `error: ${error}` : 'no specific error returned'}
        </p>
        <div style={{
          padding: 12, background: COLORS.bgPanel, borderRadius: 6,
          fontFamily: FONT_MONO, fontSize: 12, color: COLORS.textPrimary,
          border: `1px solid ${COLORS.border}`,
        }}>
          <div style={{ color: COLORS.textMuted, marginBottom: 4 }}># start it from the Ark repo root</div>
          node hub/src/index.mjs
        </div>
      </div>
    </div>
  );
}

// ── Hub footer (override URL) ───────────────────────────────────────
function HubFooter({ hubUrl, setHubUrl }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(hubUrl);
  if (!editing) {
    return (
      <div style={{ marginTop: 12, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
        Hub: {hubUrl} · <a onClick={() => { setDraft(hubUrl); setEditing(true); }} style={{ color: COLORS.accent, cursor: 'pointer' }}>change</a>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, fontFamily: FONT_MONO }}>
      <input value={draft} onChange={e => setDraft(e.target.value)}
        style={{ flex: 1, padding: '6px 10px', background: COLORS.bgPanel, color: COLORS.textPrimary,
          border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_MONO, fontSize: 12, outline: 'none' }}/>
      <button onClick={() => {
        try { window.localStorage.setItem(HUB_KEY, draft.replace(/\/+$/, '')); } catch {}
        setHubUrl(draft.replace(/\/+$/, ''));
        setEditing(false);
      }} style={{ padding: '6px 12px', background: COLORS.bgActive, color: COLORS.accentBright,
        border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>save</button>
      <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent',
        color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>cancel</button>
    </div>
  );
}
