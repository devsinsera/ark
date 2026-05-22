// Can't Phish Here — defensive security view.
//
// Spec: defensive-only. UI displays alerts, approved-host registry,
// and a hardening checklist. NEVER auto-runs anything aggressive
// against unapproved hosts. Recommendations only.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Shield, AlertTriangle, Check, X, Plus, Trash2, Activity, Settings as SettingsIcon, ScrollText } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

const VIEWS = [
  { id: 'overview',  label: 'Overview',  icon: Shield },
  { id: 'devices',   label: 'Devices',   icon: Activity },
  { id: 'alerts',    label: 'Alerts',    icon: AlertTriangle },
  { id: 'logs',      label: 'Logs',      icon: ScrollText },
  { id: 'hardening', label: 'Hardening', icon: Check },
  { id: 'settings',  label: 'Settings',  icon: SettingsIcon },
];

export default function CantPhishHere() {
  const hubUrl = readHubUrl();
  const [view, setView] = useState('overview');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={20} style={{ color: COLORS.accent }}/>
          <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
            Can't Phish Here
          </h2>
        </div>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Defensive security guardian for owned + approved infrastructure. Read-only monitoring; never probes
          unapproved targets, never attempts credentials, never injects traffic.
        </p>
      </header>

      <div style={{ display: 'flex', gap: 4, padding: 4, background: COLORS.bgPanel, borderRadius: 10, border: `1px solid ${COLORS.border}`, width: 'fit-content', flexWrap: 'wrap' }}>
        {VIEWS.map(v => {
          const Icon = v.icon;
          const active = view === v.id;
          return (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px',
              background: active ? COLORS.bgActive : 'transparent',
              color: active ? COLORS.accentBright : COLORS.textSecondary,
              border: `1px solid ${active ? COLORS.accentBorder : 'transparent'}`,
              borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: FONT_BODY, fontWeight: 500,
            }}><Icon size={14}/> {v.label}</button>
          );
        })}
      </div>

      {view === 'overview'  && <OverviewTab hubUrl={hubUrl}/>}
      {view === 'devices'   && <DevicesTab hubUrl={hubUrl}/>}
      {view === 'alerts'    && <AlertsTab hubUrl={hubUrl}/>}
      {view === 'logs'      && <LogsTab hubUrl={hubUrl}/>}
      {view === 'hardening' && <HardeningTab hubUrl={hubUrl}/>}
      {view === 'settings'  && <SettingsTab hubUrl={hubUrl}/>}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────
function OverviewTab({ hubUrl }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const tick = () => fetch(`${hubUrl}/api/cph/overview`).then(r => r.json()).then(setData).catch(() => {});
    tick();
    const t = setInterval(tick, 10000);
    return () => clearInterval(t);
  }, [hubUrl]);

  if (!data) return <div style={{ color: COLORS.textMuted }}>Loading…</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      <StatTile label="Critical alerts"  value={data.alerts.critical || 0} colour={data.alerts.critical ? COLORS.error : COLORS.success}/>
      <StatTile label="Warnings"         value={data.alerts.warn || 0}    colour={data.alerts.warn ? COLORS.warning : COLORS.success}/>
      <StatTile label="Info notices"     value={data.alerts.info || 0}    colour={COLORS.textMuted}/>
      <StatTile label="Approved hosts"   value={data.approved}            colour={COLORS.accent}/>
      <StatTile label="Devices on LAN"   value={data.device_count}        colour={COLORS.textPrimary}/>
      <StatTile label="Hardening checks" value={data.checks}              colour={COLORS.textPrimary}/>
    </div>
  );
}
function StatTile({ label, value, colour }) {
  return (
    <div style={{ padding: 16, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontFamily: FONT_HEADING, fontSize: 36, color: colour, marginTop: 4 }}>{value}</div>
    </div>
  );
}

