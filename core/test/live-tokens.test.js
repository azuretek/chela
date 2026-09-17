// Every colour our own pages declare as a palette FALLBACK must be a name the
// live theme is allowed to override.
//
// This is the guard for the fault reported on 2026-09-16, and it is a guard
// rather than a comment because of what the fault looked like from inside: the
// two files agreed with each other. ui.css declared `--card`, `--bg-elevated` and
// `--muted-strong` with a comment saying a running Control UI overrides them, and
// the borrowed upstream components drew their surfaces from `--card`. What was
// missing was the LISTING. The live theme is not applied by name matching, it is
// applied by allowlist (`sanitizeTokens` in desktop/src/chrome.js keeps only the
// names core/spec/tokens.json's `live` array holds), so a palette token left out
// of that array gets no live value however well upstream defines it.
//
// Measured, on a purple palette a reader can genuinely pick: the settings groups
// painted rgb(22, 25, 32), ui.css's copy of the Control UI's DEFAULT card, inside
// a window wearing the reader's own rgb(31, 29, 46). A page with two palettes on
// it, and nothing in any log, because both values are perfectly good colours.
//
// So: every colour-valued custom property ui.css declares for a page with no
// gateway must be either a name the live list carries, or a name listed below as
// deliberately ours. Adding one to ui.css without doing either fails here, which
// is the one moment somebody still knows the answer.
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

/** Which tokens both clients take from a running Control UI, one owner. */
const LIVE = new Set(SPEC.live.tokens.map(([name]) => name));

/**
 * The palette colours ui.css owns outright, with the reason each is not a live
 * one.
 *
 * A name here is a decision rather than an omission, which is the whole point:
 * the failure message on the guard below says which of the two a reader is
 * looking at.
 *
 * Read from the spec rather than listed here, because a second consumer now needs
 * the same answer: the app-side harness that opens the real settings surface
 * against a published palette (desktop/scripts/test-settings-theme.js) has to
 * know which names are OURS before it can tell a name the live theme cannot reach
 * from one that deliberately is not a live name at all. Two copies of this list
 * would disagree the first time either moved, which is the drift this file exists
 * to prevent.
 */
const OURS = new Map((SPEC.live.ours || []).map((entry) => [entry.name, entry.reason]));

/**
 * Live names whose value ui.css DERIVES once, from a token that is itself
 * per-mode.
 *
 * The two scrollbar thumb colours: the Control UI publishes them, and ui.css
 * computes them here as a mix of `--muted`, so declaring them in the dark block
 * alone is deliberate and they follow the appearance anyway. They are excluded
 * from the two-block comparison below, and only from that.
 */
const DERIVED_ONCE = new Set(['--scrollbar-thumb', '--scrollbar-thumb-hover']);

/** Every `--name: value;` declared inside one rule of the stylesheet. */
function declaredIn(css, from, label) {
  const start = css.indexOf(from);
  assert.notStrictEqual(start, -1, `ui.css has no ${label} rule`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out = [];
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.push([match[1], match[2].trim()]);
  }
  return out;
}

/** Whether a declaration's value is a colour rather than a length, a font or a time. */
function isColour(value) {
  return /#|rgba?\(|color-mix\(|\btransparent\b/i.test(value);
}

/** The first `:root` block, which is the dark palette. */
const DARK = declaredIn(UI_CSS, ':root {', 'dark-palette');

/** The light palette, read out of the media query that holds it. */
const LIGHT = (() => {
  const media = UI_CSS.indexOf('@media (prefers-color-scheme: light)');
  assert.notStrictEqual(media, -1, 'ui.css has no light-mode media query');
  return declaredIn(UI_CSS.slice(media), ':root {', 'light-palette');
})();

/** The names the light palette declares, for the "is it declared there too" cases. */
const LIGHT_NAMES = new Set(LIGHT.map(([name]) => name));

/** The two palette blocks, each of which has to be able to follow the theme. */
const BLOCKS = [
  [':root', DARK],
  ['the light block', LIGHT],
];

