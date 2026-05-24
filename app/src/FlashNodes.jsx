// Flash Nodes UI — registered flasher Pis, their attached storage,
// and the queue of flash jobs. Tab 4 (Clone / Capture) is a
// placeholder until the Flash Agent grows source-side cloning.
//
// Hub at /api/flash/* is the orchestrator; this view never talks to
// a Flash Agent directly (that would break multi-network use).

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Server, HardDrive, Activity, AlertTriangle, Lock, Check, X, Plus, Trash2, StopCircle, Download } from 'lucide-react';
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
  { id: 'images', label: 'Images',  icon: HardDrive },
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

      {tab === 'nodes'  && <NodesTab hubUrl={hubUrl} onPick={(id) => { setSelectedNode(id); setTab('disks'); }}/>}
      {tab === 'disks'  && <DisksTab hubUrl={hubUrl} nodeId={selectedNode} onPickNode={setSelectedNode}/>}
      {tab === 'jobs'   && <JobsTab  hubUrl={hubUrl}/>}
      {tab === 'images' && <ImagesTab hubUrl={hubUrl}/>}
      {tab === 'clone'  && <ClonePlaceholder/>}
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

  async function removeNode(nodeId) {
    if (!confirm('Remove this flash node from the registry? The Pi keeps running; only Ark forgets about it.')) return;
    const r = await fetch(`${hubUrl}/api/flash/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) alert(j.error || 'failed');
    refresh();
  }

  if (state.status === 'error') return <Err msg={state.error} hubUrl={hubUrl}/>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <NodeSetupGuide hubUrl={hubUrl} hasNodes={state.nodes.length > 0}/>
      {state.nodes.length > 0 && (
        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={th}>Name</th><th style={th}>Status</th><th style={th}>Model</th><th style={th}>Capabilities</th><th style={th}>Agent URL</th><th style={th}>Last seen</th><th style={th}></th>
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
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => removeNode(n.node_id)} title="Remove from registry" style={{
                      padding: '4px 10px', fontSize: 11, background: 'transparent',
                      color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
                    }}><Trash2 size={10}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Step-by-step Flash Node setup guide. Shown expanded when no nodes
// are registered yet; shown collapsed (with a "Show setup guide"
// toggle) once at least one is connected. Each step has the exact
// command + expected output so an operator can verify without
// guessing.
function NodeSetupGuide({ hubUrl, hasNodes }) {
  const [open, setOpen] = useState(!hasNodes);
  useEffect(() => { setOpen(!hasNodes); }, [hasNodes]);

  const hubHost = hubUrl.replace(/^https?:\/\//, '').replace(/:.*$/, '');
  // If the operator's still pointing at localhost we tell them
  // that's not what the Pi should hit
  const isLocal = hubHost === 'localhost' || hubHost === '127.0.0.1';
  const hubLanWarning = isLocal ? (
    <div style={{ marginTop: 8, padding: 10, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 6, color: COLORS.warning, fontSize: 12, lineHeight: 1.6 }}>
      <strong>⚠ Heads-up:</strong> your Hub URL is <code>{hubUrl}</code>. The Pi needs an URL it can reach from its own network —
      use your Mac's LAN IP instead (e.g. <code>http://192.168.5.80:7400</code>). Change the URL in the sidebar footer.
    </div>
  ) : null;

  return (
    <section style={{ background: COLORS.bgPanel, border: `1px solid ${hasNodes ? COLORS.border : COLORS.accentBorder}`, borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '12px 16px', textAlign: 'left',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: hasNodes ? COLORS.textSecondary : COLORS.accentBright,
          display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: FONT_HEADING, fontSize: 16,
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease', display: 'inline-block', fontSize: 12 }}>▶</span>
        {hasNodes ? 'Set up another Flash Node' : 'Set up your first Flash Node'}
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_BODY }}>5 steps · ~10 min</span>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {hubLanWarning}

          <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            A Flash Node is a Pi (usually a Pi 5 with a USB SD reader plugged in) that writes images to SD cards on
            command from the Hub. The Pi runs a lightweight FastAPI agent that registers itself with this Hub and waits for jobs.
          </p>

          <SetupStep
            num={1}
            title="Flash a base OS onto an SD card and boot the Pi"
            body={<>
              The simplest path: flash <strong>Sinsera Vanilla</strong> (DietPi with your SSH key + locale + hostname pre-baked).
              Download from the <strong>Images</strong> tab next to it, or grab the file at
              <code style={{ display: 'block', marginTop: 4, padding: 6, background: '#040608', borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11 }}>
                ~/Dev-Sinsera/Ark/builds/sinsera-vanilla/out/ark-built.img.xz
              </code>
              Edit <code>/boot/dietpi.txt</code> on the SD before booting to add your Wi-Fi creds.
              Insert the SD, plug in <strong>HDMI + power + USB SD reader</strong>, and wait ~60 s for first boot.
            </>}
          />

          <SetupStep
            num={2}
            title="SSH into the Pi from this Mac"
            body={<>
              The vanilla image has SSH key auth pre-baked, so this should work without a password:
              <Cmd>{`ssh root@SinseraCore.local`}</Cmd>
              If <code>.local</code> doesn't resolve, find the Pi's IP in the <strong>Network</strong> tab and use that
              instead (e.g. <code>ssh root@192.168.5.123</code>). First connection asks you to accept the host key —
              type <code>yes</code>.
            </>}
          />

          <SetupStep
            num={3}
            title="Pull the Ark agent installer onto the Pi"
            body={<>
              The Flash Agent (~400 lines of Python + a systemd unit) lives in the Ark repo. Quickest path is
              clone the repo onto the Pi:
              <Cmd>{`apt-get update && apt-get install -y --no-install-recommends git
git clone --depth=1 https://github.com/devsinsera/ark.git /opt/ark`}</Cmd>
              (Or scp the <code>agent/</code> folder from your Mac if the Pi can't reach GitHub directly.)
            </>}
          />

          <SetupStep
            num={4}
            title="Install + start the Flash Agent"
            body={<>
              On the Pi:
              <Cmd>{`cd /opt/ark
sudo HUB_URL=http://${hubHost}:7400 bash agent/install-flash-agent.sh`}</Cmd>
              The installer does <strong>apt-installs FastAPI + uvicorn deps</strong>, drops the agent at
              <code> /opt/ark-flash/ark-flash-agent.py</code>, writes a systemd unit (<code>ark-flash-agent.service</code>),
              and starts it. Total time ~2 min. Expected last line: <code>✓ ark-flash-agent listening on :7410</code>.
            </>}
          />

          <SetupStep
            num={5}
            title="Verify the Pi appears in this list"
            body={<>
              The agent registers itself with your Hub on startup and heartbeats every 30 s. Refresh this page or
              run on your Mac:
              <Cmd>{`curl -sS ${hubUrl}/api/flash/nodes`}</Cmd>
              Once it shows up, plug a USB SD reader into the Pi and switch to the <strong>Storage</strong> tab to see
              attached disks. Plug a fresh SD card into that reader and the <strong>Images</strong> tab's
              <code> flash → </code> button can target it.
            </>}
          />

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: COLORS.textMuted, padding: '6px 0' }}>
              Troubleshooting
            </summary>
            <ul style={{ margin: '4px 0 0 18px', fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.8 }}>
              <li><strong>"Permission denied (publickey)"</strong> on step 2 — the SSH key in the image is your Mac's
                  <code> ~/.ssh/id_ed25519.pub</code> at build time. If you've regenerated since, re-run the
                  vanilla build and reflash.</li>
              <li><strong>Step 4 fails with "Could not resolve host"</strong> — Pi has no internet. Check
                  <code> /boot/dietpi.txt</code> WiFi creds; or plug in Ethernet.</li>
              <li><strong>Agent installs OK but doesn't appear in the list</strong> — the agent can't reach the Hub. Confirm:
                  (a) sidebar HUB tile dot is green; (b) <code>HUB_URL</code> in <code>/etc/ark-flash-agent.env</code> points
                  at the Mac's LAN IP, not <code>localhost</code>; (c) <code>journalctl -u ark-flash-agent -f</code> shows
                  what's happening.</li>
              <li><strong>Agent is "offline" in the table</strong> — heartbeat hasn't landed in {'>'}60 s. Usually transient;
                  if persistent, <code>systemctl restart ark-flash-agent</code> on the Pi.</li>
              <li><strong>Storage tab shows no disks</strong> — plug a USB SD reader into the Pi (not the SD slot the Pi
                  is booting from). The Storage tab reads <code>lsblk</code> live from the agent — refresh after plugging in.</li>
            </ul>
          </details>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: COLORS.textMuted, padding: '6px 0' }}>
              What does the agent do behind the scenes?
            </summary>
            <ul style={{ margin: '4px 0 0 18px', fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.8 }}>
              <li>FastAPI HTTP service on port <code>7410</code>. Endpoints: <code>/healthz</code>, <code>/disks</code>,
                  <code> /jobs</code>, <code>/jobs/&lt;id&gt;/stream</code> (WebSocket), <code>/captures</code>.</li>
              <li>Heartbeats this Hub every 30 s so the registry shows live status.</li>
              <li>When a flash job arrives: verifies image sha256, refuses if target disk isn't safe (mounted / read-only / root disk),
                  writes via <code>bmaptool</code> when available else chunked <code>dd</code>, sample-verifies, ro mount-tests, reports completion.</li>
              <li>Hardened systemd unit: <code>NoNewPrivileges</code>, <code>ProtectSystem=strict</code>, <code>ProtectHome</code>,
                  <code> PrivateTmp</code>, <code>ReadOnlyPaths=/</code>.</li>
              <li>NEVER reads or transmits SSH keys, WiFi passwords, or any credential — explicit deny list.</li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}

