// Installer UI — drives the installer engine from the browser.
//
// Lets the operator pick a source (git URL / ZIP upload / local
// folder path / git URL with @ref pin), an optional build profile,
// and a build name. POSTs to /api/installer/run which orchestrates
// ingest → detect → compile and returns the produced manifest +
// plan summary.
//
// Closes the last 🚧 in Phase 8: until this surface, the CLI
// (`node installer/bin/ark-install.mjs …`) was the only way to
// compile a build.

import React, { useEffect, useState, useCallback } from 'react';
import { Boxes, GitBranch, FileArchive, FolderInput, Plus, Check, AlertTriangle, Play } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://192.168.4.167:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

const SOURCE_KINDS = [
  { id: 'git',    label: 'Git URL',         Icon: GitBranch,   hint: 'https://github.com/<owner>/<repo>(@<ref>)' },
  { id: 'zip',    label: 'ZIP upload',      Icon: FileArchive, hint: 'pick a .zip from your laptop' },
  { id: 'folder', label: 'Local folder',    Icon: FolderInput, hint: 'absolute path on the Hub host (e.g. /Users/you/code/widget)' },
];

export default function Installer() {
  const hubUrl = readHubUrl();
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState({
    build_name: '',
    source_kind: 'git',
    git_url:    '',
    git_ref:    '',
    zip_file:   null,
    folder_path:'',
    profile_id: '',
    use_venv:   false,
  });
  const [busy,   setBusy]   = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [result, setResult] = useState(null);
  const [error,  setError]  = useState(null);

  useEffect(() => {
    fetch(`${hubUrl}/api/installer/profiles`).then(r => r.json()).then(j => setProfiles(j.profiles || [])).catch(() => {});
  }, [hubUrl]);

  function updateForm(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      let source;
      if (form.source_kind === 'git') {
        if (!form.git_url) throw new Error('Git URL required');
        source = { kind: 'git', value: form.git_url, ref: form.git_ref || null };
      } else if (form.source_kind === 'zip') {
        if (!form.zip_file) throw new Error('Pick a .zip file first');
        // Stage upload, then call /run with the resulting server-side path
        const stagedPath = await uploadZip(form.zip_file, form.build_name || 'upload');
        source = { kind: 'zip-path', value: stagedPath };
      } else if (form.source_kind === 'folder') {
        if (!form.folder_path) throw new Error('Folder path required');
        source = { kind: 'folder', value: form.folder_path };
      } else {
        throw new Error(`unknown source kind: ${form.source_kind}`);
      }

      const r = await fetch(`${hubUrl}/api/installer/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          build_name: form.build_name,
          source,
          profile_id: form.profile_id || null,
          use_venv:   form.use_venv,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResult(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setUploadPct(0);
    }
  }

  function uploadZip(file, buildName) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${hubUrl}/api/installer/upload-zip?build_name=${encodeURIComponent(buildName)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setUploadPct(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () => {
        try {
          const j = JSON.parse(xhr.responseText);
          if (!j.ok) return reject(new Error(j.error || 'upload failed'));
          resolve(j.path);
        } catch (e) { reject(e); }
      };
      xhr.onerror = () => reject(new Error('upload network error'));
      xhr.send(file);
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Boxes size={20} style={{ color: COLORS.accent }}/>
          <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
            Installer
          </h2>
        </div>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Compile a build package into an install plan. Drives the same engine the
          <code> ark-install</code> CLI uses — ingest → detect → compile —
          but in the browser, with all four input kinds.
        </p>
      </header>

      <section style={{ padding: 16, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Build name" hint="becomes the folder name under builds/. Lowercased + sluggified server-side.">
          <input value={form.build_name} onChange={e => updateForm('build_name', e.target.value)} style={inp} placeholder="my-thing"/>
        </Field>

        <Field label="Source" hint="where the engine reads the package from">
          <div style={{ display: 'flex', gap: 4, padding: 4, background: '#040608', borderRadius: 6, width: 'fit-content' }}>
            {SOURCE_KINDS.map(k => {
              const Icon = k.Icon;
              const active = form.source_kind === k.id;
              return (
                <button key={k.id} onClick={() => updateForm('source_kind', k.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px',
                  background: active ? COLORS.bgActive : 'transparent',
                  color: active ? COLORS.accentBright : COLORS.textSecondary,
                  border: `1px solid ${active ? COLORS.accentBorder : 'transparent'}`,
                  borderRadius: 4, fontSize: 12, fontFamily: FONT_BODY, cursor: 'pointer',
                }}>
                  <Icon size={12}/> {k.label}
                </button>
              );
            })}
          </div>
        </Field>

        {form.source_kind === 'git' && (
          <>
            <Field label="Git URL" hint="public HTTPS or git@ URL">
              <input value={form.git_url} onChange={e => updateForm('git_url', e.target.value)} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="https://github.com/your/repo"/>
            </Field>
            <Field label="Ref (optional)" hint="branch, tag, or commit SHA — pin for reproducible builds. Phase 3.4.">
              <input value={form.git_ref} onChange={e => updateForm('git_ref', e.target.value)} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="v1.2.3  /  main  /  abc1234"/>
            </Field>
          </>
        )}
        {form.source_kind === 'zip' && (
          <Field label="ZIP file" hint="streamed to the Hub via chunked HTTP; size limited only by disk">
            <input type="file" accept=".zip" onChange={e => updateForm('zip_file', e.target.files?.[0] || null)} style={{ ...inp, padding: '6px 10px' }}/>
            {form.zip_file && (
              <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
                {form.zip_file.name} · {prettyBytes(form.zip_file.size)}
              </div>
            )}
          </Field>
        )}
        {form.source_kind === 'folder' && (
          <Field label="Folder path" hint="absolute path on the host running the Hub (read-only — engine copies into builds/<name>/src/)">
            <input value={form.folder_path} onChange={e => updateForm('folder_path', e.target.value)} style={{ ...inp, fontFamily: FONT_MONO }} placeholder="/Users/you/code/widget"/>
          </Field>
        )}

        <Field label="Build profile (optional)" hint="apply pre-configured defaults from builds/<id>/profile.json — RaspyJack, Claude-CLI Pi, etc.">
          <select value={form.profile_id} onChange={e => updateForm('profile_id', e.target.value)} style={inp}>
            <option value="">— none (raw compile) —</option>
            {profiles.map(p => <option key={p.profile_id} value={p.profile_id}>{p.name} ({p.profile_id})</option>)}
          </select>
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.use_venv} onChange={e => updateForm('use_venv', e.target.checked)}/>
          Use per-build pip venv (Phase 3.5) — avoids <code>--break-system-packages</code>
        </label>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
          <button onClick={run} disabled={busy} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px',
            background: busy ? COLORS.bgPanel : COLORS.bgActive,
            color: COLORS.accentBright,
            border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8,
            fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
          }}>
            <Play size={14}/> {busy ? (uploadPct > 0 && uploadPct < 100 ? `uploading ${uploadPct}%…` : 'compiling…') : 'Ingest → detect → compile'}
          </button>
          {uploadPct > 0 && uploadPct < 100 && (
            <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', maxWidth: 240 }}>
              <div style={{ width: `${uploadPct}%`, height: '100%', background: COLORS.accent, transition: 'width 200ms ease' }}/>
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: 12, background: 'rgba(239,111,92,0.08)', border: `1px solid ${COLORS.error}`, borderRadius: 6, color: COLORS.error, fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }}/>
            <div><strong>Build failed</strong><br/>{error}</div>
          </div>
        )}
      </section>

      {result && <ResultPanel result={result}/>}
    </div>
  );
}

function ResultPanel({ result }) {
  const m = result.manifest || {};
  const p = result.plan_summary || {};
  return (
    <section style={{ padding: 16, background: COLORS.bgPanel, border: `1px solid ${COLORS.success}`, borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Check size={18} style={{ color: COLORS.success }}/>
        <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.success }}>
          Build compiled: {result.build_name}
        </h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Stat label="Input type"    value={result.input_type}/>
        <Stat label="Architecture"  value={(m.architecture || []).join(', ') || '—'}/>
        <Stat label="Entry points"  value={(m.entry_points || []).length}/>
        <Stat label="apt deps"      value={(m.dependencies?.apt || []).length}/>
        <Stat label="pip deps"      value={(m.dependencies?.pip || []).length}/>
        <Stat label="Plan steps"    value={p.step_count}/>
      </div>

      {p.chosen_entry_point && (
        <div style={{ fontSize: 12, color: COLORS.textSecondary, fontFamily: FONT_BODY }}>
          Chosen entry point: <code style={{ fontFamily: FONT_MONO, color: COLORS.accentBright }}>{p.chosen_entry_point}</code>
        </div>
      )}

      <details>
        <summary style={{ fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer' }}>
          Full manifest
        </summary>
        <pre style={{ margin: '8px 0 0', padding: 12, background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55, overflow: 'auto', maxHeight: 320 }}>
          {JSON.stringify(m, null, 2)}
        </pre>
      </details>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
        <span>plan: <code>{relPath(result.plan_path)}</code></span>
        <span>script: <code>{relPath(result.script_path)}</code></span>
        <span>log: <code>{relPath(result.log_path)}</code></span>
      </div>

      <div style={{ marginTop: 4, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
        Next: flash via <strong>Builder → ark-builder build</strong> (CLI on the host), or upload the resulting <code>.img</code> to the
        Flash Nodes tab and queue a job to a registered node. The script is at <code>{relPath(result.script_path)}</code>.
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.025)', border: `1px solid ${COLORS.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 16, marginTop: 2, color: COLORS.textPrimary, fontFamily: FONT_MONO }}>{String(value ?? '—')}</div>
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

function relPath(p) {
  if (!p) return '—';
  return p.replace(/^.*\/Ark\//, '');
}
function prettyBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}

const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', background: '#040608', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_BODY, fontSize: 13, outline: 'none' };
