// The design tokens our own chrome draws notice banners with, read from
// spec/tokens.json.
//
// The point of this module is that the four clients do not each invent a
// palette. The Control UI's styling cannot be imported (the gateway serves it
// under a content-hashed, immutable filename, and our pages are separate
// documents), so what can be shared is the token layer: the values the Control
// UI resolves to, copied once into spec/tokens.json with the file each came
// from, and consumed from there by desktop as CSS and by iOS as constants. The
// iOS constants are proven against the same file by a parity test, so a value
// that moves here is a value that fails there until it moves too.
//
// Platform-free: this derives CSS text and resolves names, and knows nothing
// about Electron, a window or a web view. desktop/src/chrome.js decides when to
// put the CSS on a page; mobile/Claw/NoticeTokens.swift mirrors the data.
//
// One boundary worth stating plainly: these are *fallbacks*. Where a token name
// is also in desktop/src/chrome.js THEME_TOKENS, a live Control UI theme
// overrides it at runtime, which is what keeps our chrome following whichever
// palette the UI is actually running rather than only the default one. The names
// the UI does not publish (--bg-elevated, --danger, --shadow-sm, the card
// geometry) have no live value to take, so here they stay at the Control UI's
// own defaults.

import spec from './spec/tokens.json' with { type: 'json' };

/** The two colour modes, in the order a stylesheet should emit them. */
export const MODES = ['dark', 'light'];

/** Severities, worst first, as the notice model names them. */
export const TONES = ['error', 'warn', 'info', 'ok'];

/** The card geometry and the tone map, straight from the spec. */
export const CARD = { ...spec.card };
export const TONE = Object.fromEntries(TONES.map((t) => [t, { ...spec.tone[t] }]));

/**
 * The tokens a client may take from a RUNNING Control UI, as [name, kind] pairs.
 *
 * One owner for both clients: the desktop reads these names out of the gateway
 * page and inserts them into our pages (desktop/src/chrome.js re-exports this as
 * THEME_TOKENS), and the phone reads the same names out of the same page and
 * applies them to the settings and About surfaces. Before this lived here, the
 * list was the desktop's alone, and the phone had no list at all, which is why
 * its surfaces were the only ones not wearing the interface's own type and
 * palette.
 */
export const LIVE_TOKENS = spec.live.tokens.map(([name, kind]) => [name, kind]);

/**
 * Every colour as a name/value pair for one mode, shape included.
 *
 * Shape and colour are separate objects in the spec because they came from
 * separate places and only the colours are mode-dependent, but a stylesheet
 * wants both as flat custom properties, so they are merged here rather than at
 * each use.
 */
export function values(mode) {
  const css = spec.css[mode];
  if (!css) throw new Error(`no such mode in spec/tokens.json: ${mode}`);
  return { ...css, ...spec.shape };
}

/**
 * Resolve a token name to its value in one mode, following one level of
 * `var(...)` so a token defined as another token still answers with a value.
 *
 * `null` for anything unknown, which is the honest answer: a caller that asked
 * for a name this file does not own has a bug, and a silent fallback colour
 * would hide it behind something that looks deliberate.
 */
export function resolve(name, mode = 'dark') {
  let all;
  try { all = values(mode); } catch { return null; }
  let current = typeof name === 'string' ? name : null;
  const seen = new Set();
  while (current !== null) {
    const wrapped = /^var\(\s*(--[\w-]+)\s*\)$/.exec(current);
    const token = wrapped ? wrapped[1] : current;
    // A value that is not a token name is not something this file can answer
    // for: a caller asking about one has a bug, and a fallback colour would
    // hide it behind something that looks deliberate.
    if (!/^--[\w-]+$/.test(token)) return null;
    if (seen.has(token)) return null;
    seen.add(token);
    if (!(token in all)) return null;
    current = all[token];
    if (typeof current !== 'string') return null;
    if (!current.startsWith('var(')) return current;
  }
  return null;
}

