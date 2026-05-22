import React, { useEffect, useMemo, useRef, useState } from 'react';
import NetworkLandscape from './NetworkLandscape.jsx';
import Fleet from './Fleet.jsx';
import Presets from './Presets.jsx';
import Builds from './Builds.jsx';
import Images from './Images.jsx';
import Logs from './Logs.jsx';
import FlashNodes from './FlashNodes.jsx';
import {
  // Nav
  Cpu, HardDrive, Layers, Boxes, Image as ImageIcon, ScrollText, Server,
  Radar,
  // Layers
  Shield, Wifi, Monitor, Settings, Activity,
  // Actions
  Plus, Copy as CopyIcon, Trash2, Download, Save, Upload,
  // State
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Check as CheckIcon, X as XIcon,
  AlertTriangle, Info, Gauge, Zap, FileText, Terminal, FileJson, Power,
} from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO, btnPrimary } from './lib/theme.js';
import {
  emptyManifest, cloneManifest, applyRoleDefaults, validateManifest,
  loadManifests, saveManifests, loadActiveId, saveActiveId,
  ROLES, MODELS, DISPLAYS, TIMEZONES, URL_PRESETS,
} from './manifest.js';
import { dietpiTxt, automationScript } from './output.js';
import { buildPlan, buildPlanJson } from './build_plan.js';

// =====================================================================
// Ark — device provisioning + compiler (Phase 1 v2)
// =====================================================================
// Layout: left nav | centre device stack | right validation panel |
// pinned bottom build-output drawer. The intent is "assembling a
// machine, not filling a form" — collapsible layers, live validation,
// a structured build-plan preview. See /Ark/PLAN.md for the roadmap.
// =====================================================================

// ── small utilities ────────────────────────────────────────────────
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

// localStorage keys for UI state (separate from manifest storage).
// drawer key bumped to v2 so the new collapsed-default takes effect
// even for users who have a v1 "open=true" already in localStorage
const UI_DRAWER_OPEN_KEY   = 'ark.ui.drawer.open.v2';
const UI_DRAWER_HEIGHT_KEY = 'ark.ui.drawer.height.v1';
const UI_DRAWER_TAB_KEY    = 'ark.ui.drawer.tab.v1';
const UI_CONFIG_SUBTAB_KEY = 'ark.ui.drawer.configSubtab.v1';
const UI_SIDEBAR_OPEN_KEY  = 'ark.ui.sidebar.open.v1';
const UI_RIGHT_OPEN_KEY    = 'ark.ui.right.open.v1';
const UI_NAV_KEY           = 'ark.ui.nav.v1';
const UI_LAYERS_KEY        = 'ark.ui.layers.v1';

function readJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── Nav definition ─────────────────────────────────────────────────
const NAV_SECTIONS = [
  { id: 'devices',   label: 'Devices',   icon: Cpu,        kind: 'active' },
  { id: 'network',   label: 'Network',   icon: Radar,      kind: 'active' },
  { id: 'builds',    label: 'Builds',    icon: HardDrive,  kind: 'active' },
  { id: 'manifests', label: 'Manifests', icon: Layers,     kind: 'list' },
  { id: 'presets',   label: 'Presets',   icon: Boxes,      kind: 'active' },
  { id: 'fleet',     label: 'Fleet',     icon: Server,     kind: 'active' },
  { id: 'flash',     label: 'Flash Nodes', icon: Zap,      kind: 'active' },
  { id: 'images',    label: 'Images',    icon: ImageIcon,  kind: 'active' },
  { id: 'logs',      label: 'Logs',      icon: ScrollText, kind: 'active' },
];

// ── Device-stack layer definition ──────────────────────────────────
// One entry per layer in the centre stack. `body` is a render fn that
// receives (active, update, setRole) and returns the form body.
// `summary` is a render fn that returns a one-line state summary so
// the collapsed card still reads usefully.
const LAYERS = [
  {
    id: 'identity',
    title: 'Identity',
    icon: Shield,
    summary: (m) => `${m.identity.name || 'unnamed'} · ${labelForRole(m.identity.role)}`,
    visible: () => true,
    body: IdentityBody,
  },
  {
    id: 'hardware',
    title: 'Hardware',
    icon: Cpu,
    summary: (m) => `${labelForModel(m.hardware.model)} · ${labelForDisplay(m.hardware.display)}${m.hardware.pisugar ? ' · PiSugar' : ''}${m.hardware.ethernet ? ' · Ethernet' : ''}`,
    visible: () => true,
    body: HardwareBody,
  },
  {
    id: 'network',
    title: 'Network',
    icon: Wifi,
    summary: (m) => `${m.network.hostname || 'no-hostname'} · ${m.network.wifi_ssid ? `WiFi:${m.network.wifi_ssid}` : 'no WiFi'} · SSH ${m.network.ssh_enabled ? 'on' : 'off'}`,
    visible: () => true,
    body: NetworkBody,
  },
  {
    id: 'os',
    title: 'OS',
    icon: HardDrive,
    summary: (m) => `DietPi · ${m.software.timezone} · ${(m.software.packages || []).length} pkg${(m.software.packages || []).length === 1 ? '' : 's'}`,
    visible: () => true,
    body: OsBody,
  },
  {
    id: 'behaviour',
    title: 'Behaviour',
    icon: Activity,
    summary: (m) => {
      const bits = [];
      bits.push(m.behaviour.watchdog ? 'watchdog' : 'no watchdog');
      if (m.behaviour.offline_fallback) bits.push('offline fallback');
      if (m.behaviour.auto_reboot_schedule) bits.push(`reboot ${m.behaviour.auto_reboot_schedule}`);
      return bits.join(' · ');
    },
    visible: () => true,
    body: BehaviourBody,
  },
  {
    id: 'kiosk',
    title: 'Kiosk',
    icon: Monitor,
    summary: (m) => `${m.kiosk.url || '— no URL —'} · ${m.kiosk.rotation}${m.kiosk.auto_reload_min > 0 ? ` · reload ${m.kiosk.auto_reload_min}m` : ''}`,
    visible: (m) => m.identity.role !== 'headless',
    body: KioskBody,
  },
];

function labelForRole(id)    { return ROLES.find(r => r.id === id)?.label    || id; }
function labelForModel(id)   { return MODELS.find(r => r.id === id)?.label   || id; }
function labelForDisplay(id) { return DISPLAYS.find(r => r.id === id)?.label || id; }

