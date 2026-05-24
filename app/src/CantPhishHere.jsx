// Can't Phish Here — defensive security view.
//
// Spec: defensive-only. UI displays alerts, approved-host registry,
// and a hardening checklist. NEVER auto-runs anything aggressive
// against unapproved hosts. Recommendations only.

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Shield, AlertTriangle, Check, X, Plus, Trash2, Activity, Settings as SettingsIcon, ScrollText, Crosshair, Play, History, Square } from 'lucide-react';
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
  { id: 'raspyjack', label: 'RaspyJack', icon: Crosshair },
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
      {view === 'raspyjack' && <RaspyJackTab hubUrl={hubUrl}/>}
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

  const unapproved = devs.filter(d => !isApproved(d) && d.mac);

  async function approveAll() {
    if (unapproved.length === 0) return;
    if (!confirm(`Approve ${unapproved.length} devices currently on the LAN? You can revoke any of them later in Settings.`)) return;
    for (const d of unapproved) {
      await fetch(`${hubUrl}/api/cph/approved`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: d.mac, mac: d.mac,
          label: d.device_name || d.hostname || d.mac,
          notes: 'Bulk-approved from Devices view',
        }),
      });
    }
    refresh();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {unapproved.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(6,182,212,0.06)', border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: COLORS.textSecondary }}>
            {unapproved.length} unapproved device{unapproved.length === 1 ? '' : 's'} on the LAN. Auto-resolve their <code>new_device</code> alerts:
          </span>
          <button onClick={approveAll} style={{
            padding: '6px 14px', background: COLORS.bgActive, color: COLORS.accentBright,
            border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6,
            fontFamily: FONT_BODY, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            <Check size={12} style={{ verticalAlign: 'middle', marginRight: 4 }}/> Approve all
          </button>
        </div>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SchedulesSection hubUrl={hubUrl} checks={checks}/>
      <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 12, fontFamily: FONT_BODY, lineHeight: 1.6 }}>
        Below: full check catalogue with the shell commands. Schedule any check above to run automatically against
        a managed host via the SSH Runner; checks without an automated <code>probe</code> field stay manual.
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
// Hardening scheduler section — Phase 7.6 UI.
// Lists scheduled checks (host × check × interval) and lets the
// operator add / remove / toggle them. The Hub's scheduler tick
// fires due checks every minute.
function SchedulesSection({ hubUrl, checks }) {
  const [schedules, setSchedules] = useState([]);
  const [hosts,     setHosts]     = useState([]);
  const [form, setForm] = useState({ host_id: '', check_id: '', interval_hours: 24 });

  const refresh = useCallback(async () => {
    const [s, h] = await Promise.all([
      fetch(`${hubUrl}/api/cph/scheduled`).then(r => r.json()).catch(() => ({})),
      fetch(`${hubUrl}/api/runner/hosts`).then(r => r.json()).catch(() => ({})),
    ]);
    setSchedules(s.schedules || []);
    setHosts(h.hosts || []);
  }, [hubUrl]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t); }, [refresh]);

  // Only checks that have an automated probe can be scheduled
  const probedChecks = useMemo(() => checks.filter(c => c.probe), [checks]);

  async function add() {
    if (!form.host_id || !form.check_id) return;
    await fetch(`${hubUrl}/api/cph/scheduled`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, host_id: Number(form.host_id), interval_hours: Number(form.interval_hours) }),
    });
    setForm({ host_id: '', check_id: '', interval_hours: 24 });
    refresh();
  }
  async function remove(id) {
    await fetch(`${hubUrl}/api/cph/scheduled/${id}`, { method: 'DELETE' });
    refresh();
  }
  async function toggle(id, enabled) {
    await fetch(`${hubUrl}/api/cph/scheduled/${id}/toggle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  return (
    <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
      <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>
        Scheduled checks
      </h3>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
        Run an automated probe against a managed host every N hours. Findings land in the Logs tab; if a check that
        previously passed now fails, a <code>service_change</code> alert is raised. Requires the host to be registered
        in the SSH Runner.
      </p>

      {hosts.length === 0 ? (
        <div style={{ padding: 14, background: 'rgba(245,180,90,0.06)', border: `1px solid ${COLORS.warning}`, borderRadius: 6, color: COLORS.warning, fontSize: 12 }}>
          No SSH Runner hosts registered yet. Open the <strong>SSH Runner</strong> nav, add at least one host, then come back here.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 110px auto', gap: 8 }}>
            <select value={form.host_id} onChange={e => setForm(f => ({ ...f, host_id: e.target.value }))} style={inp}>
              <option value="">— host —</option>
              {hosts.map(h => <option key={h.id} value={h.id}>{h.label} ({h.ssh_target})</option>)}
            </select>
            <select value={form.check_id} onChange={e => setForm(f => ({ ...f, check_id: e.target.value }))} style={inp}>
              <option value="">— check —</option>
              {probedChecks.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input type="number" value={form.interval_hours} onChange={e => setForm(f => ({ ...f, interval_hours: e.target.value }))} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="hours"/>
            <button onClick={add} disabled={!form.host_id || !form.check_id} style={{
              padding: '6px 14px',
              background: (!form.host_id || !form.check_id) ? COLORS.bgPanel : COLORS.bgActive,
              color: (!form.host_id || !form.check_id) ? COLORS.textMuted : COLORS.accentBright,
              border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6, fontSize: 12,
              cursor: (!form.host_id || !form.check_id) ? 'not-allowed' : 'pointer',
            }}>schedule</button>
          </div>

          {schedules.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 14 }}>
              <thead>
                <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={th}>Host</th><th style={th}>Check</th>
                  <th style={th}>Every</th><th style={th}>Last run</th>
                  <th style={th}>Last result</th><th style={th}>Next due</th>
                  <th style={th}>On</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id}>
                    <td style={td}>{s.host_label}</td>
                    <td style={td}>{s.check_label}</td>
                    <td style={{ ...td, fontFamily: FONT_MONO }}>{s.interval_hours}h</td>
                    <td style={{ ...td, fontFamily: FONT_MONO, color: COLORS.textMuted }}>
                      {s.last_run_at ? s.last_run_at.slice(0, 16).replace('T', ' ') : 'never'}
                    </td>
                    <td style={td}>
                      {s.last_passed == null
                        ? <span style={{ color: COLORS.textMuted }}>—</span>
                        : <span style={{
                            padding: '2px 8px', fontSize: 11, borderRadius: 4, fontWeight: 600,
                            background: s.last_passed ? 'rgba(34,197,94,0.15)' : 'rgba(239,111,92,0.15)',
                            color:      s.last_passed ? COLORS.success : COLORS.error,
                          }}>{s.last_passed ? 'PASS' : 'FAIL'}</span>}
                    </td>
                    <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted }}>
                      {s.next_due ? s.next_due.slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                    <td style={td}>
                      <input type="checkbox" checked={!!s.enabled} onChange={e => toggle(s.id, e.target.checked)}/>
                    </td>
                    <td style={td}>
                      <button onClick={() => remove(s.id)} style={{ padding: '4px 10px', fontSize: 11, background: 'transparent', color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer' }}>
                        <Trash2 size={10}/> remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
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

// ── RaspyJack — defensive recon toolkit, driven via SSH Runner ──
// Hardcoded catalogue of NON-OFFENSIVE RaspyJack scripts. Each entry
// is the path to a script in /opt/raspyjack/ on a Pi that's been
// flashed with the sinsera-raspyjack profile. The Ark Hub never
// invokes anything from payloads/wifi/ , payloads/credentials/ ,
// DNSSpoof/ or Responder/ — those aren't here.
const RASPYJACK_TOOLS = [
  {
    id:      'mdns',
    label:   'mDNS service discovery',
    kind:    'passive',
    risk:    'safe',
    desc:    'Browse the LAN for advertised services (HomeKit, AirPlay, Matter, _arkagent, _ssh, _http, _printer, _smb …). Pure listener — sends nothing.',
    command: 'cd /opt/raspyjack && timeout 30 python3 payloads/reconnaissance/mdns_scanner.py 2>&1 | head -200',
  },
  {
    id:      'arp',
    label:   'ARP table snapshot',
    kind:    'passive',
    risk:    'safe',
    desc:    'Read the host\'s current ARP table. No probes sent — just the kernel\'s view of who answered recently.',
    command: 'cd /opt/raspyjack && timeout 15 python3 payloads/reconnaissance/arp_scan_stealth.py 2>&1 | head -200',
  },
  {
    id:      'cert',
    label:   'TLS cert audit (approved hosts only)',
    kind:    'active-but-light',
    risk:    'low',
    desc:    'For each approved host that exposes 443, fetch the cert and report expiry + cipher. One TLS handshake per host. Run only against hosts in your Can\'t Phish Here approved list.',
    command: 'cd /opt/raspyjack && timeout 30 python3 payloads/reconnaissance/cert_scanner.py 2>&1 | head -200',
  },
  {
    id:      'cctv',
    label:   'IP camera inventory',
    kind:    'active-but-light',
    risk:    'low',
    desc:    'Probe common CCTV ports (80 / 554 / 8080 / 8443) on the LAN to find IP cameras. Defensive inventory — don\'t aim this at someone else\'s network.',
    command: 'cd /opt/raspyjack && timeout 45 python3 payloads/reconnaissance/cctv_scanner.py 2>&1 | head -200',
  },
  {
    id:      'bt',
    label:   'Bluetooth Classic scan',
    kind:    'passive',
    risk:    'safe',
    desc:    'BR/EDR discovery in range. Reports MAC + name + class. Local-radio only.',
    command: 'cd /opt/raspyjack && timeout 30 python3 payloads/reconnaissance/bt_scan_classic.py 2>&1 | head -200',
  },
  {
    id:      'i2c',
    label:   'I²C bus scan (hardware-local)',
    kind:    'local-hardware',
    risk:    'safe',
    desc:    'Probe attached I²C devices (PiSugar, OLED, sensors). Useful for confirming HAT hardware. Never touches the network.',
    command: 'cd /opt/raspyjack && timeout 10 python3 payloads/hardware/i2c_scanner.py 2>&1 | head -100',
  },
];

const RISK_COLOUR = {
  safe:                COLORS.success,
  low:                 COLORS.warning,
  'local-hardware':    COLORS.accent,
  'active-but-light':  COLORS.warning,
  passive:             COLORS.success,
};

function RaspyJackTab({ hubUrl }) {
  const [hosts, setHosts]   = useState([]);
  const [hostId, setHostId] = useState('');
  const [running, setRunning] = useState(null);     // tool.id while running
  // { tool, host_label?, stdout, stderr, exit_code, duration_ms, ok, live, historic_at? }
  const [result, setResult]   = useState(null);
  const [hostsError, setHostsError] = useState(null);
  const [history, setHistory] = useState([]);
  const abortRef = useRef(null);

  const refreshHosts = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setHosts(j.hosts || []);
      setHostsError(null);
      if (!hostId && (j.hosts || []).length === 1) setHostId(j.hosts[0].id);
    } catch (e) { setHostsError(e.message); }
  }, [hubUrl, hostId]);
  useEffect(() => { refreshHosts(); const t = setInterval(refreshHosts, 15000); return () => clearInterval(t); }, [refreshHosts]);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/runner/log?reason=raspyjack&limit=20`);
      if (!r.ok) return;
      const j = await r.json();
      setHistory(j.log || []);
    } catch {}
  }, [hubUrl]);
  useEffect(() => { refreshHistory(); const t = setInterval(refreshHistory, 30000); return () => clearInterval(t); }, [refreshHistory]);

  // NDJSON streaming — read body chunks, parse line-by-line, append to result.
  async function run(tool) {
    if (!hostId) { alert('Pick a host first.'); return; }
    setRunning(tool.id);
    setResult({ tool, stdout: '', stderr: '', exit_code: null, duration_ms: 0, ok: false, live: true });

    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts/${hostId}/exec/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: tool.command, reason: 'raspyjack', timeoutMs: 60000 }),
        signal: ctl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'chunk') {
            setResult(prev => prev ? ({
              ...prev,
              stdout: ev.stream === 'stdout' ? prev.stdout + ev.data : prev.stdout,
              stderr: ev.stream === 'stderr' ? prev.stderr + ev.data : prev.stderr,
            }) : prev);
          } else if (ev.event === 'end') {
            setResult(prev => prev ? ({
              ...prev,
              exit_code:   ev.exit_code,
              duration_ms: ev.duration_ms || 0,
              ok:          !!ev.ok,
              live:        false,
            }) : prev);
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setResult(prev => prev ? ({ ...prev, stderr: (prev.stderr || '') + '\n' + e.message, live: false, ok: false, exit_code: -1 }) : prev);
      } else {
        setResult(prev => prev ? ({ ...prev, stderr: (prev.stderr || '') + '\n[cancelled by operator]', live: false, ok: false, exit_code: -2 }) : prev);
      }
    } finally {
      setRunning(null);
      abortRef.current = null;
      refreshHistory();
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
  }

  function loadHistoryEntry(entry) {
    const tool = RASPYJACK_TOOLS.find(t => t.command === entry.command) ||
      { id: 'historic', label: 'Custom command', desc: entry.command };
    setResult({
      tool,
      host_label:  entry.host_label,
      stdout:      entry.stdout_tail || '',
      stderr:      entry.stderr_tail || '',
      exit_code:   entry.exit_code,
      duration_ms: entry.duration_ms,
      ok:          entry.exit_code === 0,
      live:        false,
      historic_at: entry.ran_at,
    });
  }

  const selected = hosts.find(h => String(h.id) === String(hostId));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: 12, background: 'rgba(6,182,212,0.06)', border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.7 }}>
        <strong style={{ color: COLORS.accentBright }}>Defensive recon only.</strong> These scripts ship as part of the
        sinsera-raspyjack image. Ark refuses to dispatch anything from <code>payloads/wifi/</code>,
        <code> payloads/credentials/</code>, <code>DNSSpoof/</code>, or <code>Responder/</code> — those trees are
        excluded from the image we ship and aren't represented here. Run ONLY against hardware + networks you own.
      </div>

      {hostsError && (
        <div style={{ padding: 12, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 8, color: COLORS.warning, fontSize: 12 }}>
          Hub unreachable: {hostsError}. Open the SSH Runner nav to set up at least one managed host first.
        </div>
      )}

      {hosts.length === 0 ? (
        <div style={{ padding: 22, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10 }}>
          <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textPrimary }}>No managed hosts</h3>
          <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            RaspyJack runs <em>on a Pi you've flashed with the sinsera-raspyjack image</em>; Ark dispatches the scripts via
            the SSH Runner. Open the <strong>SSH Runner</strong> nav, register that Pi
            (e.g. <code>pi@RaspyJack.local</code>), then come back here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 14, alignItems: 'start' }}>
          {/* ── Main column ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <section style={{ padding: 12, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
              <label style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Run on host</label>
              <select value={hostId} onChange={e => setHostId(e.target.value)} style={{ ...inp, marginTop: 4, maxWidth: 480 }}>
                <option value="">— pick a host —</option>
                {hosts.map(h => <option key={h.id} value={h.id}>{h.label} ({h.ssh_target})</option>)}
              </select>
              {selected && (
                <div style={{ marginTop: 6, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
                  last reached: {selected.last_reached_at ? selected.last_reached_at.slice(11, 19) : 'never'} · status: {selected.last_status || 'unknown'}
                </div>
              )}
            </section>

            <section>
              <h3 style={{ margin: '0 0 10px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>
                Available scripts
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                {RASPYJACK_TOOLS.map(t => {
                  const isRunning = running === t.id;
                  return (
                    <div key={t.id} style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${isRunning ? COLORS.accentBorder : COLORS.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <strong style={{ color: COLORS.textPrimary, fontSize: 14 }}>{t.label}</strong>
                        <span style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 10, borderRadius: 4, background: (RISK_COLOUR[t.risk] || COLORS.textMuted) + '22', color: RISK_COLOUR[t.risk] || COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t.risk}</span>
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>{t.desc}</div>
                      <pre style={{ margin: 0, padding: 8, fontSize: 10, background: '#040608', color: COLORS.textSecondary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_MONO, overflow: 'auto' }}>{t.command}</pre>
                      {isRunning ? (
                        <button onClick={cancel} style={{
                          padding: '6px 12px', background: 'rgba(239,111,92,0.15)', color: COLORS.error,
                          border: `1px solid ${COLORS.error}`, borderRadius: 6,
                          fontSize: 12, fontFamily: FONT_BODY, fontWeight: 500, cursor: 'pointer',
                          alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <Square size={11}/> Cancel · streaming…
                        </button>
                      ) : (
                        <button onClick={() => run(t)} disabled={!hostId || running !== null} style={{
                          padding: '6px 12px',
                          background: (!hostId || running !== null) ? COLORS.bgPanel : COLORS.bgActive,
                          color: (!hostId || running !== null) ? COLORS.textMuted : COLORS.accentBright,
                          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6,
                          fontSize: 12, fontFamily: FONT_BODY, fontWeight: 500,
                          cursor: (!hostId || running !== null) ? 'not-allowed' : 'pointer',
                          alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <Play size={11}/> Run on this host
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {result && (() => {
              const borderColour =
                result.live ? COLORS.accentBorder :
                result.ok   ? COLORS.success :
                              COLORS.error;
              return (
                <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${borderColour}`, borderRadius: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    {result.live ? (
                      <span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: 'rgba(6,182,212,0.18)', color: COLORS.accentBright, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 3, background: COLORS.accentBright, animation: 'rj-pulse 0.9s ease-in-out infinite' }}/>
                        live
                      </span>
                    ) : (
                      <span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: result.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,111,92,0.15)', color: result.ok ? COLORS.success : COLORS.error, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        exit {result.exit_code}
                      </span>
                    )}
                    <span style={{ fontSize: 13, color: COLORS.textPrimary, fontWeight: 500 }}>{result.tool.label}</span>
                    {result.host_label && <span style={{ fontSize: 11, color: COLORS.textMuted }}>on {result.host_label}</span>}
                    {result.historic_at && <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>{result.historic_at.slice(0, 19).replace('T', ' ')}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
                      {result.duration_ms ? `${result.duration_ms} ms` : ''}
                    </span>
                  </div>
                  {result.stdout && <Output title="stdout" body={result.stdout} colour={COLORS.textPrimary}/>}
                  {result.stderr && <Output title="stderr" body={result.stderr} colour={COLORS.warning}/>}
                  {!result.stdout && !result.stderr && result.live && (
                    <div style={{ padding: 10, color: COLORS.textMuted, fontSize: 12, fontStyle: 'italic' }}>
                      waiting for first output…
                    </div>
                  )}
                </section>
              );
            })()}
          </div>

          {/* ── History sidebar ── */}
          <aside style={{ background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, position: 'sticky', top: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <History size={14} style={{ color: COLORS.textMuted }}/>
              <strong style={{ fontFamily: FONT_HEADING, fontSize: 14, color: COLORS.textPrimary }}>Recent runs</strong>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: COLORS.textMuted }}>last 20</span>
            </div>
            {history.length === 0 ? (
              <div style={{ padding: '12px 4px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
                No runs yet. Pick a script and click Run.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 480, overflowY: 'auto' }}>
                {history.map(h => {
                  const tool = RASPYJACK_TOOLS.find(t => t.command === h.command);
                  const label = tool ? tool.label : h.command.split(' ').slice(0, 5).join(' ');
                  const ok = h.exit_code === 0;
                  return (
                    <button key={h.id} onClick={() => loadHistoryEntry(h)} style={{
                      textAlign: 'left', padding: '8px 10px',
                      background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: 6,
                      cursor: 'pointer', color: COLORS.textPrimary,
                      display: 'flex', flexDirection: 'column', gap: 3,
                      fontFamily: FONT_BODY, fontSize: 12,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: ok ? COLORS.success : COLORS.error, flexShrink: 0 }}/>
                        <span style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                      </div>
                      <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: FONT_MONO, display: 'flex', justifyContent: 'space-between' }}>
                        <span>{h.host_label || `host#${h.host_id}`}</span>
                        <span>{h.ran_at.slice(11, 19)} · {h.duration_ms}ms</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}

      <style>{`@keyframes rj-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  );
}

function Output({ title, body, colour }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{title}</div>
      <pre style={{ margin: 0, padding: 10, background: '#040608', color: colour, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55, overflow: 'auto', maxHeight: 280, whiteSpace: 'pre-wrap' }}>
        {body}
      </pre>
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
      <WebhooksSection hubUrl={hubUrl}/>
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

function WebhooksSection({ hubUrl }) {
  const [hooks, setHooks] = useState([]);
  const [form,  setForm]  = useState({ label: '', url: '', kind: 'slack', min_severity: 'warn' });
  const refresh = useCallback(() => fetch(`${hubUrl}/api/cph/webhooks`).then(r => r.json()).then(j => setHooks(j.webhooks || [])), [hubUrl]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!form.label || !form.url) return;
    const r = await fetch(`${hubUrl}/api/cph/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const j = await r.json();
    if (!j.ok) { alert(j.error || 'failed'); return; }
    setForm({ label: '', url: '', kind: 'slack', min_severity: 'warn' });
    refresh();
  }
  async function remove(id) {
    if (!confirm('Remove this webhook?')) return;
    await fetch(`${hubUrl}/api/cph/webhooks/${id}`, { method: 'DELETE' });
    refresh();
  }
  async function toggle(id, enabled) {
    await fetch(`${hubUrl}/api/cph/webhooks/${id}/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  return (
    <section style={{ background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 14 }}>
      <h3 style={{ margin: '0 0 10px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>Webhooks</h3>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
        POST alerts to Slack, Discord, or any HTTPS endpoint. Fires on alerts at or above the chosen severity.
        Webhook bodies use the platform's native format (Slack attachments / Discord embeds / generic JSON).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 110px 110px auto', gap: 8 }}>
        <input placeholder="label (e.g. 'security-slack')"   value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} style={inp}/>
        <input placeholder="https://hooks.slack.com/services/…" value={form.url}   onChange={e => setForm(f => ({ ...f, url: e.target.value }))}   style={inp}/>
        <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} style={inp}>
          <option value="slack">slack</option>
          <option value="discord">discord</option>
          <option value="generic">generic</option>
        </select>
        <select value={form.min_severity} onChange={e => setForm(f => ({ ...f, min_severity: e.target.value }))} style={inp}>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="critical">critical only</option>
        </select>
        <button onClick={add} style={{ padding: '6px 14px', background: COLORS.bgActive, color: COLORS.accentBright, border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
          add
        </button>
      </div>
      {hooks.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12 }}>
          <thead>
            <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <th style={th}>Label</th><th style={th}>Kind</th><th style={th}>URL</th><th style={th}>Min severity</th>
              <th style={th}>Last fired</th><th style={th}>Status</th><th style={th}>Enabled</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map(h => (
              <tr key={h.id}>
                <td style={td}>{h.label}</td>
                <td style={td}><span style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, background: COLORS.bgActive, color: COLORS.accentBright, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h.kind}</span></td>
                <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.url}</td>
                <td style={td}>{h.min_severity}</td>
                <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted }}>{h.last_fired_at ? h.last_fired_at.slice(11, 19) : 'never'}</td>
                <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 10, color: h.last_status?.startsWith('2') ? COLORS.success : COLORS.textMuted }}>{h.last_status || '—'}</td>
                <td style={td}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!h.enabled} onChange={e => toggle(h.id, e.target.checked)}/>
                  </label>
                </td>
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
    </section>
  );
}

const th  = { textAlign: 'left', padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}` };
const td  = { padding: '6px 10px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary };
const inp = { padding: '6px 10px', background: COLORS.bgPanel, color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_BODY, fontSize: 12 };
const inlineBtn = { padding: '4px 12px', fontSize: 11, background: 'transparent', color: COLORS.accent, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer' };
