// Ark's visual tokens — Hellgate palette, matched to the new Sinsera Core.
// Oxblood, ember, bone, candle gold. Cinzel + Crimson Text + Share Tech Mono.
//
// Re-themed 2026-05-27. Token KEY names (accent, gold, bgPrimary, etc.) are
// preserved so every component that references COLORS.<name> keeps working
// without component-level edits.

export const COLORS = {
  // Surfaces — dark, blood-tinted
  bgPrimary:    '#0a0005',                  // matches Sinsera Core --background
  bgCard:       'rgba(192, 57, 43, 0.06)',  // blood-wash card
  bgPanel:      '#110008',                  // matches --card
  bgHover:      'rgba(255, 255, 255, 0.05)',
  bgActive:     'rgba(192, 57, 43, 0.14)',

  // Borders — dried-blood lines
  border:       'rgba(139, 0, 0, 0.35)',
  borderStrong: 'rgba(139, 0, 0, 0.55)',

  // Text — bone on dark
  textPrimary:  '#e8d5c4',
  textSecondary:'#c9a882',
  textMuted:    '#7a5c4a',

  // Accent — blood / ember
  accent:       '#c0392b',                  // primary blood
  accentBright: '#ff4500',                  // ember
  accentDeep:   '#8b0000',                  // deep oxblood
  accentBorder: 'rgba(192, 57, 43, 0.45)',

  // Legacy alias kept for components that reference COLORS.gold — maps
  // to the same blood accent so nothing renders the wrong hue.
  gold:         '#c0392b',
  goldBorder:   'rgba(192, 57, 43, 0.45)',

  // Sigil / candle highlight (used by some headers + status dots)
  candle:       '#d4a017',

  // Status — kept readable on dark; tuned slightly for the new palette
  success:      '#22c55e',
  warning:      '#F5B45A',
  error:        '#EF6F5C',
  info:         '#c0392b',
};

// Font stack — mirrors Sinsera Core's "infernal interface" set.
export const FONT_HEADING = '"Cinzel Decorative", "Cinzel", "Cormorant Garamond", Georgia, serif';
export const FONT_BODY    = '"Crimson Text", "Cormorant Garamond", Georgia, serif';
export const FONT_MONO    = '"Share Tech Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const btnPrimary = (extra = {}) => ({
  padding: '0.6rem 1.1rem',
  background: `linear-gradient(135deg, ${COLORS.accentDeep} 0%, ${COLORS.accent} 100%)`,
  border: `1px solid ${COLORS.accentBorder}`,
  borderRadius: '0.25rem',
  color: COLORS.textPrimary,
  fontWeight: 600,
  fontSize: '0.78rem',
  fontFamily: FONT_MONO,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  transition: 'transform 0.12s ease, box-shadow 0.2s ease, filter 0.15s ease, opacity 0.2s ease',
  boxShadow: '0 1px 0 rgba(255, 200, 180, 0.18) inset, 0 0 18px rgba(192, 57, 43, 0.35)',
  ...extra,
});
