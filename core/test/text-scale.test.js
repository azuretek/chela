// The reading scale, and the promise that our own pages follow it.
//
// The Control UI has a text-size setting: it stores textScale as a percentage and
// sets --control-ui-text-scale on :root as textScale/100, a unitless multiplier
// (upstream src/app/bootstrap-theme.ts). Its own type is authored as
// calc(<px> * var(--control-ui-text-scale)), so at 125% every size grows.
//
// Our pages render inside that interface and must grow with it. Two halves make
// that true, and this file guards both:
//
//  - PLUMBING: --control-ui-text-scale is in the live-token allowlist
//    (core/spec/tokens.json), so the desktop reads it off the running Control UI
//    and injects it into our pages the same way it does the colours, and the
//    phone reads the same name. Without the listing the multiplier never reaches
//    our pages and a reader at 125% sees our surfaces stay at 100%.
//
//  - RESPONSE: every font-size ui.css declares is relative to that multiplier,
//    either a --control-ui-text-* token (which is itself calc(px * scale)) or a
//    calc(px * var(--control-ui-text-scale)) of its own. A literal px size is the
//    fault this guards: it is a component that does not follow the setting, which
//    is exactly the state the pin's notBorrowed note used to record as the reason
//    the scale was left alone. Abi reversed that on 2026-09-19: take the scale and
//    convert every literal, so a literal reappearing is a regression.
//
// Run with: cd core && npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const UI_CSS = fs.readFileSync(path.join(REPO, 'core', 'ui', 'ui.css'), 'utf8');
const SPEC = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'tokens.json'), 'utf8'));

const LIVE = new Set(SPEC.live.tokens.map(([name]) => name));

test('the reading scale is a live token, so it reaches our pages off the running UI', () => {
  // The listing IS the filter: desktop/src/chrome.js sanitizeTokens keeps only the
  // names here, so a scale left off this list cannot reach any of our pages
  // however the Control UI sets it, and every page stays at its own fallback of 1.
  assert.ok(LIVE.has('--control-ui-text-scale'),
    'the reading scale is not in the live-token list, so our pages cannot follow the Control UI setting');
  const entry = SPEC.live.tokens.find(([name]) => name === '--control-ui-text-scale');
  assert.strictEqual(entry[1], 'scale',
    'the reading scale is listed under the wrong kind, so the probe and the sanitizer will not treat it as a unitless multiplier');
});

test('ui.css declares the scale and its type steps off it', () => {
  // The fallback of 1, and the four named steps, all derived from the multiplier.
  // A borrowed component says calc(21px * var(--control-ui-text-scale)); without
  // the fallback declared the whole calc is invalid and dropped in silence.
  assert.match(UI_CSS, /--control-ui-text-scale:\s*1\b/,
    'ui.css no longer declares the scale fallback of 1');
  for (const step of ['xs', 'sm', 'md', 'lg']) {
    const re = new RegExp('--control-ui-text-' + step + ':\\s*calc\\([0-9.]+px \\* var\\(--control-ui-text-scale\\)\\)');
    assert.match(UI_CSS, re, `ui.css no longer derives --control-ui-text-${step} from the scale`);
  }
});

/**
 * Every font-size and font shorthand ui.css declares, with the declaration text,
 * comments stripped so a size quoted in a comment is not read as a rule.
 */
function fontDeclarations(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of withoutComments.matchAll(/\bfont-size\s*:\s*([^;]+);/g)) out.push(['font-size', m[1].trim()]);
  // The `font` shorthand carries the size as its second-to-last field before the
  // family; the size is whatever sits before the last slash-or-space run that is
  // the line-height and family. Simpler and sufficient here: the shorthand always
  // holds a size token, so read the whole value and let the follows() check below
  // decide, since a literal px anywhere in it is the fault either way.
  for (const m of withoutComments.matchAll(/\bfont\s*:\s*([^;]+);/g)) out.push(['font', m[1].trim()]);
  return out;
}

/**
 * Whether a declaration's value follows the reading scale.
 *
 * True when it inherits, names a --control-ui-text-* token (each of which is
 * calc(px * scale) in ui.css), or scales a literal itself with
 * var(--control-ui-text-scale). A bare px size is the one thing that does not
 * follow, and it is what this rejects.
 */
function follows(value) {
  if (/\binherit\b/.test(value)) return true;
  if (/var\(--control-ui-text-(xs|sm|md|lg)\)/.test(value)) return true;
  // A literal px size that is NOT inside a calc(... * var(--control-ui-text-scale))
  // is the fault. Strip every scaled calc first, then look for a leftover px size.
  const withoutScaled = value.replace(/calc\([0-9.]+px\s*\*\s*var\(--control-ui-text-scale\)\)/g, '');
  return !/[0-9.]+px/.test(withoutScaled);
}

test('every font size our pages declare follows the reading scale', () => {
  const offenders = [];
  for (const [prop, value] of fontDeclarations(UI_CSS)) {
    if (!follows(value)) offenders.push(`${prop}: ${value}`);
  }
  assert.deepStrictEqual(offenders, [],
    'these font declarations carry a literal px size that will not follow the Control UI text-size setting: ' + JSON.stringify(offenders));
});
