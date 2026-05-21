// Ark's visual tokens. Carries forward the Sinsera dark-on-black
// palette but swaps the brand accent from orange to cyan/teal so it
// reads as "a sibling app, not Sinsera Core". Pi Kiosk Builder needs
// to feel slightly tech-utility (LED-cyan) rather than editorial.

export const COLORS = {
  // Surfaces
  bgPrimary:    '#0a0a0a',
  bgCard:       'rgba(6, 182, 212, 0.06)',
  bgPanel:      '#0F1620',
  bgHover:      'rgba(255, 255, 255, 0.05)',
  bgActive:     'rgba(6, 182, 212, 0.14)',

  // Borders
  border:       '#1B2030',
  borderStrong: '#2A3040',

  // Text
  textPrimary:  '#ECE7DA',
  textSecondary:'#B6BBC9',
  textMuted:    '#7C8499',

  // Accent — cyan-teal "tech LED" family
  accent:       '#06B6D4',
  accentBright: '#22D3EE',
  accentDeep:   '#0E7490',
  accentBorder: 'rgba(6, 182, 212, 0.45)',

  // Kept as a legacy alias — some carry-over code references COLORS.gold;
  // map it to the new accent so nothing renders the wrong hue.
  gold:         '#06B6D4',
  goldBorder:   'rgba(6, 182, 212, 0.45)',

  // Status
  success:      '#22c55e',
  warning:      '#F5B45A',
  error:        '#EF6F5C',
  info:         '#7BB6D9',
};

export const FONT_HEADING = '"Cormorant Garamond", Georgia, serif';
export const FONT_BODY    = '"Outfit", -apple-system, BlinkMacSystemFont, sans-serif';
export const FONT_MONO    = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const btnPrimary = (extra = {}) => ({
  padding: '0.6rem 1.1rem',
  background: `linear-gradient(135deg, ${COLORS.accentDeep} 0%, ${COLORS.accent} 100%)`,
  border: `1px solid ${COLORS.accentBorder}`,
  borderRadius: '0.5rem',
  color: '#0a0a0a',
  fontWeight: 700,
  fontSize: '0.875rem',
  fontFamily: FONT_BODY,
  letterSpacing: '0.02em',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  transition: 'transform 0.12s ease, box-shadow 0.2s ease, opacity 0.2s ease',
  boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset, 0 8px 18px rgba(6,182,212,0.18)',
  ...extra,
});
