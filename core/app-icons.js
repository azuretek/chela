// The app icon that matches the Control UI's theme, read from spec/app-icons.json.
//
// Each built-in theme has two icons: NEON for a dark palette and PAPER for a
// light one, both drawn in that theme's colours by desktop/scripts/artwork.mjs.
// The desktop swaps its Dock or window icon to the matching one (main.js
// applyAppIcon); the iOS app offers the matching alternate icon in a notice it
// can be ignored, because iOS confirms every icon change with an alert of its own.
//
// A theme is found by its accent, since that is what a client can read: the
// probe reports computed values, so a hex accent arrives as rgb().

import spec from './spec/app-icons.json' with { type: 'json' };

export const THEMES = spec.themes.map((t) => ({ ...t, primary: t.primary === true }));
export const PRIMARY = THEMES.find((t) => t.primary);

/** `#rgb`, `#rrggbb`, or the `rgb()`/`rgba()` a computed style reports, as `#rrggbb`; null otherwise. */
export function hex(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  let m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const d = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return `#${d}`;
  }
  m = raw.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (!m) return null;
  const parts = m.slice(1, 4).map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/** The built-in theme with this accent, in either mode, or null. */
export function themeForAccent(accent) {
  const h = hex(accent);
  if (!h) return null;
  return THEMES.find((t) => t.dark === h || t.light === h) || null;
}

/** Where a theme's icon is, relative to the desktop's assets directory. */
export function iconFile(id, mode) {
  return `icons/${id}-${mode === 'light' ? 'light' : 'dark'}.png`;
}

/** The iOS alternate icon's name, or null for the primary icon. */
export function alternateIconName(theme) {
  return theme.primary ? null : `AppIcon-${theme.id}`;
}

/**
 * The icon to show for a palette: the matching theme's, or the primary icon when
 * the palette is not a built-in theme. `mode` picks neon (dark) or paper (light).
 */
export function choose(accent, mode) {
  const theme = themeForAccent(accent) || PRIMARY;
  const m = mode === 'light' ? 'light' : 'dark';
  return { theme, mode: m, file: iconFile(theme.id, m) };
}
