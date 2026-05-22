// Flash Nodes UI — registered flasher Pis, their attached storage,
// and the queue of flash jobs. Tab 4 (Clone / Capture) is a
// placeholder until the Flash Agent grows source-side cloning.
//
// Hub at /api/flash/* is the orchestrator; this view never talks to
// a Flash Agent directly (that would break multi-network use).

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Server, HardDrive, Activity, AlertTriangle, Lock, Check, X, Plus } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

const TABS = [
  { id: 'nodes',  label: 'Nodes',   icon: Server   },
  { id: 'disks',  label: 'Storage', icon: HardDrive },
  { id: 'jobs',   label: 'Jobs',    icon: Activity },
  { id: 'clone',  label: 'Clone / Capture', icon: Plus },
];

export default function FlashNodes() {
  const hubUrl = readHubUrl();
  const [tab, setTab] = useState('nodes');
  const [selectedNode, setSelectedNode] = useState(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
          Flash Nodes
        </h2>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Network imaging appliances. A Pi 5 + USB SD reader registers as a flash node; the Hub queues jobs to it.
        </p>
      </header>

      <div style={{ display: 'flex', gap: 4, padding: 4, background: COLORS.bgPanel, borderRadius: 10, border: `1px solid ${COLORS.border}`, width: 'fit-content' }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px',
              background: active ? COLORS.bgActive : 'transparent',
              color: active ? COLORS.accentBright : COLORS.textSecondary,
              border: `1px solid ${active ? COLORS.accentBorder : 'transparent'}`,
              borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: FONT_BODY, fontWeight: 500,
            }}><Icon size={14}/> {t.label}</button>
          );
        })}
      </div>

      {tab === 'nodes' && <NodesTab hubUrl={hubUrl} onPick={(id) => { setSelectedNode(id); setTab('disks'); }}/>}
      {tab === 'disks' && <DisksTab hubUrl={hubUrl} nodeId={selectedNode} onPickNode={setSelectedNode}/>}
      {tab === 'jobs'  && <JobsTab  hubUrl={hubUrl}/>}
      {tab === 'clone' && <ClonePlaceholder/>}
    </div>
  );
}