// ── Hardware-risk lookup ───────────────────────────────────────────
// A flat table for now. Phase 2 graduates this to a real rules engine.
const HARDWARE_RISKS = [
  {
    match: (m) => m.hardware.pisugar && m.hardware.ethernet && m.hardware.display === 'lcd-spi',
    text:  'PiSugar + ethernet HAT + LCD: ~1.2 A peak — confirm PSU rating ≥ 2 A.',
    severity: 'warn',
    amps: 1.2,
  },
  {
    match: (m) => m.hardware.model === 'pi-5' && !m.hardware.power_note,
    text:  'Pi 5 needs the official 5 V / 5 A PSU for USB peripherals at full draw — set a power note.',
    severity: 'info',
    amps: 5.0,
  },
  {
    match: (m) => m.hardware.model === 'pi-zero-2-w' && m.hardware.ethernet,
    text:  'Pi Zero 2 W has no native Ethernet — confirm the HAT is USB-OTG (e.g. Waveshare ETH/USB HUB).',
    severity: 'info',
    amps: 0.7,
  },
  {
    match: (m) => m.hardware.pisugar && m.identity.role !== 'portable' && m.software.boot_target !== 'headless',
    text:  'PiSugar HAT on a stationary kiosk — battery cycling shortens cell life; consider mains-only.',
    severity: 'info',
  },
  {
    match: (m) => m.hardware.display === 'dsi' && m.kiosk.rotation && m.kiosk.rotation !== 'normal',
    text:  'DSI display + non-default rotation: confirm /boot/config.txt rotation matches Xorg rotation.',
    severity: 'warn',
  },
];

function hardwareRisks(m) {
  return HARDWARE_RISKS.filter(r => r.match(m));
}

// Score: 100 baseline, -10 per warn, -25 per error, -3 per info. Clamp ≥ 0.
function compatibilityScore(warnings) {
  let s = 100;
  for (const w of warnings) {
    if (w.severity === 'error') s -= 25;
    else if (w.severity === 'warn') s -= 10;
    else s -= 3;
  }
  return Math.max(0, s);
}
function scoreColor(s) {
  if (s >= 85) return COLORS.success;
  if (s >= 60) return COLORS.warning;
  return COLORS.error;
}

