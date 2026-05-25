// Images view — base images the operator has downloaded into Os/
// AND images Ark has built via the Phase 3 pipeline (builds/*/out/).
// Read from the Hub's /api/images.

import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, AlertCircle, Download } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://localhost:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

export default function Images() {
  const hubUrl = readHubUrl();
  const [state, setState] = useState({ status: 'loading', bases: [], built: [], error: null });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${hubUrl}/api/images`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        setState({ status: 'ok', bases: j.bases || [], built: j.built || [], error: null });
      } catch (e) {
        if (!cancelled) setState(s => ({ ...s, status: 'error', error: e.message }));
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [hubUrl]);

  if (state.status === 'error') {
    return (
      <div style={{
        padding: 20, background: 'rgba(245,180,90,0.08)',
        border: `1px solid ${COLORS.warning}`, borderRadius: 10,
        display: 'flex', gap: 14, alignItems: 'flex-start',
      }}>
        <AlertCircle size={20} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }}/>
        <div>
          <h3 style={{ margin: '0 0 6px', fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.warning }}>Can't list images</h3>
          <p style={{ margin: 0, color: COLORS.textSecondary, fontSize: 13 }}>Hub at <code>{hubUrl}</code> didn't respond. <code>{state.error}</code></p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header>
        <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>Images</h2>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Base <code>.img</code> files in <code>Os/</code> + images the Phase 3 builder produced under <code>builds/&lt;name&gt;/out/</code>.
        </p>
        <p style={{ margin: '6px 0 0', color: COLORS.textMuted, fontSize: 12, lineHeight: 1.55 }}>
          This is a file-level view from <code>/api/images</code>. To flash one of these to a Pi or a Mac-attached SD, switch to{' '}
          <a href="#flash/images" style={{ color: COLORS.accent, textDecoration: 'none' }}>Flash Nodes → Images</a>{' '}
          — that's the registry view backed by <code>/api/flash/images</code>, with <code>flash →</code> and <code>Mac SD</code> buttons per row.
        </p>
      </header>

      <Section title={`Base images · ${state.bases.length}`}
               subtitle="What the chroot pipeline copies from. Operator-supplied — Ark doesn't fetch images implicitly.">
        {state.bases.length === 0 ? (
          <EmptyHint>
            No base images in <code>Os/</code>. Drop your DietPi / Pi OS / Ubuntu Server <code>.img</code> there.
          </EmptyHint>
        ) : (
          <ImageTable rows={state.bases.map(b => ({ ...b, source: 'Os/' }))}/>
        )}
      </Section>

      <Section title={`Built images · ${state.built.length}`}
               subtitle="Produced by ark-builder. .sha256 sits next to .img for integrity.">
        {state.built.length === 0 ? (
          <EmptyHint>
            No built images yet. Once <code>ark-builder build</code> finishes, <code>ark-built.img</code> lands here.
          </EmptyHint>
        ) : (
          <ImageTable rows={state.built.map(b => ({ ...b, source: `builds/${b.build}/out/` }))}/>
        )}
      </Section>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.textPrimary }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_BODY }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}
function EmptyHint({ children }) {
  return (
    <div style={{ padding: 16, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10, color: COLORS.textMuted, fontSize: 12 }}>
      {children}
    </div>
  );
}

function ImageTable({ rows }) {
  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={th}>File</th>
            <th style={th}>Source</th>
            <th style={th}>Kind</th>
            <th style={th}>Size</th>
            <th style={th}>Modified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.path}>
              <td style={td}><span style={{ fontFamily: FONT_MONO }}>{r.name}</span></td>
              <td style={td}><span style={{ fontFamily: FONT_MONO, color: COLORS.textMuted, fontSize: 11 }}>{r.source}</span></td>
              <td style={td}>
                <span style={{
                  padding: '2px 8px', fontSize: 10, borderRadius: 4,
                  background: kindColour(r.kind) + '22',
                  color: kindColour(r.kind),
                  textTransform: 'uppercase', letterSpacing: 0.5,
                }}>{r.kind}</span>
              </td>
              <td style={td}><span style={{ fontFamily: FONT_MONO, color: COLORS.textSecondary }}>{prettyBytes(r.size_bytes)}</span></td>
              <td style={td}><span style={{ fontFamily: FONT_MONO, color: COLORS.textMuted, fontSize: 11 }}>{r.last_modified?.slice(0, 16).replace('T', ' ')}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th = { textAlign: 'left', padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` };
const td = { padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary, whiteSpace: 'nowrap' };

function kindColour(k) {
  return k === 'raw' ? COLORS.accentBright
       : k === 'compressed' ? COLORS.warning
       : k === 'checksum' ? COLORS.textMuted
       : COLORS.textSecondary;
}
function prettyBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}