// ── Tab 1: Nodes ────────────────────────────────────────────────
function NodesTab({ hubUrl, onPick }) {
  const [state, setState] = useState({ status: 'loading', nodes: [], error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/flash/nodes`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setState({ status: 'ok', nodes: j.nodes || [], error: null });
    } catch (e) { setState(s => ({ ...s, status: 'error', error: e.message })); }
  }, [hubUrl]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  if (state.status === 'error') return <Err msg={state.error} hubUrl={hubUrl}/>;
  if (state.nodes.length === 0) return <Empty title="No flash nodes registered yet" body={
    <>Install on a Pi: <code style={{ fontFamily: FONT_MONO }}>sudo HUB_URL={hubUrl} bash agent/install-flash-agent.sh</code>. Once it starts, it auto-registers.</>
  }/>;

  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={th}>Name</th><th style={th}>Status</th><th style={th}>Model</th><th style={th}>Capabilities</th><th style={th}>Agent URL</th><th style={th}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {state.nodes.map(n => (
            <tr key={n.node_id} style={{ cursor: 'pointer' }} onClick={() => onPick(n.node_id)}>
              <td style={td}>{n.node_name} <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{n.node_id}</span></td>
              <td style={td}><StatusBadge status={n.status}/></td>
              <td style={td}>{n.hardware_model || '—'}</td>
              <td style={td}>{(n.capabilities || []).join(', ') || '—'}</td>
              <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{n.agent_url}</td>
              <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{humanAge(new Date(n.last_seen).getTime())}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }) {
  const c = status === 'idle' ? COLORS.success
          : status === 'busy' ? COLORS.warning
          : status === 'offline' ? COLORS.error : COLORS.textMuted;
  return <span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: c + '22', color: c, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{status}</span>;
}

// ── Tab 2: Storage ──────────────────────────────────────────────
// The Hub doesn't store disk listings (they change too fast). We
// fetch from the agent directly. Operator may need to allow CORS
// from the agent (it's permissive by default).
function DisksTab({ hubUrl, nodeId, onPickNode }) {
  const [nodes, setNodes] = useState([]);
  const [picked, setPicked] = useState(nodeId);
  const [disks, setDisks] = useState({ status: 'idle', list: [], rootDisk: null, error: null });

  useEffect(() => {
    fetch(`${hubUrl}/api/flash/nodes`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { nodes: [] })
      .then(j => setNodes(j.nodes || []))
      .catch(() => setNodes([]));
  }, [hubUrl]);

  useEffect(() => { if (nodeId && nodeId !== picked) setPicked(nodeId); }, [nodeId]);

  const node = useMemo(() => nodes.find(n => n.node_id === picked), [nodes, picked]);

  useEffect(() => {
    if (!node) { setDisks({ status: 'idle', list: [], rootDisk: null, error: null }); return; }
    setDisks(s => ({ ...s, status: 'loading' }));
    fetch(`${node.agent_url.replace(/\/+$/, '')}/disks`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => setDisks({ status: 'ok', list: j.disks || [], rootDisk: j.root_disk, error: null }))
      .catch(e => setDisks({ status: 'error', list: [], rootDisk: null, error: e.message }));
  }, [node?.agent_url]);

  if (nodes.length === 0) return <Empty title="No flash nodes registered" body="Register a Flash Agent first (see Nodes tab)."/>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <label style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO, marginRight: 8 }}>NODE:</label>
        <select value={picked || ''} onChange={(e) => { setPicked(e.target.value); onPickNode(e.target.value); }} style={{
          padding: '6px 10px', background: COLORS.bgPanel, color: COLORS.textPrimary,
          border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_BODY, fontSize: 13,
        }}>
          <option value="">— pick a node —</option>
          {nodes.map(n => <option key={n.node_id} value={n.node_id}>{n.node_name} ({n.node_id})</option>)}
        </select>
      </div>
      {!node ? <Empty title="Pick a node above" body="Disks are queried from the Flash Agent live; nothing is cached server-side."/>
       : disks.status === 'loading' ? <div style={{ padding: 16, color: COLORS.textMuted }}>Loading disks from {node.agent_url}…</div>
       : disks.status === 'error' ? <Err msg={`Couldn't reach ${node.agent_url}: ${disks.error}`}/>
       : disks.list.length === 0 ? <Empty title="No disks attached" body="Plug in a USB SD reader or SSD and refresh."/>
       : <DiskTable disks={disks.list} rootDisk={disks.rootDisk}/>}
    </div>
  );
}