function SetupStep({ num, title, body }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{
        flexShrink: 0, width: 28, height: 28, borderRadius: 14,
        background: COLORS.bgActive, color: COLORS.accentBright,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_HEADING, fontSize: 14, fontWeight: 600,
        border: `1px solid ${COLORS.accentBorder}`,
      }}>{num}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONT_BODY, fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.7 }}>{body}</div>
      </div>
    </div>
  );
}

function Cmd({ children }) {
  return (
    <pre style={{
      margin: '6px 0', padding: '10px 12px',
      background: '#040608', color: COLORS.textPrimary,
      border: `1px solid ${COLORS.border}`, borderRadius: 6,
      fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.55,
      overflow: 'auto',
    }}>{children}</pre>
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
const ACTIVE_STATES = new Set(['queued', 'preparing', 'writing', 'syncing', 'verifying', 'mount_test']);

function JobsTab({ hubUrl }) {
  const [state, setState] = useState({ status: 'loading', jobs: [], error: null });
  const [nodes, setNodes] = useState([]);
  const [filter, setFilter] = useState('all');   // all / active / completed / failed
  const [openJob, setOpenJob] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/flash/jobs`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setState({ status: 'ok', jobs: j.jobs || [], error: null });
    } catch (e) { setState(s => ({ ...s, status: 'error', error: e.message })); }
  }, [hubUrl]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    fetch(`${hubUrl}/api/flash/nodes`).then(r => r.json()).then(j => setNodes(j.nodes || [])).catch(() => {});
  }, [hubUrl]);

  async function cancelJob(jobId) {
    if (!confirm('Cancel this flash job? If the write is in progress the SD card may be partially-written and unbootable.')) return;
    await fetch(`${hubUrl}/api/flash/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    refresh();
  }

  if (state.status === 'error') return <Err msg={state.error} hubUrl={hubUrl}/>;
  if (state.jobs.length === 0) return <Empty title="No flash jobs yet" body="Once you queue one from the Images tab + a registered node it'll appear here with live progress."/>;

  const nodeUrlById = Object.fromEntries(nodes.map(n => [n.node_id, n.agent_url]));
  const filtered = state.jobs.filter(j => {
    if (filter === 'all')       return true;
    if (filter === 'active')    return ACTIVE_STATES.has(j.state);
    if (filter === 'completed') return j.state === 'completed';
    if (filter === 'failed')    return j.state === 'failed' || j.state === 'cancelled';
    return true;
  });
  const counts = state.jobs.reduce((acc, j) => {
    if (ACTIVE_STATES.has(j.state)) acc.active++;
    else if (j.state === 'completed') acc.completed++;
    else if (j.state === 'failed' || j.state === 'cancelled') acc.failed++;
    return acc;
  }, { active: 0, completed: 0, failed: 0 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <FilterChip label={`All · ${state.jobs.length}`} active={filter === 'all'} onClick={() => setFilter('all')}/>
        <FilterChip label={`Active · ${counts.active}`} active={filter === 'active'} colour={COLORS.accent} onClick={() => setFilter('active')}/>
        <FilterChip label={`Completed · ${counts.completed}`} active={filter === 'completed'} colour={COLORS.success} onClick={() => setFilter('completed')}/>
        <FilterChip label={`Failed · ${counts.failed}`} active={filter === 'failed'} colour={COLORS.error} onClick={() => setFilter('failed')}/>
      </div>
      <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <th style={th}>Job</th><th style={th}>Node</th><th style={th}>Image</th><th style={th}>Target</th>
              <th style={th}>State</th><th style={th}>Progress</th><th style={th}>Speed</th><th style={th}>ETA</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: COLORS.textMuted }}>
                No jobs matching this filter.
              </td></tr>
            )}
            {filtered.map(j => <JobRow key={j.job_id} j={j} agentUrl={nodeUrlById[j.node_id]} onOpen={() => setOpenJob(j.job_id)} onCancel={() => cancelJob(j.job_id)}/>)}
          </tbody>
        </table>
      </div>
      {openJob && <JobDetailModal hubUrl={hubUrl} jobId={openJob} onClose={() => setOpenJob(null)} onCancel={cancelJob}/>}
    </div>
  );
}