/**
 * The two colours one tone draws with, resolved for a mode.
 *
 * Here rather than in each client because "which token is the error tone" is the
 * mapping, and a mapping copied into two places is a mapping that dissents.
 */
export function toneColours(tone, mode = 'dark') {
  const entry = TONE[tone];
  if (!entry) throw new Error(`no such tone in spec/tokens.json: ${tone}`);
  return { tone, edge: resolve(entry.edge, mode), tint: resolve(entry.tint, mode) };
}

/** One card token resolved, whether it names another token or is a literal. */
function cardValue(value, mode) {
  if (typeof value !== 'string') return value;
  return value.startsWith('--') ? `var(${value})` : value;
}

/**
 * The stylesheet our own pages load as their fallback palette.
 *
 * Emitted with `!important` by default, and that is not decoration: ui.css
 * declares its own literal fallback for most of these names, and without the
 * flag those literals win on source order once this is inserted after them.
 * desktop/src/main.js inserts this *before* the live theme, whose own
 * declarations are also important and so take precedence over this in turn.
 *
 * The card properties are derived here rather than written into the stylesheet
 * so that banner.css names a tone and a token and never a colour: the mapping
 * from tone to colour is data, and a copy of it in CSS is a second owner that
 * agrees only until someone edits one of them. Measurements the Control UI has
 * no equivalent for (the progress bar's height, the stack's own gaps) belong to
 * the element and stay with it in banner.css.
 */
export function rootCss({ mode = 'dark', important = true } = {}) {
  const flag = important ? ' !important' : '';
  const lines = [];
  for (const [name, value] of Object.entries(values(mode))) {
    lines.push(`  ${name}: ${value}${flag};`);
  }
  // The type scale, under the names the Control UI publishes, so the sizes here
  // are the same numbers it multiplies by its own text scale.
  for (const [step, size] of Object.entries(spec.type.size)) {
    lines.push(`  --control-ui-text-${step}: ${size}${flag};`);
  }
  lines.push(`  --font-body: ${spec.type.font.body}${flag};`);
  for (const [name, weight] of Object.entries(spec.type.weight)) {
    lines.push(`  --notice-weight-${name}: ${weight}${flag};`);
  }
  for (const [name, leading] of Object.entries(spec.type.leading)) {
    lines.push(`  --notice-leading-${name}: ${leading}${flag};`);
  }
  for (const [name, value] of Object.entries(CARD)) {
    if (name === 'dismiss' || name === 'action') continue;
    lines.push(`  --notice-${dashed(name)}: ${cardValue(value, mode)}${flag};`);
  }
  for (const [name, value] of Object.entries(CARD.dismiss)) {
    lines.push(`  --notice-dismiss-${dashed(name)}: ${cardValue(value, mode)}${flag};`);
  }
  for (const [name, value] of Object.entries(CARD.action)) {
    lines.push(`  --notice-action-${dashed(name)}: ${cardValue(value, mode)}${flag};`);
  }
  // One pair per tone, so banner.css names a tone and never a colour, and the
  // tone-to-token mapping lives only in spec/tokens.json.
  for (const tone of TONES) {
    lines.push(`  --notice-tone-${tone}-edge: ${cardValue(TONE[tone].edge, mode)}${flag};`);
    lines.push(`  --notice-tone-${tone}-tint: ${cardValue(TONE[tone].tint, mode)}${flag};`);
  }
  return `/* ${mode} */\n:root {\n${lines.join('\n')}\n}\n`;
}

/**
 * Both modes, as one stylesheet.
 *
 * Light is behind the media query rather than a class because that is how the
 * app's own pages already follow the appearance, set from nativeTheme by
 * src/main.js, so the banner and the page it sits over cannot disagree about
 * which mode is in force.
 */
export function stylesheet({ important = true } = {}) {
  return `${rootCss({ mode: 'dark', important })}\n@media (prefers-color-scheme: light) {\n${indent(rootCss({ mode: 'light', important }))}}\n`;
}

/** camelCase to the dashed name a custom property uses. */
function dashed(name) {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function indent(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => `  ${line}`).join('\n');
}
