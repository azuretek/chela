// The Chela artwork, drawn once and written out as every file that shows it.
//
// ONE owner for the claw. The shape is defined here as a handful of primitives
// (a palm, a pair of fingers, a forearm, the gap between the fingers and the
// joint across the wrist), and every file that draws the claw is generated from
// them: the application icon, the tray glyph, and the two masks the in-app mark
// is painted through. A hand-kept copy of the outline in any of those would be a
// second owner, and the copies would disagree the first time one was touched.
// desktop/test/artwork.test.js regenerates all of them and fails if a committed
// file differs, so an edit made to a generated file is caught rather than
// silently overwritten by the next npm run icons.
//
// Why the outline is TRACED rather than drawn as a union of shapes. The neon look
// is a line that follows the claw's edge, and a stroke only follows the edge of a
// single path: stroking each primitive would draw the seams where the palm meets
// the fingers. So the primitives are combined into a signed-distance field and
// the zero line of that field is traced (marching squares) into one outline,
// which is then stroked and clipped to its own inside. The result is
// deterministic: same primitives, same outline, to the hundredth of a unit.
//
// The colours are not decided here. core/app-icons.js owns the design's two
// original palettes and the one rule that recolours them for any accent (the
// accent's hue first, a near-complement second as a small accent). This file
// only draws: every icon from palettesFor(), and the in-app mark as CSS that
// applies the same rule to the live --accent, so no theme is named anywhere.

import {
  PALETTE, PAPER, BUCKETS, PRIMARY, ROLES, KEY, SECOND_OFFSET, NEUTRAL, LIFT, PAPER_FADE,
  palettesFor, mix, spec,
} from '../../core/app-icons.js';

const r2 = (n) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};

// ------------------------------------------------------------------ geometry

// The claw's primitives, in the claw's own frame: pointing straight up, palm
// centred on x = 60, forearm running down off the bottom.
const PALM = { cx: 60, cy: 72, r: 28 };
const FINGERS = { cx: 60, cy: 48, rx: 25, ry: 32 };
const ARM = { x: 49, y: 92, w: 22, h: 50, r: 5 };
const JOINT = { x: 40, y: 96, w: 40, h: 3, r: 1.5 };
// The gap between the two fingers, open wide. Two cubic curves meeting at the
// crook of the pincer.
const GAP = [
  [[61, 68], [49, 55], [46, 36], [49, 6]],
  [[79, 6], [79, 32], [73, 54], [61, 68]],
];

function cubicPoints([p0, p1, p2, p3], n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}
const GAP_POLY = [...cubicPoints(GAP[0], 48), ...cubicPoints(GAP[1], 48)];

// Signed distances, negative inside.
const sdCircle = (x, y, c) => Math.hypot(x - c.cx, y - c.cy) - c.r;
// Not an exact ellipse distance, but its zero line IS the ellipse and it is
// monotonic across it, which is all the tracer interpolates on.
const sdEllipse = (x, y, e) => (Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry) - 1) * Math.min(e.rx, e.ry);
function sdRoundRect(x, y, b) {
  const hx = b.w / 2 - b.r, hy = b.h / 2 - b.r;
  const qx = Math.abs(x - (b.x + b.w / 2)) - hx, qy = Math.abs(y - (b.y + b.h / 2)) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.r;
}
function sdPolygon(x, y, poly) {
  let d = Infinity, inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const ex = xi - xj, ey = yi - yj, wx = x - xj, wy = y - yj;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? -d : d;
}

function clawField(x, y, extraCut) {
  const body = Math.min(sdCircle(x, y, PALM), sdEllipse(x, y, FINGERS), sdRoundRect(x, y, ARM));
  let d = Math.max(body, -sdPolygon(x, y, GAP_POLY), -sdRoundRect(x, y, JOINT));
  if (extraCut) d = Math.max(d, -sdRoundRect(x, y, extraCut));
  return d;
}

// Where the claw sits. Each placement maps a point in the artwork back into the
// claw's own frame, which is what sampling the field needs.
const rad = (deg) => (deg * Math.PI) / 180;
function unrotate(x, y, deg, cx, cy) {
  const a = -rad(deg), dx = x - cx, dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}
