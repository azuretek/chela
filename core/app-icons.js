// The app icon for ANY Control UI theme, derived from its accent.
//
// Nothing here knows a theme's name or colour. The icon's design is its two
// original palettes below (neon for a dark palette, paper for a light one), and
// a theme recolours it by one rule: the accent's hue is the FIRST colour, and
// the SECOND is that hue turned SECOND_OFFSET degrees round the wheel (a
// near-complement, 130 degrees). Every role keeps the lightness and chroma the
// original gave it, so the design survives any accent. A theme added upstream
// tomorrow is recoloured the same way with no change here.
//
// Where the rule is used:
//   - desktop/scripts/artwork.mjs draws every icon from palettesFor(), and
//     writes the in-app mark's colours as CSS that applies the same rule to the
//     live --accent (claw-mark.css), so the mark matches any theme exactly.
//   - The shipped icons are one pair per BUCKET: STEPS hues evenly spaced round
//     the wheel from the design's own key colour, plus a neutral pair for an
//     accent with no real colour. iOS can only switch to icons it shipped with,
//     so a live accent takes the nearest bucket (bucketFor), and the desktop
//     makes the same choice so the two clients show the same icon.
//   - spec() is written to core/spec/app-icons.json for the iOS app, which
//     cannot import this module; samples in it hold the Swift mirror to this.

/** The original neon icon, the design every dark icon is recoloured from. */
export const PALETTE = {
  tileTop: '#1a0b2e',
  tileBottom: '#07030f',
  neon: '#ff3fa4',
  dotDim: '#3a2a5a',
  rule: '#2a1a44',
  sunrise: '#ffb347',
  coral: '#ff5e62',
  violet: '#a33bd6',
};

/** The original paper icon, the design every light icon is recoloured from. */
export const PAPER = {
  skyTop: '#ff9a3c',
  skyBottom: '#8e2de2',
  deep: '#4a1580',
  tint: '#ffc9b8',
  shadow: '#3b0f5a',
};

/** The roles that take the SECOND colour: the far end of the neon line, the
 *  foot of the paper sky and the deepest paper sheet. Everything else is the
 *  theme's own colour, so the second reads as an accent, never as the main. */
export const SECOND_ROLES = new Set(['violet', 'skyBottom', 'deep']);

/** How the paper sky fades from its top colour into the second colour, as
 *  [offset, weight of the second]. The theme colour holds the top tenth, and
 *  the second reaches full strength only in the corner. */
export const PAPER_FADE = [[0.1, 0], [0.3, 0.15], [0.5, 0.4], [0.7, 0.68], [0.85, 0.88], [1, 1]];

/** Shipped icon pairs round the wheel. */
export const STEPS = 12;

/** An accent below this OKLCH chroma has no real colour and takes the neutral
 *  pair, drawn at a cool slate hue with a fraction of the design's chroma. */
export const NEUTRAL = { chroma: 0.035, hue: 230, scale: 0.12 };

/** A second colour inside this hue band (orange through green) turns brown or
 *  olive at the design's lightness, so it is lifted to at least this lightness
 *  and chroma. The band is centre +/- half. */
export const LIFT = { centre: 100, half: 70, lightness: 0.72, chroma: 0.14 };

// ------------------------------------------------------------------- colour

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

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

function oklab(h) {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function linearRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, c)))) * 255).toString(16).padStart(2, '0')).join('');

/** OKLCH of a colour: lightness, chroma, hue in degrees. */
export function lch(value) {
  const [L, a, b] = oklab(hex(value));
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** An OKLCH colour as `#rrggbb`, chroma reduced until it fits sRGB. */
export function fromLch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  for (let c = C; c > 0; c -= 0.002) {
    const rgb = linearRgb([L, c * Math.cos(rad), c * Math.sin(rad)]);
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return toHex(rgb);
  }
  return toHex(linearRgb([L, 0, 0]));
}

/** `a` at weight `w` against `b`, mixed in OKLab. */
export function mix(a, w, b) {
  const A = oklab(hex(a)), B = oklab(hex(b));
  return toHex(linearRgb(A.map((v, i) => v * w + B[i] * (1 - w))));
}

const signed = (d) => ((((d % 360) + 540) % 360) - 180);
const distance = (a, b) => Math.abs(signed(a - b));

// ------------------------------------------------------------------ the rule

/** The design's key hue: the coral at the middle of the neon line. */
export const KEY = lch(PALETTE.coral).h;

/** How far the second colour sits from the first. It turns the way the
 *  original violet sits from its coral, so the default stays nearest the
 *  original sunset. */
export const SECOND_OFFSET = Math.sign(signed(lch(PALETTE.violet).h - KEY)) * 130;

/** Whether a second colour at hue `h` falls in the band that goes muddy. */
export function inLiftBand(h) {
  return Math.cos(((h - LIFT.centre) * Math.PI) / 180) > Math.cos((LIFT.half * Math.PI) / 180);
}

/** Every role of both palettes, with the lightness and chroma the design gave it. */
export const ROLES = Object.entries({ ...PALETTE, ...PAPER }).map(([name, value]) => {
  const { L, C } = lch(value);
  return { name, L, C, second: SECOND_ROLES.has(name) };
});

/** The shipped pairs: STEPS hues from KEY, then the neutral pair. The first is
 *  the primary icon, the one the app ships with and the default theme gets. */