test('the spec publishes a live list with both surfaces the borrowed components draw on', () => {
  assert.ok(LIVE.size > 20, `the live list has ${LIVE.size} names, which cannot be the whole palette`);
  // The three the fault was about, named here so that dropping one back out is a
  // failure with a reason rather than the quiet return of a two-palette page.
  for (const name of ['--card', '--bg-elevated', '--muted-strong']) {
    assert.ok(
      LIVE.has(name),
      `${name} is not in the spec's live list, so the live theme cannot reach it`,
    );
  }
});

test('every palette colour ui.css declares is one the live theme can override, or stated as ours', () => {
  const offenders = [];
  for (const [where, declarations] of BLOCKS) {
    assert.ok(declarations.length > 10, `${where} declares only ${declarations.length} properties`);
    for (const [name, value] of declarations) {
      if (!isColour(value)) continue;
      if (LIVE.has(name) || OURS.has(name)) continue;
      offenders.push(`${where}: ${name} (${value})`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'these colours are declared as a fallback but are not in core/spec/tokens.json\'s live list, so a page\n'
      + 'showing them keeps them whatever palette the Control UI is wearing. Either add each name to that list\n'
      + '(and to the mirror in mobile/Claw/ThemeTokens.swift, which a parity test holds to it), or add it to\n'
      + 'OURS in this file with the reason it is ours:\n'
      + offenders.map((line) => `  - ${line}`).join('\n'),
  );
});

test('each stated exception says why, and is really a colour ui.css owns', () => {
  assert.ok(OURS.size >= 4, `the spec states ${OURS.size} owned names, which is fewer than the ones it has always owned`);
  const dark = new Map(DARK);
  const all = new Map([...DARK, ...LIGHT]);
  for (const [name, reason] of OURS) {
    assert.ok(reason.length > 20, `${name} is listed as ours with no reason`);
    assert.ok(!LIVE.has(name), `${name} is listed as ours AND published as live, so one of the two is wrong`);
    assert.ok(all.has(name), `${name} is listed as ours but ui.css does not declare it`);
    assert.ok(isColour(all.get(name)), `${name} is listed as ours but it is not a colour`);
    // And it is one of OUR own values rather than a literal per appearance: the
    // ones that are mode-dependent by name (--ok, --warn) are declared in both
    // blocks, and the ones derived from a per-mode token (--scrim from --bg,
    // --focus-ring from --bg and --ring) are declared once on purpose. Either is
    // fine; what would not be is a literal declared in one block only, so that
    // is what this checks.
    if (dark.has(name) && !LIGHT_NAMES.has(name)) {
      assert.match(all.get(name), /var\(|color-mix\(|gradient\(/,
        `${name} is declared in one appearance only and does not derive from a token, so it cannot follow the mode`);
    }
  }
  for (const name of DERIVED_ONCE) {
    assert.ok(LIVE.has(name), `${name} is derived once on the assumption that the live list carries it`);
    assert.ok(dark.has(name), `${name} is derived once but the dark palette does not declare it`);
  }
});

test('both palette blocks declare every live colour, so neither appearance loses one', () => {
  // A live colour declared in one block and not the other is a surface that
  // falls back to nothing when the appearance changes, which is the one moment
  // nobody re-reads a stylesheet. OURS is left out because it is mode-independent
  // by construction, and the derived-once names because declaring them once IS
  // the design: their value is computed from a token that is itself per-mode.
  const live = (declarations) => new Set(declarations
    .filter(([name, value]) => LIVE.has(name) && !OURS.has(name) && !DERIVED_ONCE.has(name) && isColour(value))
    .map(([name]) => name));
  const dark = live(DARK);
  const light = live(LIGHT);
  const missing = [...dark].filter((name) => !light.has(name));
  const extra = [...light].filter((name) => !dark.has(name));
  assert.deepStrictEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'the two palette blocks disagree about which live colours they carry',
  );
});
