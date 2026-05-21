import React, { useEffect, useMemo, useState } from 'react';
import {
  Cpu, Wifi, Monitor, FileText, Terminal, Plus, Copy as CopyIcon,
  Trash2, Download, Save, Settings, Shield, AlertTriangle, Info,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, btnPrimary } from './lib/theme.js';
import {
  emptyManifest, cloneManifest, applyRoleDefaults, validateManifest,
  loadManifests, saveManifests, loadActiveId, saveActiveId,
  ROLES, MODELS, DISPLAYS, TIMEZONES, URL_PRESETS,
} from './manifest.js';
import { dietpiTxt, automationScript } from './output.js';

// =====================================================================
// Ark — device manifest editor + config generator (Phase 1)
// =====================================================================
// See /Ark/PLAN.md for the full scope. This file is the entire app
// for now; we'll split into per-section components if it grows past
// ~1500 lines.
//
// Three columns: Library (saved manifests) → Editor (the 6 layers)
// → Output (live preview + download). Everything in localStorage;
// no backend, no upload.
// =====================================================================

function downloadBlob(name, contents, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function uid() {
  return 'm_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default function App() {
  // Manifests keyed by id → manifest object.
  const [manifests, setManifestsState] = useState(() => loadManifests());
  const [activeId, setActiveIdState] = useState(() => loadActiveId());
  const [previewKey, setPreviewKey] = useState('dietpi'); // dietpi | script | json

  // Persist whenever the map or active selection changes.
  useEffect(() => { saveManifests(manifests); }, [manifests]);
  useEffect(() => { if (activeId) saveActiveId(activeId); }, [activeId]);

  // First-run: if no manifests exist, seed one so the user lands on a
  // populated form rather than an empty list.
  useEffect(() => {
    if (Object.keys(manifests).length === 0) {
      const id = uid();
      const m = emptyManifest('ark-kiosk-01');
      setManifestsState({ [id]: m });
      setActiveIdState(id);
    } else if (!activeId || !manifests[activeId]) {
      setActiveIdState(Object.keys(manifests)[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = activeId ? manifests[activeId] : null;
  const warnings = useMemo(() => active ? validateManifest(active) : [], [active]);
  const dietpi   = useMemo(() => active ? dietpiTxt(active)       : '', [active]);
  const script   = useMemo(() => active ? automationScript(active) : '', [active]);

  function update(path, value) {
    if (!active) return;
    setManifestsState(prev => {
      const next = { ...prev };
      const copy = structuredClone(next[activeId]);
      let cursor = copy;
      const parts = path.split('.');
      for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]];
      cursor[parts[parts.length - 1]] = value;
      next[activeId] = copy;
      return next;
    });
  }

  function setRole(role) {
    if (!active) return;
    setManifestsState(prev => ({ ...prev, [activeId]: applyRoleDefaults(prev[activeId], role) }));
  }

  function newManifest() {
    const id = uid();
    const n = Object.keys(manifests).length + 1;
    const m = emptyManifest(`ark-device-${String(n).padStart(2, '0')}`);
    setManifestsState(prev => ({ ...prev, [id]: m }));
    setActiveIdState(id);
  }
  function cloneActive() {
    if (!active) return;
    const id = uid();
    const newName = `${active.identity.name}-clone`;
    setManifestsState(prev => ({ ...prev, [id]: cloneManifest(active, newName) }));
    setActiveIdState(id);
  }
  function deleteActive() {
    if (!active) return;
    if (!confirm(`Delete manifest "${active.identity.name}"?`)) return;
    setManifestsState(prev => {
      const next = { ...prev };
      delete next[activeId];
      return next;
    });
    const remaining = Object.keys(manifests).filter(k => k !== activeId);
    setActiveIdState(remaining[0] || null);
  }

  function downloadBoth() {
    if (!active) return;
    downloadBlob('dietpi.txt', dietpi);
    setTimeout(() => downloadBlob('Automation_Custom_Script.sh', script, 'text/x-shellscript'), 250);
  }
  function downloadJson() {
    if (!active) return;
    downloadBlob(`${active.identity.name}.manifest.json`, JSON.stringify(active, null, 2), 'application/json');
  }

  // Layout: 3 columns at desktop, stacked at narrow widths.
  return (
    <div style={{ minHeight: '100vh', padding: 'clamp(0.6rem, 2vw, 1.5rem)', maxWidth: 1500, margin: '0 auto' }}>
      <header style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{
            margin: 0,
            fontFamily: FONT_HEADING,
            fontStyle: 'italic',
            fontSize: 'clamp(2.4rem, 6vw, 3.6rem)',
            lineHeight: 1.1,
            background: `linear-gradient(135deg, ${COLORS.accentBright} 0%, ${COLORS.accent} 60%, ${COLORS.textPrimary} 100%)`,
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            paddingBottom: '0.08em',
          }}>
            Ark
          </h1>
          <div style={{ fontSize: 12, color: COLORS.textMuted, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 600, marginTop: 4 }}>
            Sinsera device provisioning · Phase 1
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={newManifest} style={btnGhost()}><Plus size={14}/> New device</button>
          <button onClick={cloneActive} style={btnGhost()} disabled={!active}><CopyIcon size={14}/> Clone</button>
          <button onClick={downloadJson} style={btnGhost()} disabled={!active}><Save size={14}/> Export JSON</button>
          <button onClick={deleteActive} style={{ ...btnGhost(), color: COLORS.error, borderColor: COLORS.error }} disabled={!active}><Trash2 size={14}/> Delete</button>
        </div>
      </header>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 220px) minmax(0, 1fr) minmax(280px, 1fr)',
        gap: 16,
        alignItems: 'start',
      }}>
        {/* ── LIBRARY ─────────────────────────────────────────────── */}
        <aside style={cardStyle()}>
          <h3 style={sectionTitle()}>Library</h3>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 10 }}>
            Saved manifests (local).
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(manifests).length === 0 && (
              <div style={{ color: COLORS.textMuted, fontSize: 12 }}>No manifests yet.</div>
            )}
            {Object.entries(manifests).map(([id, m]) => (
              <button key={id} onClick={() => setActiveIdState(id)} style={{
                textAlign: 'left',
                padding: '8px 10px',
                background: id === activeId ? COLORS.bgActive : 'transparent',
                color: COLORS.textPrimary,
                border: `1px solid ${id === activeId ? COLORS.accentBorder : 'transparent'}`,
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                <span style={{ fontWeight: 600 }}>{m.identity.name}</span>
                <span style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {m.identity.role} · {m.hardware.model}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* ── EDITOR ──────────────────────────────────────────────── */}
        <main style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!active && <div style={cardStyle()}>Pick or create a manifest from the Library.</div>}
          {active && <>
            <WarningsPanel warnings={warnings} />

            <Section title="Identity" icon={Shield}>
              <Row label="Name (slug)">
                <input type="text" value={active.identity.name}
                  onChange={(e) => { update('identity.name', e.target.value); update('network.hostname', e.target.value); }}
                  style={inputStyle()}/>
              </Row>
              <Row label="Role">
                <select value={active.identity.role} onChange={(e) => setRole(e.target.value)} style={inputStyle()}>
                  {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <div style={hintStyle()}>
                  {ROLES.find(r => r.id === active.identity.role)?.desc}
                </div>
              </Row>
            </Section>

            <Section title="Hardware" icon={Cpu}>
              <Row label="Model">
                <select value={active.hardware.model} onChange={(e) => update('hardware.model', e.target.value)} style={inputStyle()}>
                  {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <div style={hintStyle()}>{MODELS.find(m => m.id === active.hardware.model)?.note}</div>
              </Row>
              <Row label="Display">
                <select value={active.hardware.display} onChange={(e) => update('hardware.display', e.target.value)} style={inputStyle()}>
                  {DISPLAYS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Row>
              <Row label="Peripherals">
                <Check checked={active.hardware.pisugar} onChange={(v) => update('hardware.pisugar', v)} label="PiSugar battery / UPS HAT"/>
                <Check checked={active.hardware.ethernet} onChange={(v) => update('hardware.ethernet', v)} label="Ethernet HAT"/>
              </Row>
              <Row label="Power notes (optional)">
                <input type="text" value={active.hardware.power_note} onChange={(e) => update('hardware.power_note', e.target.value)} style={inputStyle()} placeholder="e.g. car USB-C 5V/3A"/>
              </Row>
            </Section>

            <Section title="Network" icon={Wifi}>
              <Row label="Hostname">
                <input type="text" value={active.network.hostname} onChange={(e) => update('network.hostname', e.target.value)} style={inputStyle()}/>
              </Row>
              <Row label="WiFi SSID (leave blank for ethernet only)">
                <input type="text" value={active.network.wifi_ssid} onChange={(e) => update('network.wifi_ssid', e.target.value)} style={inputStyle()}/>
              </Row>
              <Row label="WiFi password">
                <input type="password" value={active.network.wifi_password} onChange={(e) => update('network.wifi_password', e.target.value)} style={inputStyle()}/>
              </Row>
              <Row label="SSH">
                <Check checked={active.network.ssh_enabled} onChange={(v) => update('network.ssh_enabled', v)} label="Enable SSH"/>
                <Check checked={active.network.mdns}        onChange={(v) => update('network.mdns', v)}        label="mDNS (resolve .local)"/>
              </Row>
              <Row label="SSH public keys (one per line, authorized_keys format)">
                <textarea
                  value={(active.network.ssh_pubkeys || []).join('\n')}
                  onChange={(e) => update('network.ssh_pubkeys', e.target.value.split('\n').filter(Boolean))}
                  style={{ ...inputStyle(), minHeight: 88, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
                  placeholder="ssh-ed25519 AAAA... user@host"
                />
              </Row>
            </Section>

            <Section title="Software" icon={Settings}>
              <Row label="Timezone">
                <select value={active.software.timezone} onChange={(e) => update('software.timezone', e.target.value)} style={inputStyle()}>
                  {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </Row>
              <Row label="Root password (used for SSH if pubkeys aren't set)">
                <input type="password" value={active.software.root_password} onChange={(e) => update('software.root_password', e.target.value)} style={inputStyle()}/>
              </Row>
              <Row label="Boot target">
                <select value={active.software.boot_target} onChange={(e) => update('software.boot_target', e.target.value)} style={inputStyle()}>
                  <option value="kiosk">Kiosk (Chromium auto-launch)</option>
                  <option value="desktop">Desktop (LXDE login)</option>
                  <option value="headless">Headless (CLI only)</option>
                </select>
              </Row>
            </Section>

            {active.identity.role !== 'headless' && (
              <Section title="Kiosk" icon={Monitor}>
                <Row label="Target URL">
                  <input type="url" value={active.kiosk.url} onChange={(e) => update('kiosk.url', e.target.value)} style={inputStyle()} placeholder="https://sinsera.co"/>
                </Row>
                <Row label="Presets">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {URL_PRESETS.map(p => (
                      <button key={p.id} onClick={() => update('kiosk.url', p.url)} title={p.hint || ''}
                        style={presetBtn(active.kiosk.url === p.url)}>{p.label}</button>
                    ))}
                  </div>
                </Row>
                <Row label="Screen rotation">
                  <select value={active.kiosk.rotation} onChange={(e) => update('kiosk.rotation', e.target.value)} style={inputStyle()}>
                    <option value="normal">Normal (landscape)</option>
                    <option value="left">90° left (portrait)</option>
                    <option value="right">90° right (portrait)</option>
                    <option value="inverted">180° inverted</option>
                  </select>
                </Row>
                <Row label="Auto-reload (minutes; 0 = off)">
                  <input type="number" min={0} max={1440}
                    value={active.kiosk.auto_reload_min}
                    onChange={(e) => update('kiosk.auto_reload_min', Number(e.target.value))} style={inputStyle()}/>
                </Row>
                <Row label="Behaviour">
                  <Check checked={active.kiosk.hide_cursor}      onChange={(v) => update('kiosk.hide_cursor', v)}      label="Hide mouse cursor when idle"/>
                  <Check checked={active.kiosk.disable_blanking} onChange={(v) => update('kiosk.disable_blanking', v)} label="Disable screen blanking"/>
                </Row>
              </Section>
            )}

            <Section title="Behaviour" icon={Settings}>
              <Row label="Watchdog (Phase 2)">
                <Check checked={active.behaviour.watchdog} onChange={(v) => update('behaviour.watchdog', v)} label="Auto-restart if the kiosk crashes (stub; not wired yet)"/>
              </Row>
              <Row label="Offline fallback (Phase 2)">
                <Check checked={active.behaviour.offline_fallback} onChange={(v) => update('behaviour.offline_fallback', v)} label="Show a local HTML page when the network is down (stub)"/>
              </Row>
            </Section>
          </>}
        </main>

        {/* ── OUTPUT ──────────────────────────────────────────────── */}
        <aside style={cardStyle()}>
          <h3 style={sectionTitle()}>Output</h3>
          <p style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 0, lineHeight: 1.5 }}>
            Flash <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>Os/DietPi_RPi5-ARMv8-Trixie.img</code> with Raspberry Pi Imager. Drop these two files onto the boot partition. Boot the Pi.
          </p>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: `1px solid ${COLORS.border}` }}>
            {[
              { id: 'dietpi', label: 'dietpi.txt',                  Icon: FileText },
              { id: 'script', label: 'Automation_Custom_Script.sh', Icon: Terminal },
              { id: 'json',   label: 'manifest.json',               Icon: Save     },
            ].map(({ id, label, Icon }) => (
              <button key={id} onClick={() => setPreviewKey(id)} style={tabBtn(previewKey === id)}>
                <Icon size={13}/> {label}
              </button>
            ))}
          </div>

          <pre style={{
            margin: 0, padding: 10, maxHeight: 420, overflow: 'auto',
            background: 'rgba(0,0,0,0.4)', border: `1px solid ${COLORS.border}`,
            borderRadius: 6, fontSize: 11, lineHeight: 1.5,
            color: COLORS.textSecondary, fontFamily: 'ui-monospace, monospace',
          }}>
{previewKey === 'dietpi' ? dietpi : previewKey === 'script' ? script : JSON.stringify(active, null, 2)}
          </pre>

          <button onClick={downloadBoth} style={{ ...btnPrimary(), width: '100%', padding: '12px 14px', justifyContent: 'center', marginTop: 12 }}>
            <Download size={16}/> Download dietpi.txt + script
          </button>
        </aside>
      </div>

      <footer style={{ marginTop: 28, fontSize: 11, color: COLORS.textMuted, textAlign: 'center', letterSpacing: '0.04em' }}>
        Ark · Sinsera Pty Ltd · Phase 1 (manifest + config). See PLAN.md in the repo for the full roadmap.
      </footer>
    </div>
  );
}


// ── Building blocks ────────────────────────────────────────────────

function Section({ title, icon: Icon, children }) {
  return (
    <div style={cardStyle()}>
      <h3 style={sectionTitle()}>{Icon && <Icon size={14}/>} {title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  );
}
function Row({ label, children }) {
  return (
    <div>
      <div style={{
        fontSize: 10, color: COLORS.textMuted, letterSpacing: '0.08em',
        textTransform: 'uppercase', fontWeight: 600, marginBottom: 6,
      }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}
function Check({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: COLORS.textSecondary }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: COLORS.accent }}/>
      {label}
    </label>
  );
}
function WarningsPanel({ warnings }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div style={{ ...cardStyle(), borderColor: COLORS.warning, padding: 12 }}>
      <h4 style={{ ...sectionTitle(), color: COLORS.warning, margin: '0 0 8px' }}>
        <AlertTriangle size={14}/> Manifest check
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {warnings.map((w, i) => {
          const color = w.severity === 'error' ? COLORS.error
                      : w.severity === 'warn'  ? COLORS.warning
                      :                          COLORS.info;
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: COLORS.textSecondary }}>
              <Info size={12} style={{ color, marginTop: 2, flexShrink: 0 }}/>
              <span>{w.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── style helpers ──────────────────────────────────────────────────
function cardStyle() {
  return {
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    padding: 16,
  };
}
function sectionTitle() {
  return {
    margin: '0 0 14px',
    fontFamily: FONT_HEADING,
    fontSize: '1.05rem',
    color: COLORS.textPrimary,
    display: 'flex', alignItems: 'center', gap: 8,
  };
}
function inputStyle() {
  return {
    width: '100%', padding: '8px 10px', fontSize: 13,
    background: 'rgba(10, 10, 10, 0.55)', color: COLORS.textPrimary,
    border: `1px solid ${COLORS.border}`, borderRadius: 6,
    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  };
}
function btnGhost() {
  return {
    padding: '6px 10px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', color: COLORS.textSecondary,
    border: `1px solid ${COLORS.border}`, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontFamily: FONT_BODY,
  };
}
function presetBtn(active) {
  return {
    padding: '5px 9px', fontSize: 11, cursor: 'pointer',
    background: active ? COLORS.accent : 'transparent',
    color: active ? '#0a0a0a' : COLORS.textSecondary,
    border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
    borderRadius: 5, fontFamily: 'inherit',
  };
}
function tabBtn(active) {
  return {
    padding: '6px 10px', cursor: 'pointer',
    background: 'transparent',
    color: active ? COLORS.accent : COLORS.textMuted,
    border: 0,
    borderBottom: `2px solid ${active ? COLORS.accent : 'transparent'}`,
    fontFamily: 'inherit', fontSize: 11,
    display: 'inline-flex', alignItems: 'center', gap: 5,
  };
}
function hintStyle() {
  return { fontSize: 11, color: COLORS.textMuted, marginTop: -2, lineHeight: 1.4 };
}