export const BUCKETS = [
  ...Array.from({ length: STEPS }, (_, i) => {
    const hue = (KEY + (i * 360) / STEPS) % 360;
    return { id: `h${Math.round(hue)}`, hue, primary: i === 0 };
  }),
  { id: 'neutral', hue: null, primary: false },
];
export const PRIMARY = BUCKETS[0];

/** The pair for an accent: neutral when it has no real colour, else the nearest hue. */
export function bucketFor(accent) {
  const h = hex(accent);
  if (!h) return PRIMARY;
  const { C, h: hue } = lch(h);
  if (C < NEUTRAL.chroma) return BUCKETS[BUCKETS.length - 1];
  return BUCKETS.filter((b) => b.hue !== null).reduce((best, b) => (distance(b.hue, hue) < distance(best.hue, hue) ? b : best));
}

/** A bucket's neon (`dark`) and paper (`light`) palettes, by the rule above. */
export function palettesFor(bucket) {
  const neutral = bucket.hue === null;
  const first = neutral ? NEUTRAL.hue : bucket.hue;
  const second = (first + SECOND_OFFSET + 360) % 360;
  const scale = neutral ? NEUTRAL.scale : 1;
  const paint = (palette) => Object.fromEntries(Object.keys(palette).map((name) => {
    const role = ROLES.find((r) => r.name === name);
    const h = role.second ? second : first;
    let L = role.L, C = role.C * scale;
    if (role.second && !neutral && inLiftBand(h)) {
      L = Math.max(L, LIFT.lightness);
      C = Math.max(C, LIFT.chroma);
    }
    return [name, fromLch(L, C, h)];
  }));
  return { dark: paint(PALETTE), light: paint(PAPER) };
}

// ------------------------------------------------------------- the shipped set

/** Whether a platform's app icon fills its whole square. macOS lays app icons
 *  on Apple's grid, which leaves a margin round the tile, so the Dock icon keeps
 *  the margin the artwork is drawn with. Windows and Linux put no margin of
 *  their own round an icon and draw it at the size of its square, so there the
 *  margin only makes the icon smaller than every other app's: they get the
 *  tile edge to edge. The packaged icon follows the same split, in
 *  desktop/electron-builder.yml. */
export const fillsSquare = (platform) => platform !== 'darwin';

/** Whether a platform's live window icon is handed over as a multi-size .ico
 *  rather than one PNG. Windows: a single PNG becomes one oversized HICON for
 *  both the big and the small icon (measured 2026-09-24: 512 px each), and the
 *  taskbar then draws it at 30 px in a 36 px slot at 150% scaling. From an .ico
 *  Windows loads the size it needs, as it does for the exe's own icon, which
 *  drew full size in the same slot. The .ico is always edge to edge. */
export const iconsAsIco = (platform) => platform === 'win32';

/** Where a bucket's icon is, relative to the desktop's assets directory.
 *  `full` is the edge-to-edge icon a platform that fillsSquare() shows. */
export const iconFile = (bucket, mode, { full = false, ico = false } = {}) => (ico
  ? `icons/${bucket.id}-${mode === 'light' ? 'light' : 'dark'}.ico`
  : `icons/${bucket.id}-${mode === 'light' ? 'light' : 'dark'}${full ? '-full' : ''}.png`);
/** Where a bucket's tray glyph is; Electron finds the `@2x` beside it. */
export const trayFile = (bucket) => `icons/tray-${bucket.id}.png`;
/** The iOS alternate icon for a bucket in one mode. Every bucket has one per
 *  mode, the primary's included, so the icon follows the Control UI's own light
 *  or dark palette rather than the home screen's appearance: an icon set that
 *  carries both renditions switches with the DEVICE, which is not the question
 *  when the interface's theme is pinned to the other mode. */
export const alternateIconName = (bucket, mode) => `AppIcon-${bucket.id}-${mode === 'light' ? 'light' : 'dark'}`;

/** The icon to show for a live palette: its bucket, neon or paper by mode, and
 *  edge to edge when `full` (see fillsSquare). */
export function choose(accent, mode, { full = false, ico = false } = {}) {
  const bucket = bucketFor(accent);
  const m = mode === 'light' ? 'light' : 'dark';
  return { bucket, mode: m, file: iconFile(bucket, m, { full, ico }), tray: trayFile(bucket) };
}

/** What the iOS app reads, as data: the buckets, the neutral threshold, and
 *  sample accents with the bucket this module chooses, which the Swift tests
 *  hold the Swift mirror to. Samples sit well inside their bucket, so a rounding
 *  difference between the two implementations cannot move one. */
export function spec() {
  const round = (n) => Math.round(n * 1000) / 1000;
  const samples = [];
  for (const b of BUCKETS.filter((x) => x.hue !== null)) {
    for (const [dh, L, C] of [[-10, 0.7, 0.14], [0, 0.55, 0.12], [10, 0.8, 0.1]]) {
      const accent = fromLch(L, C, (b.hue + dh + 360) % 360);
      samples.push({ accent, bucket: bucketFor(accent).id });
    }
  }
  for (const accent of ['#808080', '#e8e8e8', '#1f1f1f', 'rgb(90, 182, 216)']) samples.push({ accent, bucket: bucketFor(accent).id });
  return {
    description: 'GENERATED by desktop/scripts/artwork.mjs from core/app-icons.js: edit that, then run npm run icons. The app icon pairs the iOS app ships and how a live accent picks one.',
    neutralChroma: NEUTRAL.chroma,
    buckets: BUCKETS.map((b) => ({ id: b.id, hue: b.hue === null ? null : round(b.hue), primary: b.primary })),
    samples,
  };
}