function FilterChip({ label, active, colour, onClick }) {
  const c = colour || COLORS.textPrimary;
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', fontSize: 12,
      background: active ? COLORS.bgActive : COLORS.bgPanel,
      color: active ? c : COLORS.textSecondary,
      border: `1px solid ${active ? COLORS.accentBorder : COLORS.border}`,
      borderRadius: 6, cursor: 'pointer', fontFamily: FONT_BODY,
    }}>{label}</button>
  );
}

// Single-job detail modal — full state, log_tail, error if failed,
// cancel button if active. Polls /api/flash/jobs/<id> every 2 s while
// the modal is open so the operator sees fresh state.
function JobDetailModal({ hubUrl, jobId, onClose, onCancel }) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await fetch(`${hubUrl}/api/flash/jobs/${encodeURIComponent(jobId)}`).catch(() => null);
      if (r?.ok) {
        const j = await r.json();
        if (!cancelled) setJob(j);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [jobId, hubUrl]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  if (!job) return null;
  const active = ACTIVE_STATES.has(job.state);
  const colour = stateColour(job.state);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`,
        borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '85vh',
        overflow: 'auto', color: COLORS.textPrimary, padding: '20px 22px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20 }}>{job.job_id}</h3>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
              {job.node_id} · {job.image_id} → {job.target_disk_path}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 16 }}>
          <DetailStat label="State"        value={<span style={{ color: colour, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{job.state}</span>}/>
          <DetailStat label="Progress"     value={`${job.progress_pct || 0}%`}/>
          <DetailStat label="Bytes written" value={prettyBytes(job.bytes_written || 0)}/>
          <DetailStat label="Speed"         value={job.write_speed_mbps ? `${job.write_speed_mbps} MB/s` : '—'}/>
          <DetailStat label="ETA"           value={job.eta_s ? `${job.eta_s}s` : '—'}/>
          <DetailStat label="Created"       value={(job.created_at || '').slice(11, 19)}/>
          {job.started_at   && <DetailStat label="Started"   value={(job.started_at   || '').slice(11, 19)}/>}
          {job.completed_at && <DetailStat label="Completed" value={(job.completed_at || '').slice(11, 19)}/>}
        </div>

        <div style={{ width: '100%', height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ width: `${job.progress_pct || 0}%`, height: '100%', background: colour, transition: 'width 300ms ease' }}/>
        </div>

        {job.error && (
          <div style={{ padding: 12, background: 'rgba(239,111,92,0.10)', border: `1px solid ${COLORS.error}`, borderRadius: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: COLORS.error, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Error</div>
            <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 12, color: COLORS.error, whiteSpace: 'pre-wrap' }}>{job.error}</pre>
          </div>
        )}

        {job.log_tail && (
          <details open={!active}>
            <summary style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer' }}>
              Log tail
            </summary>
            <pre style={{ margin: '6px 0 0', padding: 10, background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55, overflow: 'auto', maxHeight: 280, whiteSpace: 'pre-wrap' }}>
              {job.log_tail}
            </pre>
          </details>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          {active && (
            <button onClick={() => onCancel(jobId)} style={{
              padding: '8px 14px', background: 'transparent',
              border: `1px solid ${COLORS.error}`, color: COLORS.error,
              borderRadius: 8, fontSize: 13, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}><StopCircle size={12}/> Cancel job</button>
          )}
          <button onClick={onClose} style={{ padding: '8px 14px', background: COLORS.accent, border: 'none', color: '#0a0a0a', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailStat({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.025)', border: `1px solid ${COLORS.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2, color: COLORS.textPrimary, fontFamily: FONT_MONO }}>{value}</div>
    </div>
  );
}