const PLACEMENTS = {
  // Rising from the bottom-left corner of the tile, pincers open towards the
  // top right. In SVG terms: translate(-6 20) rotate(32 60 100) scale(0.9).
  icon: {
    toClaw: (x, y) => {
      const [ux, uy] = unrotate(x + 6, y - 20, 32, 60, 100);
      return [ux / 0.9, uy / 0.9];
    },
  },
  // The tray glyph: the same claw, larger and centred, with the forearm cut
  // off just below the joint, because at 16px a forearm is only a smudge.
  tray: {
    toClaw: (x, y) => {
      const [ux, uy] = unrotate(x - 58, y - 62, 32, 0, 0);
      return [ux / 1.12 + 60, uy / 1.12 + 60];
    },
    cut: { x: 30, y: 106, w: 60, h: 60, r: 0 },
  },
};

// Traces the zero line of the placed field into closed loops. Nodes on the edge
// of the grid are forced outside, so a shape running off the canvas still
// closes, just outside the tile where nothing draws it.
function trace(placement, step = 0.25, lo = -2, hi = 122) {
  const n = Math.round((hi - lo) / step);
  const v = new Float64Array((n + 1) * (n + 1));
  const at = (i, j) => v[j * (n + 1) + i];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const edge = i === 0 || j === 0 || i === n || j === n;
      const [cx, cy] = placement.toClaw(lo + i * step, lo + j * step);
      v[j * (n + 1) + i] = edge ? 1 : clawField(cx, cy, placement.cut);
    }
  }
  const point = (key) => {
    const [kind, si, sj] = key.split(':');
    const i = +si, j = +sj;
    const [i2, j2] = kind === 'h' ? [i + 1, j] : [i, j + 1];
    const a = at(i, j), b = at(i2, j2), t = a / (a - b);
    return [lo + (i + (i2 - i) * t) * step, lo + (j + (j2 - j) * t) * step];
  };
  // Segments between edge crossings, keyed by edge so they can be chained.
  const links = new Map();
  const link = (a, b) => {
    (links.get(a) ?? links.set(a, []).get(a)).push(b);
    (links.get(b) ?? links.set(b, []).get(b)).push(a);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = [at(i, j) < 0, at(i + 1, j) < 0, at(i + 1, j + 1) < 0, at(i, j + 1) < 0];
      const top = 'h:' + i + ':' + j, right = 'v:' + (i + 1) + ':' + j;
      const bottom = 'h:' + i + ':' + (j + 1), left = 'v:' + i + ':' + j;
      const edges = [];
      if (c[0] !== c[1]) edges.push(top);
      if (c[1] !== c[2]) edges.push(right);
      if (c[2] !== c[3]) edges.push(bottom);
      if (c[3] !== c[0]) edges.push(left);
      if (edges.length === 2) link(edges[0], edges[1]);
      else if (edges.length === 4) {
        // A saddle: settled by the cell's centre, so the two corners that
        // share its sign stay connected.
        const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 < 0;
        if (centre === c[0]) { link(top, right); link(bottom, left); } else { link(top, left); link(right, bottom); }
      }
    }
  }
  const loops = [], seen = new Set();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(point(cur));
      const next = links.get(cur).find((k) => k !== prev && !seen.has(k));
      prev = cur;
      cur = next;
    }
    if (loop.length > 8) loops.push(simplify(loop, 0.02));
  }
  return loops;
}