// ── Devices ─────────────────────────────────────────────────────
// Re-render the LAN device list with an approved/unapproved column.
function DevicesTab({ hubUrl }) {
  const [devs, setDevs]         = useState([]);
  const [approved, setApproved] = useState([]);
  const refresh = useCallback(async () => {
    const [d, a] = await Promise.all([
      fetch(`${hubUrl}/api/devices`).then(r => r.json()),
      fetch(`${hubUrl}/api/cph/approved`).then(r => r.json()),
    ]);
    setDevs(d.devices || []);
    setApproved(a.hosts || []);
  }, [hubUrl]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  const isApproved = useMemo(() => (d) => approved.some(a =>
    (a.mac && d.mac && a.mac.toLowerCase() === d.mac.toLowerCase()) ||
    (a.device_id && d.id === a.device_id)
  ), [approved]);

  async function approve(d) {
    await fetch(`${hubUrl}/api/cph/approved`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_id: d.mac || d.id,
        label: d.device_name || d.hostname || d.mac || d.ip,
        mac: d.mac,
        notes: `Approved from Devices view`,
      }),
    });
    refresh();
  }

  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={th}>IP</th><th style={th}>Name</th><th style={th}>MAC</th><th style={th}>Vendor</th><th style={th}>Status</th><th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {devs.map(d => {
            const ok = isApproved(d);
            return (
              <tr key={d.id || (d.ip + d.mac)}>
                <td style={{ ...td, fontFamily: FONT_MONO }}>{d.ip}</td>
                <td style={td}>{d.device_name || d.hostname || '—'}</td>
                <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{d.mac || '—'}</td>
                <td style={td}>{d.vendor || '—'}</td>
                <td style={td}>
                  {ok
                    ? <span style={{ color: COLORS.success, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}><Check size={12}/> approved</span>
                    : <span style={{ color: COLORS.warning, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}><AlertTriangle size={12}/> unapproved</span>}
                </td>
                <td style={td}>
                  {!ok && d.mac && (
                    <button onClick={() => approve(d)} style={{
                      padding: '4px 12px', fontSize: 11, background: 'transparent',
                      color: COLORS.accent, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
                    }}>approve</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Alerts ──────────────────────────────────────────────────────
function AlertsTab({ hubUrl }) {
  const [state, setState] = useState({ alerts: [], showResolved: false });
  const refresh = useCallback(async () => {
    const r = await fetch(`${hubUrl}/api/cph/alerts${state.showResolved ? '?include_resolved=1' : ''}`);
    const j = await r.json();
    setState(s => ({ ...s, alerts: j.alerts || [] }));
  }, [hubUrl, state.showResolved]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [refresh]);

  async function ack(id)     { await fetch(`${hubUrl}/api/cph/alerts/${id}/ack`,     { method: 'POST' }); refresh(); }
  async function resolve(id) { await fetch(`${hubUrl}/api/cph/alerts/${id}/resolve`, { method: 'POST' }); refresh(); }

  if (state.alerts.length === 0) return (
    <div style={{ padding: 24, color: COLORS.textMuted, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10 }}>
      <strong style={{ color: COLORS.success }}>All clear.</strong> No {state.showResolved ? '' : 'unresolved '}alerts.
      <div style={{ marginTop: 8 }}>
        <button onClick={() => setState(s => ({ ...s, showResolved: !s.showResolved }))} style={inlineBtn}>
          {state.showResolved ? 'Hide resolved' : 'Show resolved too'}
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button onClick={() => setState(s => ({ ...s, showResolved: !s.showResolved }))} style={{ ...inlineBtn, alignSelf: 'flex-start' }}>
        {state.showResolved ? 'Hide resolved' : 'Show resolved too'}
      </button>
      {state.alerts.map(a => (
        <div key={a.id} style={{
          padding: 12, borderRadius: 8,
          background: COLORS.bgPanel,
          border: `1px solid ${severityColour(a.severity)}`,
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, background: severityColour(a.severity) + '22', color: severityColour(a.severity), textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>{a.severity}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{a.kind}</span>
              {a.acknowledged_at && <span style={{ fontSize: 10, color: COLORS.textMuted }}>ack'd</span>}
              {a.resolved_at && <span style={{ fontSize: 10, color: COLORS.success }}>resolved</span>}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: COLORS.textPrimary }}>{a.subject}</div>
            {a.detail_json && (
              <pre style={{ marginTop: 6, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 4, fontSize: 11, color: COLORS.textSecondary, fontFamily: FONT_MONO, overflow: 'auto', maxHeight: 80 }}>
                {prettyJson(a.detail_json)}
              </pre>
            )}
            <div style={{ marginTop: 4, fontSize: 10, color: COLORS.textMuted, fontFamily: FONT_MONO }}>{a.detected_at}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {!a.acknowledged_at && !a.resolved_at && <button onClick={() => ack(a.id)} style={inlineBtn}>ack</button>}
            {!a.resolved_at && <button onClick={() => resolve(a.id)} style={inlineBtn}>resolve</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
function severityColour(s) {
  return s === 'critical' ? COLORS.error : s === 'warn' ? COLORS.warning : COLORS.textMuted;
}
function prettyJson(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }

// ── Logs ────────────────────────────────────────────────────────
function LogsTab({ hubUrl }) {
  const [data, setData] = useState({ findings: [], alerts: [] });
  useEffect(() => {
    const tick = async () => {
      const [f, a] = await Promise.all([
        fetch(`${hubUrl}/api/cph/findings`).then(r => r.json()),
        fetch(`${hubUrl}/api/cph/alerts?include_resolved=1&limit=50`).then(r => r.json()),
      ]);
      setData({ findings: f.findings || [], alerts: a.alerts || [] });
    };
    tick(); const t = setInterval(tick, 10000); return () => clearInterval(t);
  }, [hubUrl]);

  const events = [
    ...data.alerts.map(a => ({ kind: 'alert', when: a.detected_at, label: `${a.severity}/${a.kind}: ${a.subject}` })),
    ...data.findings.map(f => ({ kind: 'finding', when: f.checked_at, label: `${f.target_label} → ${f.check_id} ${f.ok ? 'OK' : 'FAIL'}` })),
  ].sort((a, b) => b.when.localeCompare(a.when));

  if (events.length === 0) return <div style={{ padding: 16, color: COLORS.textMuted }}>No events yet.</div>;

  return (
    <div style={{ background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 14 }}>
      <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
        {events.map((e, i) => `${e.when.slice(0,19).replace('T',' ')}  [${e.kind}]  ${e.label}`).join('\n')}
      </pre>
    </div>
  );
}

// ── Hardening ───────────────────────────────────────────────────
function HardeningTab({ hubUrl }) {
  const [checks, setChecks] = useState([]);
  useEffect(() => {
    fetch(`${hubUrl}/api/cph/checks`).then(r => r.json()).then(j => setChecks(j.checks || []));
  }, [hubUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 12, fontFamily: FONT_BODY, lineHeight: 1.6 }}>
        Manual checklist. Each item links to a non-invasive shell command you can run on your own systems.
        Ark does NOT auto-run these — they're recommendations, not actions.
      </p>
      {checks.map(c => (
        <div key={c.id} style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              padding: '2px 8px', fontSize: 10, borderRadius: 4,
              background: severityColour(c.severity) + '22',
              color: severityColour(c.severity),
              textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700,
            }}>{c.severity}</span>
            <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{c.label}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted, marginLeft: 'auto' }}>{c.id}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>{c.rationale}</div>
          <div style={{ marginTop: 8 }}>
            <CodeBlock label="How to check" code={c.how_to_check}/>
            <CodeBlock label="How to fix"   code={c.how_to_fix}/>
          </div>
        </div>
      ))}
    </div>
  );
}
function CodeBlock({ label, code }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <pre style={{
        margin: 0, padding: 8, fontFamily: FONT_MONO, fontSize: 11,
        background: 'rgba(0,0,0,0.4)', border: `1px solid ${COLORS.border}`,
        borderRadius: 4, color: COLORS.textPrimary, overflow: 'auto',
      }}>{code}</pre>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────
function SettingsTab({ hubUrl }) {
  const [hosts, setHosts] = useState([]);
  const [form, setForm]   = useState({ label: '', mac: '', ip_pattern: '', notes: '' });

  const refresh = useCallback(() => fetch(`${hubUrl}/api/cph/approved`).then(r => r.json()).then(j => setHosts(j.hosts || [])), [hubUrl]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!form.label) return;
    await fetch(`${hubUrl}/api/cph/approved`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    setForm({ label: '', mac: '', ip_pattern: '', notes: '' });
    refresh();
  }
  async function remove(id) {
    await fetch(`${hubUrl}/api/cph/approved/${id}`, { method: 'DELETE' });
    refresh();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section style={{ background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>Approved hosts</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
          Hosts you have written authorisation to monitor. Anything NOT on this list is treated as untrusted —
          Ark will alert on its presence but never probe it.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 8 }}>
          <input placeholder="label (e.g. SinseraCore)"  value={form.label}      onChange={e => setForm(f => ({ ...f, label: e.target.value }))}      style={inp}/>
          <input placeholder="MAC (e.g. 88:a2:9e:…)"      value={form.mac}        onChange={e => setForm(f => ({ ...f, mac: e.target.value }))}        style={inp}/>
          <input placeholder="IP or CIDR (192.168.4.0/24)" value={form.ip_pattern} onChange={e => setForm(f => ({ ...f, ip_pattern: e.target.value }))} style={inp}/>
          <input placeholder="notes"                       value={form.notes}      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}      style={inp}/>
          <button onClick={add} style={{ padding: '6px 14px', background: COLORS.bgActive, color: COLORS.accentBright, border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            <Plus size={11} style={{ verticalAlign: 'middle' }}/> approve
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          {hosts.length === 0
            ? <div style={{ color: COLORS.textMuted, fontSize: 12 }}>No approved hosts yet — add some above.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    <th style={th}>Label</th><th style={th}>MAC</th><th style={th}>IP pattern</th><th style={th}>Notes</th><th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {hosts.map(h => (
                    <tr key={h.id}>
                      <td style={td}>{h.label}</td>
                      <td style={{ ...td, fontFamily: FONT_MONO }}>{h.mac || '—'}</td>
                      <td style={{ ...td, fontFamily: FONT_MONO }}>{h.ip_pattern || '—'}</td>
                      <td style={{ ...td, fontFamily: FONT_BODY, color: COLORS.textMuted }}>{h.notes || ''}</td>
                      <td style={td}>
                        <button onClick={() => remove(h.id)} style={{ padding: '4px 10px', fontSize: 11, background: 'transparent', color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer' }}>
                          <Trash2 size={10}/> remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </section>
      <section style={{ background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>Safety posture</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.textSecondary, fontSize: 12, lineHeight: 1.8 }}>
          <li>Active probes (port scan, HTTP banner, cert fetch) hit ONLY approved IP patterns.</li>
          <li>Brute-force / default-credentials scanning is permanently disabled in this module.</li>
          <li>Unknown devices generate ALERTS — they're never automatically interacted with.</li>
          <li>Recommendations only. No automatic firewall changes, package upgrades, or service restarts.</li>
        </ul>
      </section>
    </div>
  );
}

const th  = { textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}` };
const td  = { padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary };
const inp = { padding: '6px 10px', background: COLORS.bgPanel, color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_BODY, fontSize: 12 };
const inlineBtn = { padding: '4px 12px', fontSize: 11, background: 'transparent', color: COLORS.accent, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer' };