function DiskTable({ disks, rootDisk }) {
  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={th}>Path</th><th style={th}>Type</th><th style={th}>Size</th><th style={th}>Model</th><th style={th}>State</th><th style={th}>Safe?</th>
          </tr>
        </thead>
        <tbody>
          {disks.map(d => (
            <tr key={d.path}>
              <td style={{ ...td, fontFamily: FONT_MONO }}>{d.path}{d.is_root_disk && <span style={{ marginLeft: 6, color: COLORS.error, fontSize: 11 }}>(root)</span>}</td>
              <td style={td}><span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: COLORS.bgActive, color: COLORS.accentBright, textTransform: 'uppercase', letterSpacing: 0.5 }}>{d.type}</span></td>
              <td style={{ ...td, fontFamily: FONT_MONO }}>{prettyBytes(d.size)}</td>
              <td style={td}>{[d.vendor, d.model].filter(Boolean).join(' ') || '—'}</td>
              <td style={{ ...td, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
                {d.removable ? 'removable' : 'fixed'}{d.mounted ? ' · mounted' : ''}{d.readonly ? ' · ro' : ''}
              </td>
              <td style={td}>
                {d.safe_to_write
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: COLORS.success }}><Check size={12}/> safe</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: COLORS.error }}><Lock size={12}/> protected</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab 3: Jobs ─────────────────────────────────────────────────
function JobsTab({ hubUrl }) {
  const [state, setState] = useState({ status: 'loading', jobs: [], error: null });
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/flash/jobs`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setState({ status: 'ok', jobs: j.jobs || [], error: null });
    } catch (e) { setState(s => ({ ...s, status: 'error', error: e.message })); }
  }, [hubUrl]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);

  if (state.status === 'error') return <Err msg={state.error} hubUrl={hubUrl}/>;
  if (state.jobs.length === 0) return <Empty title="No flash jobs yet" body="Once you queue one from the device builder it'll appear here with live progress."/>;

  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={th}>Job</th><th style={th}>Node</th><th style={th}>Image</th><th style={th}>Target</th>
            <th style={th}>State</th><th style={th}>Progress</th><th style={th}>Speed</th><th style={th}>ETA</th>
          </tr>
        </thead>
        <tbody>
          {state.jobs.map(j => <JobRow key={j.job_id} j={j}/>)}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({ j }) {
  const colour = stateColour(j.state);
  return (
    <tr>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{j.job_id}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{j.node_id}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{j.image_id}</td>
      <td style={{ ...td, fontFamily: FONT_MONO }}>{j.target_disk_path}</td>
      <td style={td}><span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: colour + '22', color: colour, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{j.state}</span></td>
      <td style={td}>
        <div style={{ width: 100, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${j.progress_pct || 0}%`, height: '100%', background: colour, transition: 'width 200ms ease' }}/>
        </div>
        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO, marginLeft: 6 }}>{j.progress_pct || 0}%</span>
      </td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{j.write_speed_mbps ? `${j.write_speed_mbps} MB/s` : '—'}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{j.eta_s ? `${j.eta_s}s` : '—'}</td>
    </tr>
  );
}

function stateColour(s) {
  if (s === 'completed') return COLORS.success;
  if (s === 'failed' || s === 'cancelled') return COLORS.error;
  if (['queued', 'paused'].includes(s)) return COLORS.textMuted;
  return COLORS.accent;
}

// ── Tab 4: Clone / Capture (placeholder) ────────────────────────
function ClonePlaceholder() {
  return (
    <div style={{
      padding: 28, background: COLORS.bgPanel,
      border: `1px dashed ${COLORS.border}`, borderRadius: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20, color: COLORS.textSecondary }}>Clone / Capture</h3>
      <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13, lineHeight: 1.6 }}>
        SD → image, SSD → image, and live-Pi golden-image capture all flow through the Flash Agent. The agent code is staged; UI for source-side reads lands when the first node validates.
      </p>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────
function Empty({ title, body }) {
  return (
    <div style={{ padding: 22, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10, color: COLORS.textMuted }}>
      <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textSecondary }}>{title}</h3>
      <div style={{ fontSize: 13 }}>{body}</div>
    </div>
  );
}
function Err({ msg, hubUrl }) {
  return (
    <div style={{ padding: 16, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <AlertTriangle size={18} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
      <div>
        <strong style={{ color: COLORS.warning }}>Hub unreachable</strong>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: COLORS.textSecondary }}>{msg}{hubUrl ? ` (at ${hubUrl})` : ''}</p>
      </div>
    </div>
  );
}
const th = { textAlign: 'left', padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` };
const td = { padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary, whiteSpace: 'nowrap' };
function prettyBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}
function humanAge(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60)    return `${Math.round(diff)}s ago`;
  if (diff < 3600)  return `${Math.round(diff/60)}m ago`;
  if (diff < 86400) return `${Math.round(diff/3600)}h ago`;
  return `${Math.round(diff/86400)}d ago`;
}
