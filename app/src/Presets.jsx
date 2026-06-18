// Phase 2 — Presets browser UI.
//
// Lets the operator browse the three preset axes (Hardware × Purpose
// × OS), pick a combination, and see what manifest defaults it would
// expand to. Read-only catalogue + a "preview" panel — actual apply
// happens on the device builder (separate hook-up).

import React, { useState, useMemo } from 'react';
import { Cpu, Activity, HardDrive } from 'lucide-react';
import { COLORS, FONT_HEADING, FONT_BODY, FONT_MONO } from './lib/theme.js';
import {
  HARDWARE_PRESETS, PURPOSE_PRESETS, OS_PRESETS,
  applyPresetStack, compatiblePurposes, compatibleOses,
} from './presets.js';

export default function Presets() {
  const [hardware, setHardware] = useState('pi-5-8gb');
  const [purpose,  setPurpose]  = useState('kiosk');
  const [os,       setOs]       = useState('pi-os-desktop');

  // Filter purpose + OS lists to the compatible subset
  const validPurposes = useMemo(() => new Set(compatiblePurposes(hardware)), [hardware]);
  const validOses     = useMemo(() => new Set(compatibleOses(hardware)),     [hardware]);

  // Auto-shift purpose / os if the operator picks hardware that
  // excludes the current selection
  React.useEffect(() => {
    if (!validPurposes.has(purpose)) setPurpose([...validPurposes][0] || 'service');
    if (!validOses.has(os))           setOs([...validOses][0] || 'dietpi');
  }, [hardware]);  // eslint-disable-line

  const expanded = useMemo(
    () => applyPresetStack({ hardware, purpose, os }, {}),
    [hardware, purpose, os]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header>
        <h2 style={{ fontFamily: FONT_HEADING, fontSize: 28, fontWeight: 500, letterSpacing: -0.5, margin: 0, color: COLORS.textPrimary }}>
          Presets
        </h2>
        <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
          Composable defaults across hardware · purpose · OS. Pick a stack and the device builder will seed a matching manifest.
        </p>
      </header>

      {/* Three columns of pickers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <PresetColumn
          title="Hardware" Icon={Cpu}
          items={Object.values(HARDWARE_PRESETS)}
          selected={hardware} setSelected={setHardware}
          renderMeta={(h) => (
            <>{h.label} · {h.ram_mb ? (h.ram_mb >= 1024 ? `${(h.ram_mb/1024).toFixed(0)} GB` : `${h.ram_mb} MB`) : '—'} RAM · {h.arch || 'arm64'}</>
          )}
          renderDetail={(h) => (
            <DetailList items={[
              ['Family',     h.family],
              ['Cores',      h.cpu_cores || '—'],
              ['Wi-Fi',      h.has_wifi ? 'yes' : 'no'],
              ['Ethernet',   h.has_ethernet || '—'],
              ['GPIO',       h.has_gpio ? 'yes' : 'no'],
              ['HDMI',       h.has_hdmi || '—'],
              ['Power',      h.power_w_typical ? `~${h.power_w_typical}W typical` : '—'],
              ['Notes',      h.notes],
            ]}/>
          )}
        />
        <PresetColumn
          title="Purpose" Icon={Activity}
          items={Object.values(PURPOSE_PRESETS).filter(p => validPurposes.has(p.id))}
          selected={purpose} setSelected={setPurpose}
          renderMeta={(p) => <>{p.label} · {p.requires_display ? 'needs display' : 'headless'}</>}
          renderDetail={(p) => (
            <DetailList items={[
              ['Role',       p.role],
              ['Display',    p.requires_display ? 'required' : 'optional'],
              ['APT',        p.apt.length ? p.apt.join(', ') : '—'],
              ['pip',        p.pip.length ? p.pip.join(', ') : '—'],
              ['Services',   p.services.length ? p.services.join(', ') : '—'],
              ['Notes',      p.description],
            ]}/>
          )}
        />
        <PresetColumn
          title="OS" Icon={HardDrive}
          items={Object.values(OS_PRESETS).filter(o => validOses.has(o.id))}
          selected={os} setSelected={setOs}
          renderMeta={(o) => <>{o.label}{o.placeholder ? ' · planned' : ''}</>}
          renderDetail={(o) => (
            <DetailList items={[
              ['Package manager', o.package_manager],
              ['Default user',    o.default_user],
              ['systemd',         o.has_systemd ? 'yes' : 'no'],
              ['Base image glob', <code style={{ fontFamily: FONT_MONO, fontSize: 11 }}>{o.base_image_glob}</code>],
              ['Notes',           o.description],
              o.placeholder && ['Status', 'not yet built'],
            ].filter(Boolean)}/>
          )}
        />
      </div>

      {/* Expanded preview */}
      <section style={{
        padding: 18, background: COLORS.bgPanel,
        border: `1px solid ${COLORS.border}`, borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontFamily: FONT_HEADING, fontSize: 18, color: COLORS.accentBright }}>
            Manifest defaults · {hardware} + {purpose} + {os}
          </h3>
          <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: FONT_MONO }}>
            Schema v{expanded.presets.schema_version}
          </span>
        </div>
        <pre style={{
          margin: 0, padding: 12,
          background: 'rgba(0,0,0,0.4)', color: COLORS.textSecondary,
          border: `1px solid ${COLORS.border}`, borderRadius: 6,
          fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.55,
          overflow: 'auto', maxHeight: 360,
        }}>{JSON.stringify(expanded, null, 2)}</pre>
        <p style={{ margin: 0, color: COLORS.textMuted, fontSize: 11, fontFamily: FONT_MONO }}>
          Apply: open Devices → New manifest → the device builder will seed these fields and let you tweak from there.
        </p>
      </section>
    </div>
  );
}

function PresetColumn({ title, Icon, items, selected, setSelected, renderMeta, renderDetail }) {
  const sel = items.find(i => i.id === selected) || items[0];
  return (
    <div style={{
      background: COLORS.bgPanel, border: `1px solid ${COLORS.border}`, borderRadius: 10,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '12px 14px', borderBottom: `1px solid ${COLORS.border}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Icon size={16} style={{ color: COLORS.accent }}/>
        <span style={{ fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{title}</span>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>{items.length}</span>
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
        {items.map(item => (
          <button key={item.id} onClick={() => setSelected(item.id)} style={{
            textAlign: 'left', padding: '8px 10px',
            background: selected === item.id ? 'rgba(6,182,212,0.12)' : 'transparent',
            color:      selected === item.id ? COLORS.accentBright    : COLORS.textSecondary,
            border:     `1px solid ${selected === item.id ? COLORS.accentBorder : 'transparent'}`,
            borderRadius: 6, fontFamily: FONT_BODY, fontSize: 12, cursor: 'pointer',
          }}>{renderMeta(item)}</button>
        ))}
      </div>
      {sel && (
        <div style={{ padding: 14, borderTop: `1px solid ${COLORS.border}` }}>
          {renderDetail(sel)}
        </div>
      )}
    </div>
  );
}

function DetailList({ items }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 11 }}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt style={{ color: COLORS.textMuted, fontFamily: FONT_MONO, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</dt>
          <dd style={{ margin: 0, color: COLORS.textPrimary, fontFamily: FONT_BODY, fontSize: 12 }}>
            {v == null || v === '' ? <span style={{ color: COLORS.textMuted }}>—</span> : v}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