// =====================================================================
//  Root App component
// =====================================================================
export default function App() {
  // ── manifest store ──────────────────────────────────────────────
  const [manifests, setManifestsState] = useState(() => loadManifests());
  const [activeId, setActiveIdState]   = useState(() => loadActiveId());

  // ── UI state ────────────────────────────────────────────────────
  const [nav, setNav]                 = useState(() => readJSON(UI_NAV_KEY, 'devices'));
  const [openLayers, setOpenLayers]   = useState(() => readJSON(UI_LAYERS_KEY, { identity: true, hardware: true }));
  const [drawerOpen, setDrawerOpen]   = useState(() => readJSON(UI_DRAWER_OPEN_KEY, false));
  const [sidebarOpen, setSidebarOpen] = useState(() => readJSON(UI_SIDEBAR_OPEN_KEY, true));
  const [rightOpen,   setRightOpen]   = useState(() => readJSON(UI_RIGHT_OPEN_KEY,   true));
  const [drawerHeight, setDrawerHeight] = useState(() => readJSON(UI_DRAWER_HEIGHT_KEY, 340));
  const [drawerTab, setDrawerTab]     = useState(() => readJSON(UI_DRAWER_TAB_KEY, 'config'));
  const [configSubtab, setConfigSubtab] = useState(() => readJSON(UI_CONFIG_SUBTAB_KEY, 'dietpi'));

  // ── persistence side-effects ────────────────────────────────────
  useEffect(() => { saveManifests(manifests); }, [manifests]);
  useEffect(() => { if (activeId) saveActiveId(activeId); }, [activeId]);
  useEffect(() => { writeJSON(UI_NAV_KEY, nav); },                 [nav]);
  useEffect(() => { writeJSON(UI_LAYERS_KEY, openLayers); },        [openLayers]);
  useEffect(() => { writeJSON(UI_DRAWER_OPEN_KEY, drawerOpen); },   [drawerOpen]);
  useEffect(() => { writeJSON(UI_SIDEBAR_OPEN_KEY, sidebarOpen); }, [sidebarOpen]);
  useEffect(() => { writeJSON(UI_RIGHT_OPEN_KEY,   rightOpen); },   [rightOpen]);
  useEffect(() => { writeJSON(UI_DRAWER_HEIGHT_KEY, drawerHeight); }, [drawerHeight]);
  useEffect(() => { writeJSON(UI_DRAWER_TAB_KEY, drawerTab); },     [drawerTab]);
  useEffect(() => { writeJSON(UI_CONFIG_SUBTAB_KEY, configSubtab); }, [configSubtab]);

  // ── seed on first run ───────────────────────────────────────────
  useEffect(() => {
    if (Object.keys(manifests).length === 0) {
      const id = uid();
      setManifestsState({ [id]: emptyManifest('ark-kiosk-01') });
      setActiveIdState(id);
    } else if (!activeId || !manifests[activeId]) {
      setActiveIdState(Object.keys(manifests)[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── derived ─────────────────────────────────────────────────────
  const active   = activeId ? manifests[activeId] : null;
  const warnings = useMemo(() => active ? validateManifest(active) : [], [active]);
  const risks    = useMemo(() => active ? hardwareRisks(active)    : [], [active]);
  const score    = useMemo(() => compatibilityScore(warnings), [warnings]);
  const dietpi   = useMemo(() => active ? dietpiTxt(active)         : '', [active]);
  const script   = useMemo(() => active ? automationScript(active)  : '', [active]);
  const plan     = useMemo(() => active ? buildPlan(active)         : null, [active]);
  const planText = useMemo(() => plan ? buildPlanJson(plan)         : '', [plan]);

  const hasErrors = warnings.some(w => w.severity === 'error');
  const buildStatus = !active
    ? { label: 'No manifest selected', tone: 'muted' }
    : hasErrors
      ? { label: 'Validation failures — fix before building', tone: 'error' }
      : { label: 'Ready to generate config', tone: 'success' };

  // ── manifest mutators ───────────────────────────────────────────
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
    setManifestsState(prev => ({ ...prev, [id]: emptyManifest(`ark-device-${String(n).padStart(2, '0')}`) }));
    setActiveIdState(id);
    setNav('devices');
  }
  function cloneActive() {
    if (!active) return;
    const id = uid();
    setManifestsState(prev => ({ ...prev, [id]: cloneManifest(active, `${active.identity.name}-clone`) }));
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

  // ── downloads ───────────────────────────────────────────────────
  function downloadConfigBundle() {
    if (!active) return;
    downloadBlob('dietpi.txt', dietpi);
    setTimeout(() => downloadBlob('Automation_Custom_Script.sh', script, 'text/x-shellscript'), 200);
    setTimeout(() => downloadBlob(`${active.identity.name}.build-plan.json`, planText, 'application/json'), 400);
  }
  function downloadOne(name, content, mime) { return () => downloadBlob(name, content, mime); }
  function downloadManifestJson() {
    if (!active) return;
    downloadBlob(`${active.identity.name}.manifest.json`, JSON.stringify(active, null, 2), 'application/json');
  }
  function downloadBuildPlanOnly() {
    if (!active) return;
    downloadBlob(`${active.identity.name}.build-plan.json`, planText, 'application/json');
  }

  // ── layer expand/collapse ───────────────────────────────────────
  function toggleLayer(id) {
    setOpenLayers(prev => ({ ...prev, [id]: !prev[id] }));
  }
  function expandAll() {
    const next = {};
    for (const L of LAYERS) next[L.id] = true;
    setOpenLayers(next);
  }
  function collapseAll() { setOpenLayers({}); }

  // ── drawer drag handle ──────────────────────────────────────────
  const dragRef = useRef({ active: false, startY: 0, startH: 0 });
  function onDrawerHandleDown(e) {
    dragRef.current = { active: true, startY: e.clientY, startH: drawerHeight };
    window.addEventListener('mousemove', onDrawerHandleMove);
    window.addEventListener('mouseup',   onDrawerHandleUp);
    e.preventDefault();
  }
  function onDrawerHandleMove(e) {
    if (!dragRef.current.active) return;
    const delta = dragRef.current.startY - e.clientY; // drag up → grow
    const next = Math.max(140, Math.min(720, dragRef.current.startH + delta));
    setDrawerHeight(next);
  }
  function onDrawerHandleUp() {
    dragRef.current.active = false;
    window.removeEventListener('mousemove', onDrawerHandleMove);
    window.removeEventListener('mouseup',   onDrawerHandleUp);
  }

  // ── layout ──────────────────────────────────────────────────────
  const drawerEffective = drawerOpen ? drawerHeight : 44;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      gridTemplateRows: `1fr ${drawerEffective}px`,
      background: COLORS.bgPrimary,
      color: COLORS.textPrimary,
      fontFamily: FONT_BODY,
    }}>
      {/* ── TOP REGION: nav | centre | validation ─────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `${sidebarOpen ? '220px' : '32px'} minmax(0, 1fr) ${rightOpen ? '320px' : '32px'}`,
        minHeight: 0,
        borderBottom: `1px solid ${COLORS.border}`,
        transition: 'grid-template-columns 180ms ease',
      }}>
        {sidebarOpen
          ? <Sidebar nav={nav} setNav={setNav} count={Object.keys(manifests).length} onCollapse={() => setSidebarOpen(false)}/>
          : <CollapsedRail side="left" onExpand={() => setSidebarOpen(true)} label="Open nav"/>}

        <CentreWorkspace
          nav={nav} setNav={setNav}
          manifests={manifests} activeId={activeId} setActiveId={setActiveIdState}
          active={active}
          openLayers={openLayers} toggleLayer={toggleLayer}
          expandAll={expandAll} collapseAll={collapseAll}
          update={update} setRole={setRole}
          newManifest={newManifest} cloneActive={cloneActive} deleteActive={deleteActive}
          downloadManifestJson={downloadManifestJson}
        />

        {rightOpen
          ? <ValidationPanel
              active={active} warnings={warnings} risks={risks} score={score} buildStatus={buildStatus}
              onCollapse={() => setRightOpen(false)}
            />
          : <CollapsedRail side="right" onExpand={() => setRightOpen(true)} label="Open validation panel"/>}
      </div>

      {/* ── BOTTOM DRAWER ────────────────────────────────────────────── */}
      <BuildOutputDrawer
        open={drawerOpen} setOpen={setDrawerOpen}
        onHandleDown={onDrawerHandleDown}
        tab={drawerTab} setTab={setDrawerTab}
        configSubtab={configSubtab} setConfigSubtab={setConfigSubtab}
        active={active}
        dietpi={dietpi} script={script} planText={planText}
        onDownloadOne={downloadOne}
        onDownloadBundle={downloadConfigBundle}
        onDownloadBuildPlan={downloadBuildPlanOnly}
        onDownloadManifest={downloadManifestJson}
        onCloneActive={cloneActive}
        onDeleteActive={deleteActive}
      />
    </div>
  );
}


// =====================================================================
//  Sidebar
// =====================================================================
function Sidebar({ nav, setNav, count, onCollapse }) {
  return (
    <aside style={{
      borderRight: `1px solid ${COLORS.border}`,
      padding: '18px 12px',
      display: 'flex', flexDirection: 'column', gap: 4,
      background: '#070707',
      overflowY: 'auto',
      position: 'relative',
    }}>
      <div style={{ padding: '4px 8px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          fontFamily: FONT_HEADING,
          fontStyle: 'italic',
          fontSize: '1.9rem',
          lineHeight: 1,
          background: `linear-gradient(135deg, ${COLORS.accentBright} 0%, ${COLORS.accent} 60%, ${COLORS.textPrimary} 100%)`,
          WebkitBackgroundClip: 'text', backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          Ark
        </div>
        {onCollapse && (
          <button
            onClick={onCollapse}
            title="Collapse navigation"
            aria-label="Collapse navigation"
            style={paneToggleBtn()}
          >
            <ChevronLeft size={14}/>
          </button>
        )}
      </div>

      {NAV_SECTIONS.map(s => {
        const isActive = nav === s.id;
        const Icon = s.icon;
        const badge = s.id === 'manifests' ? count : null;
        return (
          <button key={s.id} onClick={() => setNav(s.id)} style={navBtn(isActive)}>
            <Icon size={15} style={{ flexShrink: 0 }}/>
            <span style={{ flex: 1, textAlign: 'left' }}>{s.label}</span>
            {badge != null && (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: isActive ? 'rgba(0,0,0,0.4)' : COLORS.bgActive,
                color: isActive ? COLORS.accent : COLORS.textMuted,
                fontWeight: 700, letterSpacing: '0.04em',
              }}>{badge}</span>
            )}
          </button>
        );
      })}

      <div style={{ flex: 1 }}/>
    </aside>
  );
}

function paneToggleBtn() {
  return {
    width: 24, height: 24,
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    color: COLORS.textMuted,
    borderRadius: 4,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
  };
}

// Tiny vertical rail shown when a pane is collapsed. One chevron
// button expands it back. 32px wide; matches the grid template.
function CollapsedRail({ side, onExpand, label }) {
  const ChevIcon = side === 'left' ? ChevronRight : ChevronLeft;
  return (
    <aside style={{
      borderRight: side === 'left' ? `1px solid ${COLORS.border}` : 'none',
      borderLeft:  side === 'right' ? `1px solid ${COLORS.border}` : 'none',
      background: '#070707',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '16px 0',
    }}>
      <button
        onClick={onExpand}
        title={label}
        aria-label={label}
        style={{
          width: 24, height: 24,
          background: 'transparent',
          border: `1px solid ${COLORS.border}`,
          color: COLORS.textMuted,
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
        }}
      >
        <ChevIcon size={14}/>
      </button>
    </aside>
  );
}

function navBtn(active) {
  return {
    padding: '9px 10px',
    background: active ? COLORS.bgActive : 'transparent',
    color: active ? COLORS.accent : COLORS.textSecondary,
    border: `1px solid ${active ? COLORS.accentBorder : 'transparent'}`,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: FONT_BODY,
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };
}

// =====================================================================
//  Centre workspace — switches on nav section
// =====================================================================
function CentreWorkspace(props) {
  const { nav } = props;
  return (
    <main style={{
      overflowY: 'auto',
      minWidth: 0,
      padding: '20px clamp(16px, 2vw, 28px) 28px',
    }}>
      {nav === 'devices'   && <DevicesView   {...props}/>}
      {nav === 'manifests' && <ManifestsView {...props}/>}
      {nav === 'network'   && <NetworkLandscape/>}
      {nav === 'fleet'     && <Fleet/>}
      {nav === 'presets'   && <Presets/>}
      {nav === 'builds'    && <Builds/>}
      {nav === 'images'    && <Images/>}
      {nav === 'logs'      && <Logs/>}
      {nav === 'flash'     && <FlashNodes/>}
      {!['devices','manifests','network','fleet','presets','builds','images','logs','flash'].includes(nav) && <StubView nav={nav}/>}
    </main>
  );
}

function StubView({ nav }) {
  const section = NAV_SECTIONS.find(s => s.id === nav);
  const Icon = section?.icon || Boxes;
  return (
    <div style={{
      padding: 60, textAlign: 'center', color: COLORS.textMuted,
      border: `1px dashed ${COLORS.border}`, borderRadius: 12,
      margin: '40px auto', maxWidth: 520,
    }}>
      <Icon size={36} style={{ opacity: 0.55, marginBottom: 14 }}/>
      <h2 style={{ ...workspaceHeading(), justifyContent: 'center', margin: '0 0 8px' }}>
        {section?.label}
      </h2>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{section?.stubText}</div>
    </div>
  );
}

function workspaceHeading() {
  return {
    fontFamily: FONT_HEADING,
    fontSize: '1.4rem',
    fontWeight: 600,
    color: COLORS.textPrimary,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    margin: 0,
  };
}

// =====================================================================
//  Manifests view — list of saved manifests (the old "Library")
// =====================================================================
function ManifestsView({ manifests, activeId, setActiveId, setNav, newManifest, deleteActive, downloadManifestJson, cloneActive }) {
  const entries = Object.entries(manifests);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={workspaceHeading()}><Layers size={20}/> Manifests</h2>
          <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 4 }}>
            {entries.length} saved {entries.length === 1 ? 'manifest' : 'manifests'} · stored locally
          </div>
        </div>
        <button onClick={newManifest} style={btnPrimary()}><Plus size={14}/> New device</button>
      </div>

      {entries.length === 0 && (
        <div style={emptyCard()}>No manifests yet. Click <strong>New device</strong> to create one.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {entries.map(([id, m]) => {
          const isActive = id === activeId;
          return (
            <div key={id} style={manifestCard(isActive)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: COLORS.textPrimary }}>{m.identity.name}</div>
                  <div style={{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 3 }}>
                    {labelForRole(m.identity.role)} · {labelForModel(m.hardware.model)}
                  </div>
                </div>
                {isActive && (
                  <span style={{
                    fontSize: 9, padding: '2px 6px', borderRadius: 4,
                    background: COLORS.bgActive, color: COLORS.accent,
                    fontWeight: 700, letterSpacing: '0.08em',
                  }}>ACTIVE</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 8, lineHeight: 1.5 }}>
                {m.network.hostname || '—'} · {labelForDisplay(m.hardware.display)}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={() => { setActiveId(id); setNav('devices'); }} style={btnGhost()}>
                  {isActive ? 'Edit' : 'Open'}
                </button>
                {isActive && <button onClick={cloneActive}            style={btnGhost()}><CopyIcon size={12}/> Clone</button>}
                {isActive && <button onClick={downloadManifestJson}   style={btnGhost()}><Save size={12}/> Export</button>}
                {isActive && (
                  <button onClick={deleteActive} style={{ ...btnGhost(), color: COLORS.error, borderColor: 'rgba(239,111,92,0.4)' }}>
                    <Trash2 size={12}/>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function emptyCard() {
  return {
    padding: 24, textAlign: 'center', color: COLORS.textMuted,
    border: `1px dashed ${COLORS.border}`, borderRadius: 10, fontSize: 13,
  };
}
function manifestCard(active) {
  return {
    padding: 14,
    background: COLORS.bgCard,
    border: `1px solid ${active ? COLORS.accentBorder : COLORS.border}`,
    borderLeft: `4px solid ${active ? COLORS.accent : 'transparent'}`,
    borderRadius: 10,
    transition: 'border-color 0.15s',
  };
}

// =====================================================================
//  Devices view — device picker + the collapsible layer stack
// =====================================================================
function DevicesView(props) {
  const {
    manifests, activeId, setActiveId, active,
    openLayers, toggleLayer, expandAll, collapseAll,
    update, setRole, newManifest, cloneActive, deleteActive,
  } = props;

  const entries = Object.entries(manifests);

  if (!active) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: COLORS.textMuted }}>
        <p>No manifest selected.</p>
        <button onClick={newManifest} style={{ ...btnPrimary(), marginTop: 10 }}><Plus size={14}/> Create one</button>
      </div>
    );
  }

  return (
    <div>
      {/* ── Header: name + role + device picker ─────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h2 style={workspaceHeading()}>
            <Cpu size={20} style={{ color: COLORS.accent }}/>
            {active.identity.name}
          </h2>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {labelForRole(active.identity.role)} · {labelForModel(active.hardware.model)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={newManifest}   style={btnGhost()}><Plus size={13}/> New</button>
          <button onClick={cloneActive}   style={btnGhost()}><CopyIcon size={13}/> Clone</button>
          <button onClick={deleteActive}  style={{ ...btnGhost(), color: COLORS.error, borderColor: 'rgba(239,111,92,0.4)' }}><Trash2 size={13}/></button>
        </div>
      </div>

      {/* Device tabs — quick switch between manifests */}
      {entries.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto', paddingBottom: 6, borderBottom: `1px solid ${COLORS.border}` }}>
          {entries.map(([id, m]) => (
            <button key={id} onClick={() => setActiveId(id)} style={deviceTab(id === activeId)}>
              {m.identity.name}
            </button>
          ))}
        </div>
      )}

      {/* Expand / collapse all */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10, fontSize: 11, color: COLORS.textMuted }}>
        <button onClick={expandAll}   style={textLink()}>Expand all</button>
        <span style={{ opacity: 0.4 }}>·</span>
        <button onClick={collapseAll} style={textLink()}>Collapse all</button>
      </div>

      {/* ── The Stack — collapsible layer cards ───────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {LAYERS.filter(L => L.visible(active)).map(L => (
          <LayerCard
            key={L.id}
            layer={L}
            open={!!openLayers[L.id]}
            onToggle={() => toggleLayer(L.id)}
            active={active}
            update={update}
            setRole={setRole}
          />
        ))}
      </div>
    </div>
  );
}

function deviceTab(active) {
  return {
    padding: '6px 12px',
    background: active ? COLORS.bgActive : 'transparent',
    color: active ? COLORS.accent : COLORS.textMuted,
    border: 0,
    borderBottom: `2px solid ${active ? COLORS.accent : 'transparent'}`,
    cursor: 'pointer',
    fontSize: 12, fontWeight: active ? 600 : 500,
    fontFamily: FONT_BODY,
    whiteSpace: 'nowrap',
  };
}
function textLink() {
  return {
    background: 'transparent', border: 0, color: COLORS.textSecondary,
    cursor: 'pointer', fontSize: 11, fontFamily: FONT_BODY,
    textDecoration: 'underline', textDecorationColor: COLORS.border,
    textUnderlineOffset: 3, padding: 0,
  };
}

// =====================================================================
//  Layer card — the building block of the device stack
// =====================================================================
function LayerCard({ layer, open, onToggle, active, update, setRole }) {
  const Icon = layer.icon;
  const summary = layer.summary(active);
  const BodyComp = layer.body;
  return (
    <div style={{
      background: COLORS.bgCard,
      border: `1px solid ${open ? COLORS.accentBorder : COLORS.border}`,
      borderLeft: `4px solid ${open ? COLORS.accent : COLORS.accentDeep}`,
      borderRadius: 10,
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <button onClick={onToggle} style={{
        width: '100%', padding: '12px 14px',
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'transparent', border: 0, cursor: 'pointer',
        color: COLORS.textPrimary, textAlign: 'left',
      }}>
        <Icon size={17} style={{ color: open ? COLORS.accent : COLORS.textSecondary, flexShrink: 0 }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_HEADING, fontSize: '1.05rem', fontWeight: 600 }}>
            {layer.title}
          </div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {summary}
          </div>
        </div>
        {open ? <ChevronDown size={17} style={{ color: COLORS.textMuted }}/> : <ChevronRight size={17} style={{ color: COLORS.textMuted }}/>}
      </button>

      <CollapsibleBody open={open}>
        <div style={{ padding: '6px 16px 18px', borderTop: `1px solid ${COLORS.border}` }}>
          <BodyComp active={active} update={update} setRole={setRole}/>
        </div>
      </CollapsibleBody>
    </div>
  );
}

// Animated height transition.
function CollapsibleBody({ open, children }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(open ? 'auto' : 0);
  useEffect(() => {
    if (!ref.current) return;
    if (open) {
      const h = ref.current.scrollHeight;
      setHeight(h);
      // After transition completes, switch to "auto" so resize works.
      const t = setTimeout(() => setHeight('auto'), 220);
      return () => clearTimeout(t);
    } else {
      // From auto → fixed → 0 in two ticks so the transition fires.
      if (ref.current.scrollHeight) setHeight(ref.current.scrollHeight);
      requestAnimationFrame(() => setHeight(0));
    }
  }, [open]);
  return (
    <div ref={ref} style={{
      height: typeof height === 'number' ? `${height}px` : height,
      overflow: 'hidden',
      transition: 'height 0.2s ease',
    }}>
      {children}
    </div>
  );
}


// =====================================================================
//  Layer bodies
// =====================================================================
function IdentityBody({ active, update, setRole }) {
  return (
    <Stack>
      <Row label="Name (slug)" hint="lowercase, digits, underscore, hyphen — used as hostname default">
        <input type="text" value={active.identity.name}
          onChange={(e) => { update('identity.name', e.target.value); update('network.hostname', e.target.value); }}
          style={inputStyle()}/>
      </Row>
      <Row label="Role">
        <select value={active.identity.role} onChange={(e) => setRole(e.target.value)} style={inputStyle()}>
          {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <div style={hintStyle()}>{ROLES.find(r => r.id === active.identity.role)?.desc}</div>
      </Row>
      <Row label="Manifest version">
        <input type="number" value={active.identity.version || 1} min={1}
          onChange={(e) => update('identity.version', Math.max(1, Number(e.target.value) || 1))}
          style={{ ...inputStyle(), maxWidth: 120 }}/>
        <div style={hintStyle()}>Bumps every time the device is reflashed from this manifest.</div>
      </Row>
    </Stack>
  );
}

function HardwareBody({ active, update }) {
  return (
    <Stack>
      <Row label="Pi model">
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
      <Row label="HATs / peripherals">
        <Check checked={active.hardware.pisugar}  onChange={(v) => update('hardware.pisugar', v)}  label="PiSugar battery / UPS HAT"/>
        <Check checked={active.hardware.ethernet} onChange={(v) => update('hardware.ethernet', v)} label="Ethernet HAT (USB-OTG dongle counts)"/>
      </Row>
      <Row label="GPIO pins reserved (comma-separated)">
        <input type="text"
          value={(active.hardware.gpio || []).join(', ')}
          onChange={(e) => update('hardware.gpio', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          placeholder="e.g. 17, 18, 27"
          style={inputStyle()}/>
        <div style={hintStyle()}>Reference only — used by Phase 2 to wire OS-level services.</div>
      </Row>
      <Row label="Power notes (optional)">
        <input type="text" value={active.hardware.power_note}
          onChange={(e) => update('hardware.power_note', e.target.value)}
          style={inputStyle()}
          placeholder="e.g. car USB-C 5V/3A · mains 5V/2.4A · battery only"/>
      </Row>
    </Stack>
  );
}

function NetworkBody({ active, update }) {
  return (
    <Stack>
      <Row label="Hostname">
        <input type="text" value={active.network.hostname}
          onChange={(e) => update('network.hostname', e.target.value)} style={inputStyle()}/>
      </Row>
      <Row label="WiFi SSID (blank = ethernet only)">
        <input type="text" value={active.network.wifi_ssid}
          onChange={(e) => update('network.wifi_ssid', e.target.value)} style={inputStyle()}/>
      </Row>
      <Row label="WiFi password">
        <input type="password" value={active.network.wifi_password}
          onChange={(e) => update('network.wifi_password', e.target.value)} style={inputStyle()}/>
      </Row>
      <Row label="WiFi security">
        <select value={active.network.wifi_security || 'wpa2'}
          onChange={(e) => update('network.wifi_security', e.target.value)} style={inputStyle()}>
          <option value="wpa2">WPA2 / WPA3</option>
          <option value="wpa">WPA (legacy)</option>
          <option value="open">Open (no password)</option>
        </select>
      </Row>
      <Row label="IP configuration">
        <select value={active.network.static_ip ? 'static' : 'dhcp'}
          onChange={(e) => update('network.static_ip', e.target.value === 'static' ? '' : null)}
          style={inputStyle()}>
          <option value="dhcp">DHCP (automatic)</option>
          <option value="static">Static IP</option>
        </select>
        {active.network.static_ip != null && (
          <input type="text"
            value={active.network.static_ip}
            placeholder="e.g. 192.168.1.42/24"
            onChange={(e) => update('network.static_ip', e.target.value)}
            style={inputStyle()}/>
        )}
      </Row>
      <Row label="Services">
        <Check checked={active.network.ssh_enabled} onChange={(v) => update('network.ssh_enabled', v)} label="Enable SSH"/>
        <Check checked={active.network.mdns}        onChange={(v) => update('network.mdns', v)}        label="mDNS (.local resolution)"/>
      </Row>
      <Row label="SSH public keys (one per line, authorized_keys format)">
        <textarea
          value={(active.network.ssh_pubkeys || []).join('\n')}
          onChange={(e) => update('network.ssh_pubkeys', e.target.value.split('\n').filter(Boolean))}
          style={{ ...inputStyle(), minHeight: 90, fontFamily: FONT_MONO, fontSize: 11 }}
          placeholder="ssh-ed25519 AAAA... user@host"/>
      </Row>
    </Stack>
  );
}

function OsBody({ active, update }) {
  const packages = active.software.packages || [];
  return (
    <Stack>
      <Row label="Operating system">
        <select value={active.software.os || 'dietpi'} disabled style={inputStyle()}>
          <option value="dietpi">DietPi (Trixie · ARMv8)</option>
        </select>
        <div style={hintStyle()}>DietPi is the only supported OS in Phase 1. Raspberry Pi OS and Armbian are Phase 3.</div>
      </Row>
      <Row label="Timezone">
        <select value={active.software.timezone} onChange={(e) => update('software.timezone', e.target.value)} style={inputStyle()}>
          {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
        </select>
      </Row>
      <Row label="Boot target">
        <select value={active.software.boot_target} onChange={(e) => update('software.boot_target', e.target.value)} style={inputStyle()}>
          <option value="kiosk">Kiosk (Chromium auto-launch)</option>
          <option value="desktop">Desktop (LXDE login)</option>
          <option value="headless">Headless (CLI only)</option>
        </select>
      </Row>
      <Row label="Packages (auto from role)">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minHeight: 28 }}>
          {packages.length === 0 && <span style={{ fontSize: 12, color: COLORS.textMuted, fontStyle: 'italic' }}>none (headless)</span>}
          {packages.map(p => <span key={p} style={pkgChip()}>{p}</span>)}
        </div>
        <div style={hintStyle()}>Set automatically when you change the device role. Editable in Phase 2.</div>
      </Row>
      <Row label="Services (derived)">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {active.network.ssh_enabled && <span style={pkgChip()}>ssh</span>}
          {active.network.mdns        && <span style={pkgChip()}>avahi-daemon</span>}
          {active.hardware.pisugar    && <span style={pkgChip()}>pisugar-server</span>}
          {active.behaviour.watchdog  && <span style={pkgChip()}>watchdog</span>}
          {!active.network.ssh_enabled && !active.network.mdns && !active.hardware.pisugar && !active.behaviour.watchdog && (
            <span style={{ fontSize: 12, color: COLORS.textMuted, fontStyle: 'italic' }}>none enabled</span>
          )}
        </div>
      </Row>
      <Row label="Root password (used for SSH if pubkeys aren't set)">
        <input type="password" value={active.software.root_password}
          onChange={(e) => update('software.root_password', e.target.value)} style={inputStyle()}/>
        <div style={hintStyle()}>Change this from the default before flashing a real device.</div>
      </Row>
    </Stack>
  );
}

function BehaviourBody({ active, update }) {
  return (
    <Stack>
      <Row label="Watchdog (Phase 2)">
        <Check checked={active.behaviour.watchdog} onChange={(v) => update('behaviour.watchdog', v)}
          label="Auto-restart Chromium / kiosk on crash (stub — not wired yet)"/>
      </Row>
      <Row label="Auto-reboot schedule (cron, Phase 2)">
        <input type="text" value={active.behaviour.auto_reboot_schedule || ''}
          onChange={(e) => update('behaviour.auto_reboot_schedule', e.target.value || null)}
          placeholder="e.g. 0 4 * * * (daily 04:00)" style={inputStyle()}/>
        <div style={hintStyle()}>Leave blank for never. Standard cron syntax.</div>
      </Row>
      <Row label="Offline fallback (Phase 2)">
        <Check checked={active.behaviour.offline_fallback}
          onChange={(v) => update('behaviour.offline_fallback', v)}
          label="Show a local HTML page when the network is down (stub)"/>
      </Row>
      <Row label="Recovery rules (Phase 2)">
        <textarea
          value={(active.behaviour.recovery_rules || []).join('\n')}
          onChange={(e) => update('behaviour.recovery_rules', e.target.value.split('\n').filter(Boolean))}
          placeholder={"# one rule per line, e.g.\nif chromium crashes 3x in 5min reboot"}
          style={{ ...inputStyle(), minHeight: 70, fontFamily: FONT_MONO, fontSize: 11 }}/>
        <div style={hintStyle()}>Parsed by the recovery engine in Phase 2. Currently just stored.</div>
      </Row>
    </Stack>
  );
}

function KioskBody({ active, update }) {
  return (
    <Stack>
      <Row label="Target URL">
        <input type="url" value={active.kiosk.url}
          onChange={(e) => update('kiosk.url', e.target.value)}
          placeholder="https://sinsera.co"
          style={inputStyle()}/>
      </Row>
      <Row label="Display">
        <Check checked={!!active.kiosk.fullscreen}
          onChange={(v) => update('kiosk.fullscreen', v)} label="Fullscreen / kiosk-mode Chromium"/>
        <select value={active.kiosk.rotation} onChange={(e) => update('kiosk.rotation', e.target.value)} style={inputStyle()}>
          <option value="normal">No rotation (landscape)</option>
          <option value="left">90° left (portrait)</option>
          <option value="right">90° right (portrait)</option>
          <option value="inverted">180° inverted</option>
        </select>
      </Row>
      <Row label="Auto-reload (minutes; 0 = off)">
        <input type="number" min={0} max={1440} value={active.kiosk.auto_reload_min}
          onChange={(e) => update('kiosk.auto_reload_min', Number(e.target.value))}
          style={{ ...inputStyle(), maxWidth: 140 }}/>
      </Row>
      <Row label="Behaviour">
        <Check checked={active.kiosk.hide_cursor}      onChange={(v) => update('kiosk.hide_cursor', v)}      label="Hide mouse cursor when idle"/>
        <Check checked={active.kiosk.disable_blanking} onChange={(v) => update('kiosk.disable_blanking', v)} label="Disable screen blanking + DPMS"/>
      </Row>
      <Row label="Fallback URL (offline) — Phase 2">
        <input type="url"
          value={active.kiosk.fallback_html || ''}
          onChange={(e) => update('kiosk.fallback_html', e.target.value || null)}
          placeholder="e.g. file:///var/lib/ark/offline.html"
          style={inputStyle()}/>
      </Row>
    </Stack>
  );
}


// =====================================================================
//  Validation panel
// =====================================================================
function ValidationPanel({ active, warnings, risks, score, buildStatus, onCollapse }) {
  const CollapseBtn = onCollapse ? (
    <button
      onClick={onCollapse}
      title="Collapse validation panel"
      aria-label="Collapse validation panel"
      style={{
        position: 'absolute', top: 14, right: 14,
        ...paneToggleBtn(),
      }}
    >
      <ChevronRight size={14}/>
    </button>
  ) : null;

  if (!active) {
    return (
      <aside style={{ ...panelStyle(), position: 'relative' }}>
        {CollapseBtn}
        <div style={{ color: COLORS.textMuted, fontSize: 13, padding: 20, textAlign: 'center' }}>
          No manifest selected.
        </div>
      </aside>
    );
  }
  const errors   = warnings.filter(w => w.severity === 'error');
  const warns    = warnings.filter(w => w.severity === 'warn');
  const infos    = warnings.filter(w => w.severity === 'info');
  const scoreCol = scoreColor(score);

  return (
    <aside style={{ ...panelStyle(), position: 'relative' }}>
      {CollapseBtn}
      {/* ── Compatibility score ──────────────────────────────────── */}
      <div style={{ padding: '18px 18px 14px', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={panelLabel()}>Compatibility</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
          <div style={{
            fontFamily: FONT_HEADING,
            fontSize: '3.4rem',
            lineHeight: 1,
            fontWeight: 600,
            color: scoreCol,
          }}>{score}</div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, letterSpacing: '0.1em', textTransform: 'uppercase' }}>/ 100</div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: COLORS.textMuted }}>
          <span><strong style={{ color: COLORS.error }}>{errors.length}</strong> err</span>
          <span>·</span>
          <span><strong style={{ color: COLORS.warning }}>{warns.length}</strong> warn</span>
          <span>·</span>
          <span><strong style={{ color: COLORS.info }}>{infos.length}</strong> info</span>
        </div>
      </div>

      {/* ── Validation messages ──────────────────────────────────── */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={panelLabel()}><Gauge size={11}/> Validation</div>
        {warnings.length === 0 ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12, color: COLORS.success }}>
            <CheckIcon size={14}/> All checks passing.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {warnings.map((w, i) => <ValidationLine key={i} w={w}/>)}
          </div>
        )}
      </div>

      {/* ── Hardware risk ────────────────────────────────────────── */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={panelLabel()}><Zap size={11}/> Hardware risk</div>
        {risks.length === 0 ? (
          <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textMuted }}>No advisories for the current hardware combination.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {risks.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: COLORS.textSecondary, alignItems: 'flex-start' }}>
                <Zap size={12} style={{
                  color: r.severity === 'warn' ? COLORS.warning : COLORS.info,
                  marginTop: 2, flexShrink: 0,
                }}/>
                <div>
                  <div>{r.text}</div>
                  {r.amps && (
                    <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2, fontFamily: FONT_MONO }}>
                      est. peak ~{r.amps} A
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Build status ─────────────────────────────────────────── */}
      <div style={{ padding: '14px 18px' }}>
        <div style={panelLabel()}><Power size={11}/> Build status</div>
        <BuildStatusPill status={buildStatus}/>
      </div>
    </aside>
  );
}

