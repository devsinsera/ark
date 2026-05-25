// Builds view — every build the installer engine has produced.
// Reads from the Hub's /api/builds; each card shows what artifacts
// landed (profile.json / manifest / plan / log / built image) and
// when the build directory was last touched.

import React, { useEffect, useState, useCallback } from 'react';
import { HardDrive, Check, X, AlertCircle, Clock, Trash2, Usb } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';
import { LocalFlashDialog } from './FlashNodes.jsx';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

export default function Builds() {
  const hubUrl = readHubUrl();
  const [state, setState] = useState({ status: 'loading', builds: [], error: null });
  // Flash registry — keyed by build_name → image. Used to wire the
  // "Mac SD" button on built-image cards. Refreshed alongside builds.
  const [registry, setRegistry] = useState({});

  const refresh = useCallback(async () => {
    try {
      const [b, i] = await Promise.all([
        fetch(`${hubUrl}/api/builds`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
        fetch(`${hubUrl}/api/flash/images`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : { images: [] }).catch(() => ({ images: [] })),
      ]);
      setState({ status: 'ok', builds: b.builds || [], error: null });
      const map = {};
      for (const img of (i.images || [])) {
        if (img.build_name) map[img.build_name] = img;
      }
      setRegistry(map);
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e.message }));
    }
  }, [hubUrl]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 12000); return () => clearInterval(t); }, [refresh]);

  if (state.status === 'error') {
    return <ErrorBlock title="Can't list builds" body={state.error} hubUrl={hubUrl}/>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>Builds</h2>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Compiled by the installer engine. Each card reflects what landed in <code>builds/&lt;name&gt;/</code>.
        </p>
      </header>

      {state.builds.length === 0 ? (
        <div style={{ padding: 28, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10, color: COLORS.textMuted, fontSize: 13 }}>
          No builds yet. Run <code style={{ fontFamily: FONT_MONO }}>node installer/bin/ark-install.mjs run &lt;source&gt; --as &lt;name&gt;</code> from the Ark repo root, then refresh.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {state.builds.map(b => <BuildCard key={b.name} b={b} hubUrl={hubUrl} image={registry[b.name]} onDeleted={refresh}/>)}
        </div>
      )}
    </div>
  );
}

