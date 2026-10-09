// SC-Main design tokens: single source of truth for Phase 1 foundation.
// One accent (field green). No gradients, no neon, no glass.

export const tokens = {
  color: {
    paper: '#FAF7F0',
    surface: '#FFFFFF',
    ink: '#1D211B',
    muted: '#5C665C',
    line: '#E3DED2',
    accent: '#245C3A',
    accentInk: '#FFFFFF',
    warn: '#8A5A1E',
    danger: '#A83A2E',
    mist: '#EFF0E8',
    warnwash: '#FBF0D9',
    dangerwash: '#FBEAE7',
  },
  dark: {
    paper: '#141712',
    surface: '#1C201A',
    ink: '#EDEEE6',
    muted: '#A7AE9F',
    line: '#2C322A',
    accent: '#5FAE77',
    accentInk: '#0C120D',
    mist: '#232820',
  },
  radius: {
    pill: '999px',
    surface: '14px',
    input: '10px',
  },
  shadow: {
    sm: '0 1px 2px rgb(29 33 27 / 0.06)',
    md: '0 8px 24px rgb(29 33 27 / 0.08)',
  },
  font: {
    display: '"Space Grotesk", "Mukta", system-ui, sans-serif',
    body: '"Mukta", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
  },
};

export const zIndex = {
  header: 10,
  input: 10,
  overlay: 50,
};