// Per-row WebSocket subscription — when a job is in an active state,
// open a stream to the Agent and push progress updates without
// waiting for the next 4s poll. Falls back silently to polling if
// the WS can't connect (browser CORS, agent offline, mixed content).
function useJobStream(j, agentUrl) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!agentUrl) return;
    const active = ['queued', 'preparing', 'writing', 'syncing', 'verifying', 'mount_test'].includes(j.state);
    if (!active) return;
    const wsUrl = agentUrl.replace(/^http/, 'ws') + `/jobs/${encodeURIComponent(j.job_id)}/stream`;
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.heartbeat) return;
        setLive(prev => ({ ...(prev || {}), ...msg }));
      } catch {}
    };
    ws.onerror = () => { /* fall back to polling */ };
    return () => { try { ws.close(); } catch {} };
  }, [j.job_id, j.state, agentUrl]);
  return live;
}

function JobRow({ j, agentUrl, onOpen, onCancel }) {
  const live = useJobStream(j, agentUrl);
  const merged = { ...j, ...(live || {}) };
  const colour = stateColour(merged.state);
  const active = ACTIVE_STATES.has(merged.state);
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onOpen}>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>
        {merged.job_id}
        {live && <span title="WebSocket stream" style={{ marginLeft: 4, color: COLORS.success }}>●</span>}
      </td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{merged.node_id}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{merged.image_id}</td>
      <td style={{ ...td, fontFamily: FONT_MONO }}>{merged.target_disk_path}</td>
      <td style={td}><span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: colour + '22', color: colour, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{merged.state}</span></td>
      <td style={td}>
        <div style={{ width: 100, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${merged.progress_pct || 0}%`, height: '100%', background: colour, transition: 'width 200ms ease' }}/>
        </div>
        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO, marginLeft: 6 }}>{merged.progress_pct || 0}%</span>
      </td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{merged.write_speed_mbps ? `${merged.write_speed_mbps} MB/s` : '—'}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{merged.eta_s ? `${merged.eta_s}s` : '—'}</td>
      <td style={td} onClick={(e) => e.stopPropagation()}>
        {active && (
          <button onClick={() => onCancel(merged.job_id)} title="Cancel" style={{
            padding: '4px 8px', fontSize: 11, background: 'transparent',
            color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
          }}><StopCircle size={10}/></button>
        )}
      </td>
    </tr>
  );
}

function stateColour(s) {
  if (s === 'completed') return COLORS.success;
  if (s === 'failed' || s === 'cancelled') return COLORS.error;
  if (['queued', 'paused'].includes(s)) return COLORS.textMuted;
  return COLORS.accent;
}

// ── Images tab: upload + register + flash ────────────────────────
function ImagesTab({ hubUrl }) {
  const [images, setImages] = useState([]);
  const [nodes,  setNodes]  = useState([]);
  const [uploading, setUploading] = useState(null);  // { name, pct, error? }
  const [flashing, setFlashing] = useState(null);    // { image_id, node_id, target_disk_path }

  const refresh = useCallback(async () => {
    const [i, n] = await Promise.all([
      fetch(`${hubUrl}/api/flash/images`).then(r => r.json()).catch(() => ({})),
      fetch(`${hubUrl}/api/flash/nodes`).then(r => r.json()).catch(() => ({})),
    ]);
    setImages(i.images || []);
    setNodes(n.nodes || []);
  }, [hubUrl]);
  useEffect(() => { refresh(); }, [refresh]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading({ name: file.name, pct: 0 });
    // Stream the file via XHR so we get progress events. Hub accepts
    // raw bytes; sha256 is computed server-side.
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${hubUrl}/api/flash/images/upload?filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setUploading({ name: file.name, pct: Math.round((ev.loaded / ev.total) * 100) });
      };
      xhr.onload = () => {
        setUploading(null);
        e.target.value = '';
        refresh();
        resolve();
      };
      xhr.onerror = () => {
        setUploading({ name: file.name, pct: 0, error: 'upload failed' });
        resolve();
      };
      xhr.send(file);
    });
  }

  async function enqueueFlash(image, node, targetDisk) {
    const r = await fetch(`${hubUrl}/api/flash/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image_id:         image.image_id,
        node_id:          node.node_id,
        target_disk_path: targetDisk,
      }),
    });
    const j = await r.json();
    if (!j.ok) { alert(j.error || 'failed'); return; }
    setFlashing(null);
    refresh();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textPrimary }}>Upload an image</h3>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
          Drop a .img / .img.xz file. Stored content-addressable on the Hub (dedups by sha256). Once registered, any flash node can pull it via /api/flash/images/&lt;id&gt;/download.
        </p>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          background: COLORS.bgActive, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6,
          fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer',
        }}>
          <Plus size={14}/> Choose .img file
          <input type="file" onChange={onFile} accept=".img,.img.xz,.iso" style={{ display: 'none' }} disabled={!!uploading && !uploading.error}/>
        </label>
        {uploading && (
          <div style={{ marginTop: 10, fontSize: 12, color: uploading.error ? COLORS.error : COLORS.textSecondary }}>
            {uploading.error
              ? `✖ ${uploading.name}: ${uploading.error}`
              : <>
                  <div style={{ marginBottom: 4 }}>↑ {uploading.name} — {uploading.pct}%</div>
                  <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${uploading.pct}%`, height: '100%', background: COLORS.accent, transition: 'width 200ms' }}/>
                  </div>
                </>}
          </div>
        )}
      </section>

      <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textPrimary }}>
          Image registry · {images.length}
        </h3>
        {images.length === 0 ? (
          <div style={{ color: COLORS.textMuted, fontSize: 12 }}>No images yet. Upload one above.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={th}>ID</th><th style={th}>Source</th><th style={th}>Size</th><th style={th}>SHA256</th><th style={th}>Compression</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {images.map(i => (
                <tr key={i.image_id}>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{i.image_id}</td>
                  <td style={td}>{i.build_name || '—'}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>{prettyBytes(i.size_bytes)}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 10, color: COLORS.textMuted }}>{i.sha256.slice(0, 12)}…</td>
                  <td style={td}>{i.compression}</td>
                  <td style={td}>
                    <a
                      href={`${hubUrl}/api/flash/images/${encodeURIComponent(i.image_id)}/download`}
                      download={i.build_name || `${i.image_id}.img`}
                      title="Download to this device"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        padding: '4px 10px', fontSize: 11,
                        background: 'transparent', color: COLORS.accent,
                        border: `1px solid ${COLORS.border}`, borderRadius: 4,
                        textDecoration: 'none', cursor: 'pointer', marginRight: 6,
                      }}>
                      <Download size={10}/> download
                    </a>
                    <button onClick={() => setFlashing({ image: i, node_id: '', target_disk_path: '' })} disabled={nodes.length === 0} style={{
                      padding: '4px 12px', fontSize: 11,
                      background: nodes.length === 0 ? COLORS.bgPanel : COLORS.bgActive,
                      color: nodes.length === 0 ? COLORS.textMuted : COLORS.accentBright,
                      border: `1px solid ${COLORS.border}`, borderRadius: 4,
                      cursor: nodes.length === 0 ? 'not-allowed' : 'pointer',
                      marginRight: 6,
                    }}>flash →</button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete image ${i.image_id}? The .img file on disk is removed too. Refused if a job is in flight.`)) return;
                        const r = await fetch(`${hubUrl}/api/flash/images/${encodeURIComponent(i.image_id)}`, { method: 'DELETE' });
                        const j = await r.json();
                        if (!j.ok) alert(j.error || 'failed');
                        refresh();
                      }}
                      title="Delete image"
                      style={{
                        padding: '4px 8px', fontSize: 11, background: 'transparent',
                        color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
                      }}><Trash2 size={10}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {flashing && <FlashDialog hubUrl={hubUrl} image={flashing.image} nodes={nodes} onClose={() => setFlashing(null)} onSubmit={(node, disk) => enqueueFlash(flashing.image, node, disk)}/>}
    </div>
  );
}