function BuildCard({ b, hubUrl, image, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [localFlash, setLocalFlash] = useState(false);
  const hasOk = (k) => b.has?.[k];
  const ms = b.manifest_summary;
  const ps = b.plan_summary;
  const pr = b.profile_summary;
  const description = ms?.description?.trim();

  async function handleDelete() {
    if (!confirm(`Delete build "${b.name}"?\n\nThis removes builds/${b.name}/ and everything in it — including any .img output. Cannot be undone.`)) return;
    setDeleting(true);
    try {
      const r = await fetch(`${hubUrl}/api/builds/${encodeURIComponent(b.name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) {
        alert(j.error || 'delete failed');
        setDeleting(false);
        return;
      }
      onDeleted?.();
    } catch (e) {
      alert(e.message);
      setDeleting(false);
    }
  }

  return (
    <div style={{
      padding: 14, background: COLORS.bgPanel,
      border: `1px solid ${COLORS.border}`, borderRadius: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
      opacity: deleting ? 0.4 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 17, color: COLORS.textPrimary }}>{b.name}</h3>
        {pr?.profile_id && (
          <span style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, background: COLORS.bgActive, color: COLORS.accentBright, textTransform: 'uppercase', letterSpacing: 0.5 }}>{pr.profile_id}</span>
        )}
      </div>

      {description ? (
        <p style={{ margin: 0, fontFamily: FONT_BODY, fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.5 }}>
          {description}
        </p>
      ) : (
        <p style={{ margin: 0, fontFamily: FONT_BODY, fontSize: 12, color: COLORS.textMuted, fontStyle: 'italic' }}>
          No description. Add one in <strong>Device editor → Identity → Description</strong>, then rebuild.
        </p>
      )}

      {ms && (
        <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: COLORS.textSecondary }}>
          {ms.name ? `${ms.name} ${ms.version ? '· v' + ms.version : ''}` : '—'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>
        {ms && <span>{ms.entry_points} entry · {ms.apt} apt · {ms.pip} pip</span>}
        {ps && <span>arch {ps.target_arch} · {ps.step_count} steps</span>}
        {b.out_img_size_bytes != null && <span>img {(b.out_img_size_bytes / 1024 / 1024).toFixed(0)} MB</span>}
      </div>

      <ArtefactRow has={b.has}/>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
        <Clock size={11}/> {b.last_touched ? humanAge(new Date(b.last_touched).getTime()) : 'never built'}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {hasOk('manifest') && <SmallLink href={`#`} onClick={(e) => { e.preventDefault(); window.open(`${hubUrl}/api/builds/${encodeURIComponent(b.name)}`, '_blank'); }}>manifest</SmallLink>}
        {hasOk('install_log') && <SmallLink href={`#`} onClick={(e) => { e.preventDefault(); window.location.hash = `#logs/build/${encodeURIComponent(b.name)}`; }}>log</SmallLink>}
        {hasOk('built_img') && (
          <button
            onClick={async (e) => {
              // Fetch → Blob → saveAs. Avoids the silent mixed-content
              // drop browsers apply to <a download> linking from
              // https://sinsera.co/ to http://localhost:7400/.
              e.preventDefault();
              const target = `${hubUrl}/api/builds/${encodeURIComponent(b.name)}/download`;
              try {
                const r = await fetch(target);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const blob = await r.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = `${b.name}.img.xz`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
              } catch (err) {
                alert(`Download failed: ${err.message}. If Hub is reachable, try opening this directly:\n${target}`);
              }
            }}
            title="Download the built .img.xz to your Mac (streamed via fetch → blob to dodge mixed-content silent drop)"
            style={{
              padding: '4px 10px', fontSize: 11, borderRadius: 4,
              background: COLORS.bgActive, color: COLORS.accentBright,
              border: `1px solid ${COLORS.accentBorder}`, cursor: 'pointer',
              fontFamily: FONT_MONO, display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            ↓ download
          </button>
        )}
        {hasOk('built_img') && image && (
          <button
            onClick={() => setLocalFlash(true)}
            title="Flash this image to an SD card plugged into this Mac (macOS only)"
            style={{
              padding: '4px 10px', fontSize: 11, borderRadius: 4,
              background: 'transparent', color: COLORS.accent,
              border: `1px solid ${COLORS.border}`, cursor: 'pointer',
              fontFamily: FONT_BODY, display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <Usb size={11}/> Mac SD
          </button>
        )}
        {localFlash && image && <LocalFlashDialog hubUrl={hubUrl} image={image} onClose={() => setLocalFlash(false)}/>}
        <span style={{ flex: 1 }}/>
        <button onClick={handleDelete} disabled={deleting} title="Delete this build directory + all artifacts" style={{
          padding: '4px 10px', fontSize: 11, borderRadius: 4,
          background: 'transparent', color: COLORS.error,
          border: `1px solid ${COLORS.border}`, cursor: deleting ? 'wait' : 'pointer',
          fontFamily: FONT_BODY, display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <Trash2 size={11}/> delete
        </button>
      </div>
    </div>
  );
}

function ArtefactRow({ has = {} }) {
  const items = [
    ['profile',     has.profile],
    ['manifest',    has.manifest],
    ['plan.json',   has.plan_json],
    ['plan.sh',     has.plan_sh],
    ['install.log', has.install_log],
    ['ark-built.img', has.built_img],
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([label, ok]) => (
        <span key={label} style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          padding: '2px 8px', fontSize: 11, borderRadius: 4,
          background: ok ? 'rgba(34,197,94,0.10)' : 'rgba(124,132,153,0.10)',
          color: ok ? COLORS.success : COLORS.textMuted,
          border: `1px solid ${ok ? 'rgba(34,197,94,0.3)' : COLORS.border}`,
          fontFamily: FONT_MONO,
        }}>
          {ok ? <Check size={10}/> : <X size={10}/>} {label}
        </span>
      ))}
    </div>
  );
}

function SmallLink({ children, href, onClick }) {
  return (
    <a href={href} onClick={onClick} style={{
      padding: '4px 10px', fontSize: 11, borderRadius: 4,
      background: 'transparent', color: COLORS.accent,
      border: `1px solid ${COLORS.border}`, textDecoration: 'none',
      cursor: 'pointer', fontFamily: FONT_MONO,
    }}>{children}</a>
  );
}

function ErrorBlock({ title, body, hubUrl }) {
  return (
    <div style={{
      padding: 20, background: 'rgba(245,180,90,0.08)',
      border: `1px solid ${COLORS.warning}`, borderRadius: 10,
      display: 'flex', gap: 14, alignItems: 'flex-start',
    }}>
      <AlertCircle size={20} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
      <div>
        <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.warning }}>{title}</h3>
        <p style={{ margin: 0, color: COLORS.textSecondary, fontSize: 13, lineHeight: 1.6 }}>
          Hub at <code>{hubUrl}</code> didn't respond. <code>{body}</code>
        </p>
      </div>
    </div>
  );
}

function humanAge(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60)    return `${Math.round(diff)}s ago`;
  if (diff < 3600)  return `${Math.round(diff/60)}m ago`;
  if (diff < 86400) return `${Math.round(diff/3600)}h ago`;
  return `${Math.round(diff/86400)}d ago`;
}
