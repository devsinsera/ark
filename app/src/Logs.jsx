// Logs view — tail of the Hub's own log + per-build install.log
// files. Polls the Hub's /api/logs/* endpoints.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ScrollText, RefreshCw, AlertCircle } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

export default function Logs() {
  const hubUrl = readHubUrl();
  const [tab, setTab] = useState('hub');     // 'hub' or 'build:<name>'
  const [builds, setBuilds] = useState([]);

  // Load build list so we can offer them as tabs
  useEffect(() => {
    fetch(`${hubUrl}/api/builds`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { builds: [] })
      .then(j => setBuilds((j.builds || []).filter(b => b.has?.install_log)))
      .catch(() => setBuilds([]));
  }, [hubUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>Logs</h2>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Hub stdout/stderr from <code>~/Library/Logs/ark-hub.log</code>, plus the per-build <code>install.log</code> files.
        </p>
      </header>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: COLORS.bgPanel, borderRadius: 10, border: `1px solid ${COLORS.border}`, width: 'fit-content', flexWrap: 'wrap' }}>
        <Tab active={tab === 'hub'} onClick={() => setTab('hub')}>Hub</Tab>
        {builds.map(b => (
          <Tab key={b.name} active={tab === `build:${b.name}`} onClick={() => setTab(`build:${b.name}`)}>
            {b.name}
          </Tab>
        ))}
      </div>

      {tab === 'hub'
        ? <LogTail url={`${hubUrl}/api/logs/hub`} label="ark-hub.log"/>
        : <LogTail url={`${hubUrl}/api/logs/build/${encodeURIComponent(tab.slice('build:'.length))}`} label={`${tab.slice('build:'.length)}/install.log`}/>}
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px',
      background: active ? COLORS.bgActive : 'transparent',
      color:      active ? COLORS.accentBright : COLORS.textSecondary,
      border:     `1px solid ${active ? COLORS.accentBorder : 'transparent'}`,
      borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: FONT_BODY, fontWeight: 500,
    }}>{children}</button>
  );
}

function LogTail({ url, label }) {
  const [state, setState] = useState({ status: 'loading', body: '', meta: null, error: null });
  const [busy, setBusy] = useState(false);
  const preRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setState({ status: 'ok', body: j.body || '', meta: j, error: null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    } finally { setBusy(false); }
  }, [url]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  // Auto-scroll to bottom on new content (only when we're already at
  // the bottom — don't yank the user's scroll position).
  useEffect(() => {
    if (!preRef.current || !stickToBottom) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [state.body, stickToBottom]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  };

  if (state.status === 'error') {
    return (
      <div style={{ padding: 16, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <AlertCircle size={18} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
        <div>
          <strong style={{ color: COLORS.warning }}>Couldn't read {label}.</strong>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: COLORS.textSecondary }}>{state.error}</p>
        </div>
      </div>
    );
  }

  const meta = state.meta;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={refresh} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          background: busy ? COLORS.bgPanel : COLORS.bgActive, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 6,
          fontFamily: FONT_BODY, fontSize: 12, cursor: busy ? 'wait' : 'pointer',
        }}>
          <RefreshCw size={12} className={busy ? 'spin' : ''}/> {busy ? '…' : 'Refresh'}
        </button>
        {meta && (
          <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
            {meta.exists ? (
              <>{label} · {prettyBytes(meta.size || 0)} total · {meta.truncated ? `last ${prettyBytes(meta.bytes)} shown` : 'full file'}{meta.modified_at ? ` · mod ${meta.modified_at.slice(11, 19)}` : ''}</>
            ) : (
              <>{label} · file not present</>
            )}
          </span>
        )}
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: stickToBottom ? COLORS.accent : COLORS.textMuted, fontFamily: FONT_MONO }}>
          {stickToBottom ? '⤓ auto-tail on' : '↕ paused (scroll to bottom to resume)'}
        </span>
      </div>

      <pre ref={preRef} onScroll={onScroll} style={{
        margin: 0, padding: 14, height: '60vh', overflow: 'auto',
        background: '#040608', color: COLORS.textPrimary,
        border: `1px solid ${COLORS.border}`, borderRadius: 8,
        fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.55,
        whiteSpace: 'pre',
      }}>
        {state.body || (meta?.exists === false ? '(no file at this path yet)' : '(empty)')}
      </pre>
    </div>
  );
}

function prettyBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}