function FlashDialog({ hubUrl, image, nodes, onClose, onSubmit }) {
  const [nodeId, setNodeId] = useState(nodes[0]?.node_id || '');
  const [disks, setDisks] = useState([]);
  const [diskPath, setDiskPath] = useState('');
  const node = nodes.find(n => n.node_id === nodeId);

  useEffect(() => {
    if (!node) { setDisks([]); return; }
    fetch(`${node.agent_url.replace(/\/+$/, '')}/disks`).then(r => r.json()).then(j => setDisks(j.disks || [])).catch(() => setDisks([]));
  }, [node?.agent_url]);

  const safe = disks.filter(d => d.safe_to_write);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 12,
        width: '100%', maxWidth: 560, padding: '20px 22px', color: COLORS.textPrimary,
      }}>
        <h3 style={{ margin: '0 0 12px', fontFamily: FONT_HEADING, fontSize: 20 }}>Flash {image.build_name || image.image_id}</h3>
        <div style={{ marginBottom: 12, padding: 10, background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>
          {prettyBytes(image.size_bytes)} · sha256 {image.sha256.slice(0, 16)}…
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Flash node</label>
          <select value={nodeId} onChange={e => setNodeId(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 10px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontSize: 13 }}>
            {nodes.map(n => <option key={n.node_id} value={n.node_id}>{n.node_name} ({n.status})</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Target disk</label>
          {safe.length === 0 ? (
            <div style={{ marginTop: 4, fontSize: 12, color: COLORS.warning }}>
              No safe-to-write disks attached to this node. Plug in a USB SD reader / SSD on the Pi.
            </div>
          ) : (
            <select value={diskPath} onChange={e => setDiskPath(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 10px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontSize: 13, fontFamily: FONT_MONO }}>
              <option value="">— pick a disk —</option>
              {safe.map(d => <option key={d.path} value={d.path}>{d.path} · {d.type} · {prettyBytes(d.size)} · {[d.vendor, d.model].filter(Boolean).join(' ') || 'unlabeled'}</option>)}
            </select>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={() => onSubmit(node, diskPath)}
            disabled={!node || !diskPath}
            style={{ padding: '8px 14px', background: (!node || !diskPath) ? COLORS.bgPanel : COLORS.error, border: 'none', color: (!node || !diskPath) ? COLORS.textMuted : '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: (!node || !diskPath) ? 'not-allowed' : 'pointer' }}
          >
            ERASE & FLASH
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab 5: Clone / Capture — Phase 6.7 ────────────────────────
function ClonePlaceholder() {
  return <CloneCaptureTab/>;
}

function CloneCaptureTab() {
  const hubUrl = readHubUrl();
  const [nodes, setNodes] = useState([]);
  const [nodeId, setNodeId] = useState('');
  const [disks, setDisks] = useState([]);
  const [src,   setSrc]   = useState('');
  const [label, setLabel] = useState('');
  const [compress, setCompress] = useState(true);
  const [busy,  setBusy]  = useState(false);
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${hubUrl}/api/flash/nodes`).then(r => r.json()).then(j => setNodes(j.nodes || [])).catch(() => {});
  }, [hubUrl]);

  const node = nodes.find(n => n.node_id === nodeId);

  useEffect(() => {
    if (!node) { setDisks([]); return; }
    fetch(`${node.agent_url.replace(/\/+$/, '')}/disks`)
      .then(r => r.json()).then(j => setDisks(j.disks || []))
      .catch(() => setDisks([]));
  }, [node?.agent_url]);

  // Poll the active capture job for progress
  useEffect(() => {
    if (!active || !node) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${node.agent_url.replace(/\/+$/, '')}/jobs/${active.job_id}`);
        if (r.ok) {
          const j = await r.json();
          setActive(j);
          if (['completed', 'failed'].includes(j.state)) clearInterval(t);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [active?.job_id, node?.agent_url]);

  async function startCapture() {
    if (!node || !src) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${node.agent_url.replace(/\/+$/, '')}/captures`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_disk_path: src, label: label || null, compress, upload_to_hub: true }),
      });
      const j = await r.json();
      if (r.ok) setActive(j);
      else setError(j.detail || JSON.stringify(j));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (nodes.length === 0) {
    return <Empty title="No flash nodes registered" body="Register a Flash Agent first (Nodes tab). Capture runs on the agent."/>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: COLORS.textMuted, lineHeight: 1.6 }}>
        Read an attached SD card / USB drive on the flash node and produce a golden image. Output is
        compressed (.img.gz) by default and auto-uploaded to the Hub's image registry. Refuses to
        capture from the node's own running root disk.
      </p>

      <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Flash node</label>
            <select value={nodeId} onChange={e => { setNodeId(e.target.value); setSrc(''); }} style={{ ...inp, marginTop: 4 }}>
              <option value="">— pick a node —</option>
              {nodes.map(n => <option key={n.node_id} value={n.node_id}>{n.node_name} ({n.status})</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Source disk</label>
            <select value={src} onChange={e => setSrc(e.target.value)} disabled={!node} style={{ ...inp, marginTop: 4, fontFamily: FONT_MONO }}>
              <option value="">— pick a disk —</option>
              {disks.filter(d => !d.is_root_disk).map(d => (
                <option key={d.path} value={d.path}>
                  {d.path} · {d.type} · {prettyBytes(d.size)} · {[d.vendor, d.model].filter(Boolean).join(' ') || 'unlabelled'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Image label (optional)</label>
            <input value={label} onChange={e => setLabel(e.target.value)} style={{ ...inp, marginTop: 4, fontFamily: FONT_MONO }} placeholder="e.g. sinseracore-golden"/>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, cursor: 'pointer' }}>
              <input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)}/>
              Compress (.img.gz) — usually 3-5× smaller
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={startCapture} disabled={!node || !src || busy} style={{
            padding: '8px 18px',
            background: (!node || !src || busy) ? COLORS.bgPanel : COLORS.bgActive,
            color: (!node || !src || busy) ? COLORS.textMuted : COLORS.accentBright,
            border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8, fontSize: 13, fontWeight: 600,
            cursor: (!node || !src || busy) ? 'not-allowed' : 'pointer',
          }}>
            {busy ? 'starting…' : 'Start capture'}
          </button>
        </div>
        {error && (
          <div style={{ marginTop: 10, padding: 10, background: 'rgba(239,111,92,0.08)', border: `1px solid ${COLORS.error}`, borderRadius: 6, color: COLORS.error, fontSize: 12 }}>
            ✖ {error}
          </div>
        )}
      </section>

      {active && (
        <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
          <h3 style={{ margin: '0 0 10px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textPrimary }}>Capture in progress</h3>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted, marginBottom: 8 }}>
            {active.job_id} · {active.source_disk_path} → {active.dest_path}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{
              padding: '2px 8px', fontSize: 11, borderRadius: 4,
              background: stateColour(active.state) + '22', color: stateColour(active.state),
              textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
            }}>{active.state}</span>
            <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
              read {prettyBytes(active.bytes_read || 0)} of {prettyBytes(active.source_size_bytes || 0)} ·
              wrote {prettyBytes(active.bytes_written || 0)}
            </span>
          </div>
          <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${active.progress_pct || 0}%`, height: '100%', background: stateColour(active.state), transition: 'width 300ms ease' }}/>
          </div>
          {active.upload_pct != null && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Upload to Hub</div>
              <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${active.upload_pct}%`, height: '100%', background: COLORS.accent, transition: 'width 300ms ease' }}/>
              </div>
            </div>
          )}
          {active.error && (
            <div style={{ marginTop: 10, padding: 10, background: 'rgba(239,111,92,0.08)', border: `1px solid ${COLORS.error}`, borderRadius: 6, color: COLORS.error, fontSize: 12 }}>
              ✖ {active.error}
            </div>
          )}
          {active.state === 'completed' && (
            <div style={{ marginTop: 10, fontSize: 12, color: COLORS.success }}>
              ✓ Capture complete. {active.sha256 && <>sha256 <code style={{ fontFamily: FONT_MONO }}>{active.sha256.slice(0, 16)}…</code></>} —
              image now registered. Flash it back from the Images tab.
            </div>
          )}
        </section>
      )}
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