function ValidationLine({ w }) {
  const sev = w.severity || 'info';
  const color = sev === 'error' ? COLORS.error : sev === 'warn' ? COLORS.warning : COLORS.info;
  const Icon  = sev === 'error' ? XIcon       : sev === 'warn' ? AlertTriangle : Info;
  const glyph = sev === 'error' ? '✖' : sev === 'warn' ? '⚠' : 'ℹ';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: COLORS.textSecondary }}>
      <span aria-hidden style={{
        width: 16, height: 16, borderRadius: 4,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.3)', color, fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1,
      }}>{glyph}</span>
      <span style={{ lineHeight: 1.45 }}>{w.text}</span>
    </div>
  );
}

function BuildStatusPill({ status }) {
  const color = status.tone === 'error' ? COLORS.error : status.tone === 'success' ? COLORS.success : COLORS.textMuted;
  return (
    <div style={{
      marginTop: 8,
      padding: '8px 10px',
      border: `1px solid ${color}55`,
      borderRadius: 6,
      background: 'rgba(0,0,0,0.3)',
      color, fontSize: 12, fontWeight: 600,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}/>
      {status.label}
    </div>
  );
}

function panelStyle() {
  return {
    borderLeft: `1px solid ${COLORS.border}`,
    background: '#070707',
    overflowY: 'auto',
    minHeight: 0,
  };
}
function panelLabel() {
  return {
    fontSize: 10, color: COLORS.textMuted,
    textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700,
    display: 'flex', alignItems: 'center', gap: 6,
  };
}

// =====================================================================
//  Build output drawer
// =====================================================================
function BuildOutputDrawer(props) {
  const {
    open, setOpen, onHandleDown,
    tab, setTab, configSubtab, setConfigSubtab,
    active, dietpi, script, planText,
    onDownloadOne, onDownloadBundle, onDownloadBuildPlan, onDownloadManifest,
    onCloneActive, onDeleteActive,
  } = props;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: '#050505', borderTop: `1px solid ${COLORS.border}`,
      minHeight: 0,
    }}>
      {/* Drag handle / header */}
      <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
        <div
          onMouseDown={open ? onHandleDown : undefined}
          style={{
            position: 'absolute', left: 0, right: 0, top: -3, height: 6,
            cursor: open ? 'ns-resize' : 'default',
            zIndex: 2,
          }}
        />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px 0' }}>
          <button onClick={() => setOpen(!open)} style={drawerToggleBtn()}>
            {open ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}
            <span style={{ marginLeft: 4 }}>Build output</span>
          </button>
          {open && (
            <div style={{ display: 'flex', gap: 2, marginLeft: 14 }}>
              <DrawerTab id="config"   label="CONFIG"   icon={FileText} active={tab} setActive={setTab}/>
              <DrawerTab id="image"    label="IMAGE"    icon={HardDrive} active={tab} setActive={setTab}/>
              <DrawerTab id="manifest" label="MANIFEST" icon={FileJson}  active={tab} setActive={setTab}/>
            </div>
          )}
          <div style={{ flex: 1 }}/>
          {open && active && tab === 'config' && (
            <button onClick={onDownloadBundle} style={{ ...btnPrimary(), padding: '6px 12px', fontSize: 12 }}>
              <Download size={13}/> Download bundle
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {open && (
        <div style={{ flex: 1, minHeight: 0, padding: '8px 14px 14px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!active && <div style={emptyCard()}>Select a manifest to see the build output.</div>}
          {active && tab === 'config'   && (
            <ConfigTab
              dietpi={dietpi} script={script} planText={planText}
              subtab={configSubtab} setSubtab={setConfigSubtab}
              onDownloadOne={onDownloadOne}
              activeName={active.identity.name}
            />
          )}
          {active && tab === 'image'    && <ImageTab onDownloadBuildPlan={onDownloadBuildPlan} activeName={active.identity.name}/>}
          {active && tab === 'manifest' && (
            <ManifestTab
              active={active}
              onDownloadManifest={onDownloadManifest}
              onCloneActive={onCloneActive}
              onDeleteActive={onDeleteActive}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DrawerTab({ id, label, icon: Icon, active, setActive }) {
  const isActive = active === id;
  return (
    <button onClick={() => setActive(id)} style={{
      padding: '6px 12px',
      background: isActive ? COLORS.bgActive : 'transparent',
      color: isActive ? COLORS.accent : COLORS.textMuted,
      border: 0,
      borderBottom: `2px solid ${isActive ? COLORS.accent : 'transparent'}`,
      cursor: 'pointer', fontSize: 11,
      letterSpacing: '0.12em', fontWeight: 700,
      fontFamily: FONT_BODY,
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <Icon size={12}/> {label}
    </button>
  );
}

function drawerToggleBtn() {
  return {
    padding: '4px 8px',
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    color: COLORS.textSecondary,
    cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
    fontFamily: FONT_BODY,
    display: 'inline-flex', alignItems: 'center',
  };
}

// ── CONFIG tab ───────────────────────────────────────────────────────
function ConfigTab({ dietpi, script, planText, subtab, setSubtab, onDownloadOne, activeName }) {
  const items = [
    { id: 'dietpi', label: 'dietpi.txt',                   filename: 'dietpi.txt',                          mime: 'text/plain;charset=utf-8',  body: dietpi,   icon: FileText },
    { id: 'script', label: 'Automation_Custom_Script.sh',  filename: 'Automation_Custom_Script.sh',         mime: 'text/x-shellscript',        body: script,   icon: Terminal },
    { id: 'plan',   label: 'build-plan.json',              filename: `${activeName}.build-plan.json`,       mime: 'application/json',          body: planText, icon: FileJson },
  ];
  const current = items.find(i => i.id === subtab) || items[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, borderBottom: `1px solid ${COLORS.border}` }}>
        {items.map(i => {
          const isActive = subtab === i.id;
          const Icon = i.icon;
          return (
            <button key={i.id} onClick={() => setSubtab(i.id)} style={{
              padding: '6px 10px',
              background: 'transparent',
              color: isActive ? COLORS.accent : COLORS.textMuted,
              border: 0,
              borderBottom: `2px solid ${isActive ? COLORS.accent : 'transparent'}`,
              cursor: 'pointer', fontSize: 11,
              fontFamily: FONT_BODY,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <Icon size={12}/> {i.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }}/>
        <button onClick={onDownloadOne(current.filename, current.body, current.mime)}
          style={{ ...btnGhost(), fontSize: 11, padding: '4px 9px', alignSelf: 'center', marginBottom: 4 }}>
          <Download size={12}/> {current.filename}
        </button>
      </div>

      <pre style={previewStyle()}>{current.body}</pre>
    </div>
  );
}

// ── IMAGE tab ────────────────────────────────────────────────────────
function ImageTab({ onDownloadBuildPlan, activeName }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 18 }}>
      <div style={{
        maxWidth: 560, padding: 24,
        background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
        borderLeft: `4px solid ${COLORS.accent}`, borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <HardDrive size={18} style={{ color: COLORS.accent }}/>
          <h3 style={{ ...workspaceHeading(), fontSize: '1.1rem', margin: 0 }}>Image builder · Phase 3</h3>
        </div>
        <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 14px' }}>
          The browser does not build SD-card images. It emits a
          <code style={inlineCode()}>build-plan.json</code> that the CLI
          (<code style={inlineCode()}>Ark/builder/</code> in this repo)
          consumes on a Linux machine — chroot, mount, install packages,
          and write the final <code style={inlineCode()}>.img.xz</code>.
        </p>
        <p style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6, margin: '0 0 14px' }}>
          For now: download the build plan and pipe it into the builder:
        </p>
        <pre style={{
          background: 'rgba(0,0,0,0.5)', border: `1px solid ${COLORS.border}`,
          padding: 10, borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          color: COLORS.textSecondary, fontFamily: FONT_MONO, overflow: 'auto',
        }}>
{`# on the Linux builder host
ark-builder --plan ${activeName}.build-plan.json --output ark-${activeName}.img.xz`}
        </pre>
        <button onClick={onDownloadBuildPlan} style={{ ...btnPrimary(), marginTop: 14, fontSize: 13 }}>
          <Download size={14}/> Download build-plan.json
        </button>
      </div>
    </div>
  );
}

function inlineCode() {
  return { background: 'rgba(0,0,0,0.45)', padding: '1px 5px', borderRadius: 3, fontFamily: FONT_MONO, fontSize: '0.88em' };
}

// ── MANIFEST tab ─────────────────────────────────────────────────────
function ManifestTab({ active, onDownloadManifest, onCloneActive, onDeleteActive }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={onDownloadManifest} style={btnGhost()}><Save size={12}/> Export JSON</button>
        <button onClick={onCloneActive}      style={btnGhost()}><CopyIcon size={12}/> Clone</button>
        <button onClick={onDeleteActive}     style={{ ...btnGhost(), color: COLORS.error, borderColor: 'rgba(239,111,92,0.4)' }}><Trash2 size={12}/> Delete</button>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: COLORS.textMuted, alignSelf: 'center' }}>
          Manifest schema v{active.schema_version} · stored locally
        </span>
      </div>
      <pre style={previewStyle()}>{JSON.stringify(active, null, 2)}</pre>
    </div>
  );
}


// =====================================================================
//  Shared building blocks
// =====================================================================
function Stack({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>;
}

function Row({ label, hint, children }) {
  return (
    <div>
      <div style={{
        fontSize: 10, color: COLORS.textMuted, letterSpacing: '0.08em',
        textTransform: 'uppercase', fontWeight: 700, marginBottom: 6,
      }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
      {hint && <div style={{ ...hintStyle(), marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Check({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: COLORS.textSecondary }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: COLORS.accent, width: 14, height: 14 }}/>
      {label}
    </label>
  );
}

// ── style helpers ──────────────────────────────────────────────────
function inputStyle() {
  return {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    background: 'rgba(10, 10, 10, 0.55)',
    color: COLORS.textPrimary,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    fontFamily: FONT_BODY,
    outline: 'none',
    boxSizing: 'border-box',
  };
}
function btnGhost() {
  return {
    padding: '6px 10px',
    fontSize: 12, cursor: 'pointer',
    background: 'transparent',
    color: COLORS.textSecondary,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
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
    borderRadius: 5,
    fontFamily: FONT_BODY,
    fontWeight: active ? 700 : 500,
  };
}
function pkgChip() {
  return {
    padding: '3px 8px', fontSize: 11,
    background: 'rgba(6,182,212,0.10)',
    color: COLORS.accent,
    border: `1px solid ${COLORS.accentBorder}`,
    borderRadius: 4,
    fontFamily: FONT_MONO,
    letterSpacing: '0.02em',
  };
}
function hintStyle() {
  return { fontSize: 11, color: COLORS.textMuted, lineHeight: 1.4 };
}
function previewStyle() {
  return {
    margin: 0,
    padding: 12,
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    background: 'rgba(0,0,0,0.5)',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.55,
    color: COLORS.textSecondary,
    fontFamily: FONT_MONO,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}