// Ramer-Douglas-Peucker on a closed loop, split at its two furthest points.
function simplify(loop, tol) {
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst <= tol) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, at + 1)).slice(0, -1), ...rdp(pts.slice(at))];
  };
  let far = 0, fd = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(loop.slice(0, far + 1));
  const b = rdp([...loop.slice(far), loop[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const pathOf = (loops) => loops.map((l) => 'M' + l.map(([x, y]) => r2(x) + ' ' + r2(y)).join(' L') + 'Z').join(' ');

let cache = null;
function outlines() {
  cache ??= { icon: pathOf(trace(PLACEMENTS.icon)), tray: pathOf(trace(PLACEMENTS.tray)) };
  return cache;
}

// The synthwave floor: a horizon rule and lines running to a vanishing point.
function horizon(stroke, width, opacity) {
  const rows = [78, 82, 88, 97, 110].map((y) => '<path d="M10 ' + y + ' H110"/>');
  const rays = [-100, -40, 10, 60, 110, 160, 220].map((x) => '<path d="M60 78 L' + x + ' 112"/>');
  return '<g stroke="' + stroke + '" stroke-width="' + width + '" opacity="' + opacity + '">' + rows.join('') + rays.join('') + '</g>';
}

// The neon line: the outline stroked at twice the line width and clipped to the
// outline's own inside, which leaves a line of exactly that width lying inside
// the edge. A centred stroke would spill half its width past the claw.
function neon(id, width, paint) {
  return '<path d="' + outlines().icon + '" fill="none" stroke="' + paint + '" stroke-width="' + (width * 2) + '" stroke-linejoin="round" clip-path="url(#' + id + ')"/>';
}

// The tile both icons are drawn on, in the artwork's 120-unit canvas. The canvas
// leaves TILE.x units of margin on every side, which is the macOS grid; the
// edge-to-edge icon is framed to this rectangle instead.
export const TILE = { x: 10, y: 10, size: 100 };
const viewBox = (full) => (full ? [TILE.x, TILE.y, TILE.size, TILE.size] : [0, 0, 120, 120]).join(' ');

const HEAD = (what) => '<!-- Chela, ' + what + '. GENERATED by desktop/scripts/artwork.mjs: edit that, then run npm run icons. -->\n';

/**
 * The application icon: the sunset neon claw on the window tile.
 *
 * `square` draws the same tile with square corners, for iOS, which masks the
 * icon to its own shape and rejects any transparency. The icon pipeline used to
 * fill a rounded tile's corners from each row's most common colour, which holds
 * only while the background is what covers a row; the neon line is a vertical
 * gradient too, so every one of its pixels in a row is the same colour, and near
 * the foot of this icon it outnumbers the glow-tinted background and the corners
 * came out violet. Drawing the square here leaves the pipeline nothing to guess.
 *
 * `full` frames the same drawing to the tile alone, for the platforms whose icon
 * fills its square (core/app-icons.js fillsSquare): the viewBox is the tile's
 * own rectangle, so the margin the 120-unit canvas leaves round it for macOS is
 * simply not in the picture. Nothing inside the tile moves or changes.
 */
export function appIcon({ square = false, full = false, palette = palettesFor(PRIMARY).dark } = {}) {
  const P = palette, line = 2.2, rx = square ? 0 : 23;
  return HEAD('application icon') +
    '<svg viewBox="' + viewBox(full) + '" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + P.tileTop + '"/><stop offset="1" stop-color="' + P.tileBottom + '"/></linearGradient>' +
    '<linearGradient id="sunset" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="112"><stop offset="0" stop-color="' + P.sunrise + '"/><stop offset="0.5" stop-color="' + P.coral + '"/><stop offset="1" stop-color="' + P.violet + '"/></linearGradient>' +
    '<clipPath id="window"><rect x="10" y="10" width="100" height="100" rx="' + rx + '"/></clipPath>' +
    '<clipPath id="claw"><path d="' + outlines().icon + '"/></clipPath>' +
    '<filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><feGaussianBlur stdDeviation="3"/></filter>' +
    '</defs>' +
    '<rect x="10" y="10" width="100" height="100" rx="' + rx + '" fill="url(#tile)"/>' +
    '<g clip-path="url(#window)">' +
    '<circle cx="24" cy="24" r="3" fill="' + P.neon + '"/><circle cx="33" cy="24" r="3" fill="' + P.dotDim + '"/><circle cx="42" cy="24" r="3" fill="' + P.dotDim + '"/>' +
    '<path d="M10 38 H110" stroke="' + P.rule + '" stroke-width="2"/>' +
    horizon(P.neon, 0.8, 0.45) +
    '<g filter="url(#glow)" opacity="0.8">' + neon('claw', line, 'url(#sunset)') + neon('claw', line, 'url(#sunset)') + '</g>' +
    neon('claw', line, 'url(#sunset)') +
    '</g>' +
    '<rect x="10.5" y="10.5" width="99" height="99" rx="22.5" stroke="#ffffff" stroke-opacity="0.07"/>' +
    '</svg>\n';
}

/**
 * The paper icon: a white paper-cut claw with two coloured sheets under it, on a
 * sunset sky. Carries the same single 7% edge hairline as the neon icon, which is
 * what make-icons.mjs's square treatment finds and removes.
 */
export function paperIcon({ square = false, full = false, palette = palettesFor(PRIMARY).light } = {}) {
  const P = palette, rx = square ? 0 : 23, claw = outlines().icon;
  const sheet = ([dx, dy, fill]) => '<path d="' + claw + '" fill="' + fill + '" transform="translate(' + dx + ' ' + dy + ')"/>';
  return HEAD('paper application icon') +
    '<svg viewBox="' + viewBox(full) + '" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<linearGradient id="sky" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="' + P.skyTop + '"/>' +
    PAPER_FADE.map(([o, w]) => '<stop offset="' + o + '" stop-color="' + mix(P.skyBottom, w, P.skyTop) + '"/>').join('') + '</linearGradient>' +
    '<filter id="soft" filterUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><feGaussianBlur stdDeviation="1.4"/></filter>' +
    '<clipPath id="window"><rect x="10" y="10" width="100" height="100" rx="' + rx + '"/></clipPath>' +
    '</defs>' +
    '<rect x="10" y="10" width="100" height="100" rx="' + rx + '" fill="url(#sky)"/>' +
    '<g clip-path="url(#window)">' +
    '<circle cx="24" cy="24" r="3" fill="#ffffffcc"/><circle cx="33" cy="24" r="3" fill="#ffffff55"/><circle cx="42" cy="24" r="3" fill="#ffffff55"/>' +
    '<path d="M10 38 H110" stroke="#ffffff40" stroke-width="2"/>' +
    '<path d="' + claw + '" fill="' + P.shadow + '" opacity="0.3" filter="url(#soft)" transform="translate(4 5)"/>' +
    [[5, 5, P.deep], [2.5, 2.5, P.tint], [0, 0, '#ffffff']].map(sheet).join('') +
    '</g>' +
    '<rect x="10.5" y="10.5" width="99" height="99" rx="22.5" stroke="#000000" stroke-opacity="0.07"/>' +
    '</svg>\n';
}

/**
 * Every shipped icon, one neon and one paper per bucket (core/app-icons.js
 * BUCKETS), for make-icons.mjs to rasterise. `full` is the edge-to-edge set.
 */
export function bucketIcons({ square = false, full = false } = {}) {
  return BUCKETS.flatMap((bucket) => {
    const p = palettesFor(bucket);
    return [
      { bucket, mode: 'dark', svg: appIcon({ square, full, palette: p.dark }) },
      { bucket, mode: 'light', svg: paperIcon({ square, full, palette: p.light }) },
    ];
  });
}

/** The tray and menu-bar glyph: the claw alone, filled with the neon line's gradient. */
export function trayIcon({ palette = palettesFor(PRIMARY).dark } = {}) {
  const P = palette;
  return HEAD('tray and menu-bar glyph') +
    '<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="sunset" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="116"><stop offset="0" stop-color="' + P.sunrise + '"/><stop offset="0.5" stop-color="' + P.coral + '"/><stop offset="1" stop-color="' + P.violet + '"/></linearGradient></defs>' +
    '<path d="' + outlines().tray + '" fill="url(#sunset)"/>' +
    '</svg>\n';
}

/** One tray glyph per bucket, so the menu bar follows the theme too. */
export function bucketTrays() {
  return BUCKETS.map((bucket) => ({ bucket, svg: trayIcon({ palette: palettesFor(bucket).dark }) }));
}

// The in-app mark's masks. White on transparent, framed to the tile alone
// (viewBox 10..110) so a box the size of the mark lines up with them exactly.
// The in-app line is heavier than the icon's because the mark is drawn at 30 to
// 34 CSS pixels, where the icon's 2.2-unit line would be under a pixel wide.
function maskSvg(body, defs = '') {
  return '<svg viewBox="10 10 100 100" xmlns="http://www.w3.org/2000/svg">' + (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';
}
export function markRingMask() {
  return maskSvg(neon('c', 4, '#fff'), '<clipPath id="c"><path d="' + outlines().icon + '"/></clipPath>');
}
export function markHorizonMask() {
  return maskSvg(horizon('#fff', 1.4, 1));
}
/** The whole claw, filled: the paper mark's sheets are painted through it. */
export function markFillMask() {
  return maskSvg('<path d="' + outlines().icon + '" fill="#fff"/>');
}

// As data: URLs rather than files beside it, and that is a requirement, not a
// preference. CSS fetches a mask image in CORS mode, and a file:// page has an
// opaque origin, so url(assets/x.svg) as a mask is refused outright on the
// desktop's file:// pages and draws nothing. A data: URL is not fetched at all.
const dataUrl = (svg) => 'url("data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27') + '")';

// The in-app mark's colours: every role of both palettes as a custom property,
// derived from the element's live --accent by the same rule palettesFor() uses,
// in CSS relative colour syntax. `n` is 1 for an accent with real colour and 0
// for a neutral one; `lift` is 1 when a second colour falls in the muddy band.
const kebab = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const num = (x) => String(Math.round(x * 10000) / 10000);
function roleCss(role) {
  const n = 'clamp(0, (c - ' + NEUTRAL.chroma + ') * 1000, 1)';
  const first = 'calc(h * ' + n + ' + ' + NEUTRAL.hue + ' * (1 - ' + n + '))';
  const hue = role.second ? 'calc(' + first + ' + ' + num(SECOND_OFFSET) + ')' : first;
  const chroma = 'calc(' + num(role.C) + ' * (' + NEUTRAL.scale + ' + ' + num(1 - NEUTRAL.scale) + ' * ' + n + '))';
  if (!role.second) return 'oklch(from var(--accent) ' + num(role.L) + ' ' + chroma + ' ' + hue + ')';
  const lift = 'calc(' + n + ' * clamp(0, (cos(calc((' + hue + ' - ' + LIFT.centre + ') * 1deg)) - ' + num(Math.cos((LIFT.half * Math.PI) / 180)) + ') * 1000, 1))';
  return 'oklch(from var(--accent) max(' + num(role.L) + ', calc(' + LIFT.lightness + ' * ' + lift + ')) max(' + chroma + ', calc(' + LIFT.chroma + ' * ' + lift + ')) ' + hue + ')';
}

/** The stylesheet ui.css imports: the masks, and the mark's colours. */
export function markCss() {
  const primary = palettesFor(PRIMARY), fixed = { ...primary.dark, ...primary.light };
  const sky = 'linear-gradient(149deg, light-dark(var(--chela-sky-top), transparent) 0%, ' +
    PAPER_FADE.map(([o, w]) => 'light-dark(color-mix(in oklab, var(--chela-sky-bottom) ' + Math.round(w * 100) + '%, var(--chela-sky-top)), transparent) ' + Math.round(o * 100) + '%').join(', ') + ')';
  return '/* Chela, the in-app mark\'s masks and colours. GENERATED by desktop/scripts/artwork.mjs\n' +
    '   from core/app-icons.js: edit those, then run npm run icons. The mark itself is .chela-mark in ui.css. */\n' +
    ':root {\n' +
    '  --chela-mark-ring: ' + dataUrl(markRingMask()) + ';\n' +
    '  --chela-mark-horizon: ' + dataUrl(markHorizonMask()) + ';\n' +
    '  --chela-mark-fill: ' + dataUrl(markFillMask()) + ';\n' +
    '}\n' +
    '/* The primary icon\'s colours, for an engine without relative colour syntax. */\n' +
    '.chela-mark {\n' +
    ROLES.map((r) => '  --chela-' + kebab(r.name) + ': ' + fixed[r.name] + ';\n').join('') +
    '  --chela-mark-sky: ' + sky + ';\n' +
    '}\n' +
    '/* The live accent, recoloured by the rule every icon is drawn with. */\n' +
    '@supports (color: oklch(from red l c h)) {\n' +
    '  .chela-mark {\n' +
    ROLES.map((r) => '    --chela-' + kebab(r.name) + ': ' + roleCss(r) + ';\n').join('') +
    '  }\n' +
    '}\n';
}

// The iOS icon sets, one per bucket. Each holds the paper icon as its default
// rendition and the neon icon under the dark appearance, so the home screen
// follows the device's appearance with no code. The primary bucket is the
// AppIcon set the app ships with; every other bucket is an alternate icon.
const IOS_SETS = 'mobile/Chela/Assets.xcassets/';
export const iosSetName = (bucket) => (bucket.primary ? 'AppIcon' : 'AppIcon-' + bucket.id);
export const iosIconFile = (bucket, mode) => iosSetName(bucket) + '.appiconset/' + (bucket.primary ? 'AppIcon-1024' : bucket.id) + (mode === 'dark' ? '-dark' : '') + '.png';
function iosContents(bucket) {
  const file = (mode) => iosIconFile(bucket, mode).split('/')[1];
  return JSON.stringify({
    images: [
      { filename: file('light'), idiom: 'universal', platform: 'ios', size: '1024x1024' },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: file('dark'), idiom: 'universal', platform: 'ios', size: '1024x1024' },
    ],
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n';
}

/** Every generated file, by its path from the repo root. */
export function generatedFiles() {
  const files = {
    'core/ui/assets/claw.svg': appIcon(),
    'core/ui/assets/claw-tray.svg': trayIcon(),
    'core/ui/assets/claw-mark.css': markCss(),
    // The iOS app cannot import core/app-icons.js, so the buckets it chooses
    // between are written out for it, with samples its tests check against.
    'core/spec/app-icons.json': JSON.stringify(spec(), null, 2) + '\n',
  };
  for (const bucket of BUCKETS) files[IOS_SETS + iosSetName(bucket) + '.appiconset/Contents.json'] = iosContents(bucket);
  return files;
}
