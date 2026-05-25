// Vault UI — manage encrypted credentials stored at the Hub.
//
// Plaintext NEVER flows through this panel: the Hub's /api/vault/set
// accepts a value, returns a ref, and that's it. Listing returns
// labels + refs only. Decryption is internal-only (used by the
// installer engine when baking creds into install.plan.sh).

import React, { useEffect, useState, useCallback } from 'react';
import { KeyRound, Plus, Trash2, Lock, Eye, EyeOff } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';

const HUB_KEY = 'ark.hubUrl';
const DEFAULT_HUB = 'http://192.168.4.167:7400';
function readHubUrl() {
  try { return (window.localStorage.getItem(HUB_KEY) || DEFAULT_HUB).replace(/\/+$/, ''); }
  catch { return DEFAULT_HUB; }
}

const KINDS = [
  { id: 'wifi-key',  label: 'Wi-Fi key',         hint: 'PSK / WPA2 key for an SSID' },
  { id: 'ssh-key',   label: 'SSH private key',   hint: 'paste the file contents (RSA / ed25519 …)' },
  { id: 'api-token', label: 'API token',         hint: 'e.g. ANTHROPIC_API_KEY, GitHub token' },
  { id: 'other',     label: 'Other secret',      hint: 'generic blob' },
];

export default function Vault() {
  const hubUrl = readHubUrl();
  const [entries, setEntries] = useState([]);
  const [error,   setError]   = useState(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${hubUrl}/api/vault/list`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setEntries(j.entries || []);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [hubUrl]);
  useEffect(() => { refresh(); }, [refresh]);

  async function remove(ref) {
    if (!confirm(`Permanently delete ${ref}? Anything that referenced it will lose access.`)) return;
    await fetch(`${hubUrl}/api/vault/${encodeURIComponent(ref)}`, { method: 'DELETE' });
    refresh();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <KeyRound size={20} style={{ color: COLORS.accent }}/>
          <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
            Vault
          </h2>
        </div>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Encrypted credential store. AES-256-GCM at rest. Plaintext only ever leaves the Hub when the Installer
          Engine bakes a credential into an install plan — it's never returned to this UI.
        </p>
      </header>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={() => setCreating(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px',
          background: COLORS.bgActive, color: COLORS.accentBright,
          border: `1px solid ${COLORS.accentBorder}`, borderRadius: 8,
          fontFamily: FONT_BODY, fontSize: 13, cursor: 'pointer',
        }}><Plus size={14}/> Add credential</button>
        <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
          {entries.length} stored
        </span>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(245,180,90,0.08)', border: `1px solid ${COLORS.warning}`, borderRadius: 8, color: COLORS.warning, fontSize: 12 }}>
          Hub unreachable: {error}
        </div>
      )}

      {entries.length === 0 ? (
        <div style={{ padding: 24, background: COLORS.bgPanel, border: `1px dashed ${COLORS.border}`, borderRadius: 10, color: COLORS.textMuted, fontSize: 13 }}>
          No credentials stored yet. Add one above; the Hub returns an opaque <code>v_xxx</code> ref you can paste into a manifest's
          <code> credential_ref</code> field. The installer engine then resolves the ref to plaintext at build time.
        </div>
      ) : (
        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: 'hidden', background: COLORS.bgPanel }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_BODY, fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={th}>Ref</th><th style={th}>Label</th><th style={th}>Kind</th><th style={th}>Created</th><th style={th}>Last accessed</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.ref}>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11 }}>
                    <span style={{
                      padding: '2px 8px', background: 'rgba(6,182,212,0.10)',
                      color: COLORS.accentBright, borderRadius: 4,
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}><Lock size={10}/> {e.ref}</span>
                  </td>
                  <td style={td}>{e.label}</td>
                  <td style={td}><span style={kindChip(e.kind)}>{e.kind}</span></td>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{e.created_at?.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ ...td, fontFamily: FONT_MONO, fontSize: 11, color: COLORS.textMuted }}>{e.accessed_at?.slice(0, 16).replace('T', ' ') || 'never'}</td>
                  <td style={td}>
                    <button onClick={() => remove(e.ref)} style={{
                      padding: '4px 10px', fontSize: 11, background: 'transparent',
                      color: COLORS.error, border: `1px solid ${COLORS.border}`, borderRadius: 4, cursor: 'pointer',
                    }}><Trash2 size={10}/> remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section style={{ padding: 14, background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <h3 style={{ margin: '0 0 8px', fontFamily: FONT_HEADING, fontSize: 16, color: COLORS.textPrimary }}>Security posture</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.textSecondary, fontSize: 12, lineHeight: 1.8 }}>
          <li>Master key at <code style={{ fontFamily: FONT_MONO }}>~/.ark/vault.master.key</code>, 32 random bytes, 0600 perms (owner-only).</li>
          <li>Each entry encrypted with AES-256-GCM, random 12-byte IV, auth-tag stored alongside ciphertext.</li>
          <li>HTTP API exposes <strong>set / list / delete only</strong>. Plaintext retrieval is internal — used by the Installer Engine.</li>
          <li>Anyone with read access to the master key file can decrypt everything. Protect it accordingly.</li>
        </ul>
      </section>

      {creating && <CreateModal hubUrl={hubUrl} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }}/>}
    </div>
  );
}

function CreateModal({ hubUrl, onClose, onCreated }) {
  const [label, setLabel] = useState('');
  const [kind,  setKind]  = useState('api-token');
  const [value, setValue] = useState('');
  const [show,  setShow]  = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  async function submit() {
    setErr(null);
    if (!label.trim() || !value)  { setErr('label and value required'); return; }
    setBusy(true);
    try {
      const r = await fetch(`${hubUrl}/api/vault/set`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, kind, value }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onCreated(j);
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  }

  const kindHint = KINDS.find(k => k.id === kind)?.hint;
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
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 20 }}>Add credential</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Label" hint="short human name (e.g. 'home-wifi', 'github-token')">
            <input value={label} onChange={e => setLabel(e.target.value)} style={inp} placeholder="home-wifi"/>
          </Field>
          <Field label="Kind" hint={kindHint}>
            <select value={kind} onChange={e => setKind(e.target.value)} style={inp}>
              {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Value" hint="encrypted at rest; only the installer engine ever decrypts">
            <div style={{ position: 'relative' }}>
              <textarea
                value={value} onChange={e => setValue(e.target.value)}
                rows={kind === 'ssh-key' ? 8 : 2}
                style={{ ...inp, fontFamily: FONT_MONO, fontSize: 12, paddingRight: 36, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                placeholder={kind === 'ssh-key' ? '-----BEGIN OPENSSH PRIVATE KEY-----\n…' : '…'}
                spellCheck={false}
                {...(show ? {} : { style: { ...inp, fontFamily: FONT_MONO, fontSize: 12, paddingRight: 36, width: '100%', boxSizing: 'border-box', resize: 'vertical', WebkitTextSecurity: 'disc' } })}
              />
              <button type="button" onClick={() => setShow(!show)} title={show ? 'hide' : 'show'} style={{
                position: 'absolute', top: 6, right: 6,
                background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer',
              }}>{show ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
            </div>
          </Field>

          {err && <div style={{ color: COLORS.error, fontSize: 12 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={onClose} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.textSecondary, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={submit} disabled={busy} style={{ padding: '8px 14px', background: COLORS.accent, border: 'none', borderRadius: 8, color: '#0a0a0a', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'storing…' : 'Store encrypted'}
            </button>
          </div>
        </div>
      </div>
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

function kindChip(kind) {
  const c = kind === 'wifi-key' ? COLORS.accent
          : kind === 'ssh-key'  ? COLORS.warning
          : kind === 'api-token' ? COLORS.accentBright
          : COLORS.textMuted;
  return {
    padding: '2px 8px', fontSize: 10, borderRadius: 4,
    background: c + '22', color: c,
    textTransform: 'uppercase', letterSpacing: 0.5,
  };
}

const th = { textAlign: 'left', padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` };
const td = { padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textPrimary };
const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', background: 'rgba(0,0,0,0.3)', color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontFamily: FONT_BODY, fontSize: 13 };
