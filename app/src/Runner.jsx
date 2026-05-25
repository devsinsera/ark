// SSH Runner UI — operator-managed hosts.
//
// Adds, tests, removes managed hosts; runs ad-hoc commands and
// shows tailed output + recent log. The Hub shells out to the
// system ssh binary using the operator's existing keys; the UI
// never sees credentials.

import React, { useEffect, useState, useCallback } from 'react';
import { Terminal, Plus, Trash2, Play, AlertTriangle, Check, X as XIcon, Upload } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

export default function Runner() {
  const hubUrl = readHubUrl();
  const [hosts, setHosts]   = useState([]);
  const [error, setError]   = useState(null);
  const [selected, setSel]  = useState(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setHosts(j.hosts || []);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [hubUrl]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 12000); return () => clearInterval(t); }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Terminal size={20} style={{ color: COLORS.accent }}/>
          <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
            SSH Runner
          </h2>
        </div>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Operator-managed hosts. The Hub shells out to <code>ssh</code> using your existing keys + <code>~/.ssh/config</code>.
          Ark never sees or stores credentials.
        </p>
      </header>

      {error && (
        <div style={{ padding: 12, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 8, color: COLORS.warning, fontSize: 12 }}>
          Hub unreachable: {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={() => setAdding(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
          background: COLORS.bgActive, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8,
          fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer',
        }}>
          <Plus size={14}/> Add host
        </button>
        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>{hosts.length} managed</span>
      </div>

      {hosts.length === 0 ? (
        <div style={{ padding: 24, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10, color: COLORS.textMuted, fontSize: 13 }}>
          No hosts yet. Add one above using SSH form <code>user@host[:port]</code> — your existing SSH keys do the auth.
        </div>
      ) : (
        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={th}>Label</th><th style={th}>Target</th><th style={th}>Port</th>
                <th style={th}>Last reached</th><th style={th}>Status</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {hosts.map(h => <HostRow key={h.id} h={h} hubUrl={hubUrl} onRefresh={refresh} onOpen={() => setSel(h.id)}/>)}
            </tbody>
          </table>
        </div>
      )}

      {selected && <ExecPanel hubUrl={hubUrl} host={hosts.find(h => h.id === selected)} onClose={() => setSel(null)}/>}
      {adding   && <AddHostModal hubUrl={hubUrl} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }}/>}
    </div>
  );
}

function HostRow({ h, hubUrl, onRefresh, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  async function test() {
    setBusy(true);
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts/${h.id}/test`, { method: 'POST' });
      const j = await r.json();
      setLast(j);
      onRefresh();
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Remove ${h.label}? Runner log for this host is also deleted.`)) return;
    await fetch(`${hubUrl}/api/runner/hosts/${h.id}`, { method: 'DELETE' });
    onRefresh();
  }
  const statusColour = h.last_status === 'ok' ? COLORS.success : h.last_status ? COLORS.error : COLORS.textMuted;
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onOpen}>
      <td style={td}>{h.label}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 12 }}>{h.ssh_target}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 12, color: COLORS.textMuted }}>{h.ssh_port}</td>
      <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{h.last_reached_at ? h.last_reached_at.slice(11, 19) : 'never'}</td>
      <td style={td}>
        <span style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, background: statusColour + '22', color: statusColour, fontFamily: FONT_MONO }}>
          {h.last_status || 'unknown'}
        </span>
      </td>
      <td style={td} onClick={(e) => e.stopPropagation()}>
        <button onClick={test} disabled={busy} style={{ padding: '4px 10px', fontSize: 11, background: 'transparent', color: COLORS.accent, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: busy ? 'wait' : 'pointer', marginRight: 6 }}>
          {busy ? '…' : 'test'}
        </button>
        <button onClick={remove} style={{ padding: '4px 10px', fontSize: 11, background: 'transparent', color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer' }}>
          <Trash2 size={10}/>
        </button>
      </td>
    </tr>
  );
}

function AddHostModal({ hubUrl, onClose, onSaved }) {
  const [form, setForm] = useState({ label: '', ssh_target: '', ssh_port: 22, identity_file: '', notes: '' });
  const [err, setErr]   = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  async function submit() {
    setErr(null);
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) { setErr(e.message); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`,
        borderRadius: 12, width: '100%', maxWidth: 520,
        color: COLORS.textPrimary, padding: '20px 22px',
      }}>
        <h3 style={{ margin: '0 0 14px', fontFamily: FONT_HEADING, fontSize: 20 }}>Add managed host</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Label" hint="short human name (e.g. 'SinseraCore', 'home-router')">
            <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} style={inp} placeholder="SinseraCore"/>
          </Field>
          <Field label="SSH target" hint="user@host[:port] — uses your existing SSH keys for auth">
            <input value={form.ssh_target} onChange={e => setForm(f => ({ ...f, ssh_target: e.target.value }))} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="pi@SinseraCore.local"/>
          </Field>
          <Field label="Port (optional)" hint="leave 22 for the default">
            <input type="number" value={form.ssh_port} onChange={e => setForm(f => ({ ...f, ssh_port: Number(e.target.value) || 22 }))} style={{ ...inp, fontFamily: FONT_MONO, width: 100 }}/>
          </Field>
          <Field label="Identity file (optional)" hint="absolute path to a private key on the Hub host — leave blank to use ssh-agent / default keys">
            <input value={form.identity_file} onChange={e => setForm(f => ({ ...f, identity_file: e.target.value }))} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="/Users/you/.ssh/id_ed25519"/>
          </Field>
          <Field label="Notes (optional)">
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={inp} placeholder="Pi 5, kiosk role"/>
          </Field>
          {err && <div style={{ color: COLORS.error, fontSize: 12 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={onClose} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={submit} style={{ padding: '8px 14px', background: COLORS.accent, border: 'none', color: '#0a0a0a', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExecPanel({ hubUrl, host, onClose }) {
  const [command, setCommand] = useState('uname -a && uptime');
  const [running, setRunning] = useState(false);
  const [result,  setResult]  = useState(null);
  const [log,     setLog]     = useState([]);

  const refreshLog = useCallback(async () => {
    const r = await fetch(`${hubUrl}/api/runner/hosts/${host.id}/log`).then(r => r.json());
    setLog(r.log || []);
  }, [hubUrl, host?.id]);
  useEffect(() => { refreshLog(); }, [refreshLog]);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch(`${hubUrl}/api/runner/hosts/${host.id}/exec`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      setResult(await r.json());
      refreshLog();
    } catch (e) {
      setResult({ ok: false, exit_code: -1, stdout: '', stderr: e.message });
    } finally { setRunning(false); }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  if (!host) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`,
        borderRadius: 12, width: '100%', maxWidth: 820, maxHeight: '90vh', overflow: 'auto',
        color: COLORS.textPrimary, padding: '20px 22px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20 }}>{host.label}</h3>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{host.ssh_target}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Command</label>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              value={command} onChange={e => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }}
              style={{ flex: 1, padding: '8px 12px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_MONO, fontSize: 12, outline: 'none' }}
              placeholder="uname -a"
              spellCheck={false}
            />
            <button onClick={run} disabled={running || !command.trim()} style={{
              padding: '8px 16px', background: running ? COLORS.bgPanel : COLORS.bgActive,
              color: COLORS.accentBright, border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: 6, fontSize: 13, cursor: running ? 'wait' : 'pointer', fontWeight: 600,
            }}>
              <Play size={12} style={{ verticalAlign: 'middle', marginRight: 4 }}/>
              {running ? 'running…' : 'run (⌘↩)'}
            </button>
          </div>
        </div>

        {result && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO, marginBottom: 6 }}>
              <span style={{
                padding: '2px 8px', borderRadius: 4,
                background: result.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,111,92,0.15)',
                color: result.ok ? COLORS.success : COLORS.error,
                textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700,
              }}>exit {result.exit_code}</span>
              {result.duration_ms != null && <span>{result.duration_ms} ms</span>}
            </div>
            {result.stdout && <Output title="stdout" body={result.stdout} colour={COLORS.textPrimary}/>}
            {result.stderr && <Output title="stderr" body={result.stderr} colour={COLORS.warning}/>}
          </div>
        )}

        <SendFile hubUrl={hubUrl} hostId={host.id}/>

        <details>
          <summary style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer' }}>
            Recent commands · {log.length}
          </summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 8 }}>
            <thead>
              <tr style={{ color: COLORS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={th}>When</th><th style={th}>Reason</th><th style={th}>Exit</th><th style={th}>Command</th>
              </tr>
            </thead>
            <tbody>
              {log.map(l => (
                <tr key={l.id}>
                  <td style={{ ...td, fontFamily: FONT_MONO }}>{l.ran_at.slice(11, 19)}</td>
                  <td style={td}>{l.reason}</td>
                  <td style={{ ...td, color: l.exit_code === 0 ? COLORS.success : COLORS.error, fontFamily: FONT_MONO }}>{l.exit_code}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO, maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}

// Send-file-to-Pi — POSTs raw bytes to /api/runner/hosts/<id>/push.
// Hub stages locally then scp's to <remote_path>. Filename is
// constrained to [A-Za-z0-9._-] by the Hub to avoid scp argument
// shenanigans; we mirror that constraint client-side for the hint.
// Default remote dir is /tmp/ so an operator can drop a script and
// immediately exec it via the command box above.
function SendFile({ hubUrl, hostId }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [remoteDir, setRemoteDir] = useState('/tmp/');
  const [busy, setBusy] = useState(false);
  const [pct,  setPct]  = useState(0);
  const [result, setResult] = useState(null);

  const SAFE_FILENAME = /^[A-Za-z0-9._\-]+$/;
  const safeName = file ? (file.name.match(SAFE_FILENAME) ? file.name : null) : null;

  async function send() {
    if (!file || !safeName) return;
    setBusy(true); setPct(0); setResult(null);
    const url = `${hubUrl}/api/runner/hosts/${hostId}/push`
      + `?path=${encodeURIComponent(remoteDir)}`
      + `&filename=${encodeURIComponent(safeName)}`;
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setPct(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () => {
        try { setResult(JSON.parse(xhr.responseText)); }
        catch { setResult({ ok: false, error: `HTTP ${xhr.status}` }); }
        setBusy(false); resolve();
      };
      xhr.onerror = () => { setResult({ ok: false, error: 'network error' }); setBusy(false); resolve(); };
      xhr.send(file);
    });
  }

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ marginBottom: 14, padding: 10, border: `1px solid ${COLORS.border}`, borderRadius: 8, background: 'rgba(255,255,255,0.015)' }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: COLORS.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Upload size={12}/> Send a file to this host (scp)
      </summary>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <label style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>File</label>
          <input
            type="file"
            onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setPct(0); }}
            style={{ display: 'block', marginTop: 4, fontSize: 12, color: COLORS.textSecondary }}
          />
          {file && !safeName && (
            <div style={{ marginTop: 4, fontSize: 11, color: COLORS.error }}>
              Filename <code style={{ fontFamily: FONT_MONO }}>{file.name}</code> has characters outside [A-Za-z0-9._-]. Rename locally and retry.
            </div>
          )}
        </div>
        <div>
          <label style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Remote path</label>
          <input
            value={remoteDir}
            onChange={(e) => setRemoteDir(e.target.value)}
            placeholder="/tmp/ (trailing / → uses filename; otherwise exact path)"
            style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 10px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_MONO, fontSize: 12, boxSizing: 'border-box' }}
          />
          <div style={{ marginTop: 3, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_BODY }}>
            Ends with <code>/</code> → file lands at <code style={{ fontFamily: FONT_MONO }}>{remoteDir}{safeName || '<filename>'}</code>. Otherwise the path is used verbatim.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={send} disabled={!file || !safeName || busy || !remoteDir.trim()} style={{
            padding: '6px 14px',
            background: (!file || !safeName || busy || !remoteDir.trim()) ? COLORS.bgPanel : COLORS.bgActive,
            color: (!file || !safeName || busy || !remoteDir.trim()) ? COLORS.textMuted : COLORS.accentBright,
            border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6, fontSize: 12,
            cursor: (!file || !safeName || busy || !remoteDir.trim()) ? 'not-allowed' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <Upload size={12}/> {busy ? `sending ${pct}%…` : 'send file'}
          </button>
          {busy && (
            <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: COLORS.accent, transition: 'width 200ms' }}/>
            </div>
          )}
        </div>
        {result && (
          <div style={{ marginTop: 4, padding: 10, borderRadius: 6, fontSize: 12, lineHeight: 1.5, background: result.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,111,92,0.08)', border: `1px solid ${result.ok ? COLORS.success : COLORS.error}`, color: result.ok ? COLORS.success : COLORS.error }}>
            {result.ok
              ? <>✓ scp'd {result.size_bytes != null ? `${(result.size_bytes/1024).toFixed(1)} KB ` : ''}to <code style={{ fontFamily: FONT_MONO }}>{result.remote_path}</code> in {result.duration_ms} ms</>
              : <>✖ {result.error || result.stderr || `exit ${result.exit_code}`}</>}
          </div>
        )}
      </div>
    </details>
  );
}

function Output({ title, body, colour }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{title}</div>
      <pre style={{ margin: 0, padding: 10, background: '#040608', color: colour, border: `1px solid ${COLORS.border}`, borderRadius: 4, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.55, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap' }}>
        {body}
      </pre>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div style={{ marginTop: 3, fontSize: 11, color: COLORS.textMuted }}>{hint}</div>}
    </div>
  );
}

const th  = { textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${COLORS.border}` };
const td  = { padding: '8px 12px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary };
const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_BODY, fontSize: 13 };
