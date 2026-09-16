// The design tokens our chrome draws with, and the banner stylesheet that must
// hold nothing but their names.
//
// Two failures are worth a test rather than a comment, because neither shows up
// in a screenshot of a working banner:
//
// - A colour hardcoded back into banner.css. It would render identically today
//   and stop following the token file silently, which is exactly the drift the
//   single-owner arrangement exists to prevent.
// - A tone the notice model can raise that the stylesheet never styles. The
//   banner draws a class per tone, so a tone added to spec/notices.json with no
//   rule behind it arrives as a card with no stripe at all, which reads as a
//   styling choice rather than as a missing rule.
//
// The same two claims are made about the LOADING cover at the end of this file,
// for the same reason and one more: it is the first surface the app ever paints,
// so a palette of its own there is not a slow repaint somewhere, it is the app
// changing colour as it starts.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { MODES, TONES, stylesheet, values, resolve, toneColours } from '../src/tokens.js';
import * as chrome from '../src/chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', '..', 'core', 'ui');
const BANNER_CSS = fs.readFileSync(path.join(UI, 'banner.css'), 'utf8');
const UI_CSS = fs.readFileSync(path.join(UI, 'ui.css'), 'utf8');
const MAIN_JS = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
const NOTICES_SPEC = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', '..', 'core', 'spec', 'notices.json'), 'utf8',
));

/** Every custom property the token layer emits, as source. */
const EMITTED = new Set();
{
  // The names come from the sheet itself rather than from a second list here,
  // so a token added to the spec is covered without this test being edited.
  for (const [, name] of stylesheet().matchAll(/(--[\w-]+):/g)) EMITTED.add(name);
}

/** Every `var(--name)` a stylesheet reads. */
function referenced(css) {
  return new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
}

/** Every custom property a stylesheet declares. */
function declared(css) {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

function cssBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.notStrictEqual(start, -1, `banner.css has no ${selector} rule`);
  const open = css.indexOf('{', start);
  return css.slice(open, css.indexOf('}', open));
}

test('every colour token is a colour the browser can parse, in both modes', () => {
  for (const mode of MODES) {
    const all = values(mode);
    const colours = Object.entries(all).filter(([name]) => !name.startsWith('--radius') && !name.startsWith('--shadow') && !name.startsWith('--ease') && !name.startsWith('--duration'));
    assert.ok(colours.length > 20, `expected a full palette in ${mode}, got ${colours.length} names`);
    for (const [name, value] of colours) {
      assert.match(value, /^#[0-9a-f]{6}$|^rgba?\([\d.,\s]+\)$/i, `${mode} ${name} is not a colour: ${value}`);
    }
  }
});

test('both modes define exactly the same names', () => {
  // A token present in one mode and missing from the other is a card that loses
  // a colour when the appearance changes, which is the one moment nobody
  // re-reads a stylesheet.
  assert.deepStrictEqual(Object.keys(values('light')).sort(), Object.keys(values('dark')).sort());
});

test('the stylesheet carries both modes and every tone', () => {
  const sheet = stylesheet();
  assert.match(sheet, /prefers-color-scheme: light/, 'the light mode is not behind the media query');
  assert.ok(sheet.includes(`${values('dark')['--bg']} !important`), 'the dark background is missing or not important');
  for (const tone of TONES) {
    assert.ok(sheet.includes(`--notice-tone-${tone}-edge:`), `no edge emitted for the ${tone} tone`);
    assert.ok(sheet.includes(`--notice-tone-${tone}-tint:`), `no tint emitted for the ${tone} tone`);
  }
});

test('the tones are the notice model\'s four, named from one place', () => {
  assert.deepStrictEqual([...TONES].sort(), Object.keys(NOTICES_SPEC.tones).sort());
  assert.deepStrictEqual([...TONES].sort(), Object.keys(NOTICES_SPEC.rank).sort());
});

test('every tone the model can raise has a rule in the banner stylesheet', () => {
  for (const tone of Object.keys(NOTICES_SPEC.tones)) {
    assert.ok(
      BANNER_CSS.includes(`.banner--${tone}`),
      `.banner--${tone} is not styled, so a ${tone} notice draws a card with no tone`,
    );
  }
  // And nothing else does, so a rule for a tone that cannot be raised is a
  // stylesheet describing a client nobody ships.
  const styled = [...BANNER_CSS.matchAll(/\.banner--([\w-]+)/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'enter');
  assert.deepStrictEqual([...new Set(styled)].sort(), Object.keys(NOTICES_SPEC.tones).sort());
});

test('the banner stylesheet hardcodes no colour', () => {
  const literals = [...BANNER_CSS.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/gi)].map((m) => m[0]);
  assert.deepStrictEqual(literals, [], `banner.css holds colours of its own: ${literals.join(', ')}`);
});

test('every token the banner stylesheet reads is one the token layer emits', () => {
  // The other half of the single-owner claim: banner.css naming a property
  // nothing defines renders as an unstyled card, and CSS reports no error for a
  // custom property that does not exist. The tone pair is the one name the
  // stylesheet sets for itself, from a rule per tone, so it counts as declared.
  const live = new Set(chrome.THEME_TOKENS.map(([name]) => name));
  const ours = declared(BANNER_CSS);
  for (const name of referenced(BANNER_CSS)) {
    assert.ok(
      EMITTED.has(name) || live.has(name) || ours.has(name),
      `${name} is read by banner.css but emitted by neither the token layer nor the live theme`,
    );
  }
  // And the one name it sets for itself is the tone pair the token layer emits
  // a variant of per tone, not an arbitrary property: a stylesheet that declares
  // its own colours would pass the loop above on a technicality.
  for (const name of ours) {
    assert.ok(
      EMITTED.has(name) || name === '--notice-tone-edge' || name === '--notice-tone-tint',
      `${name} is declared by banner.css and is not a token the layer emits`,
    );
  }
});

test('the card surface and the four tone edges are all different colours', () => {
  // A tone that resolves to the card's own surface is a stripe nobody can see,
  // which is what an info tone pointed at --accent or --border used to be.
  for (const mode of MODES) {
    const surface = resolve('--bg-elevated', mode);
    const seen = new Map();
    for (const tone of TONES) {
      const { edge } = toneColours(tone, mode);
      assert.notStrictEqual(edge, surface, `${mode}: the ${tone} edge is the card's own surface`);
      assert.ok(!seen.has(edge), `${mode}: ${tone} and ${seen.get(edge)} share one colour, so they are one tone`);
      seen.set(edge, tone);
    }
  }
});

test('resolve follows a token defined as another token, and refuses the unknown', () => {
  assert.strictEqual(resolve('--danger', 'dark'), '#f87171');
  assert.strictEqual(resolve('var(--danger)', 'dark'), '#f87171');
  assert.strictEqual(resolve('--danger', 'light'), '#b91c1c');
  assert.strictEqual(resolve('--nowhere', 'dark'), null);
  assert.strictEqual(resolve('--card', 'middle'), null, 'an unknown mode is not a mode');
});

test('the card geometry names tokens rather than repeating their values', () => {
  // The shape half of the file is emitted from spec/tokens.json, so the sheet
  // resolves it to a var() rather than to a second copy of a number.
  const sheet = stylesheet();
  assert.match(cssBlock(sheet, ':root'), /--notice-radius: var\(--radius-lg\)/);
  assert.match(cssBlock(sheet, ':root'), /--notice-surface: var\(--bg-elevated\)/);
  assert.match(cssBlock(sheet, ':root'), /--notice-blur: 10px/);
});

/* ------------------------------------------------------- the loading cover */

/** The loading cover's slice of ui.css, from its own rule to the next section. */
function loadingSection() {
  const start = UI_CSS.indexOf('--------------------------------------------------------------- loading */');
  assert.notStrictEqual(start, -1, 'ui.css has no loading section');
  const end = UI_CSS.indexOf('--------------------------------------------------------------- pairing */', start);
  assert.notStrictEqual(end, -1, 'the loading section has no end marker');
  return UI_CSS.slice(start, end);
}

test('the loading cover hardcodes no colour of its own', () => {
  // This is the colour flip Abi reported: the cover is the FIRST thing painted,
  // so a literal here is not a slow repaint somewhere, it is the app starting
  // in one appearance and arriving in another. Every colour it draws with has
  // to be a token the shared layer owns, which is what lets the host resolve the
  // appearance for it instead of the stylesheet deciding one.
  const section = loadingSection();
  const literals = [...section.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/gi)].map((m) => m[0]);
  assert.deepStrictEqual(literals, [], `ui.css's loading section holds colours of its own: ${literals.join(', ')}`);
});

test('every token the loading cover reads is one the token layer emits', () => {
  // The cover is handed BOTH sheets now (the token layer, then the live theme),
  // so a name it reads that neither defines renders as an unstyled cover rather
  // than as a loud error: CSS reports nothing for a custom property that does
  // not exist. The body rule is included because that is what paints the whole
  // surface behind the cover.
  const live = new Set(chrome.THEME_TOKENS.map(([name]) => name));
  const read = new Set([...referenced(loadingSection()), ...referenced(cssBlock(UI_CSS, 'html, body'))]);
  assert.ok(read.size > 4, `expected the cover to draw from several tokens, found ${read.size}`);
  for (const name of read) {
    assert.ok(
      EMITTED.has(name) || live.has(name),
      `${name} is read by the loading cover but emitted by neither the token layer nor the live theme`,
    );
  }
});

test('the cover is styled before the window is revealed, and revealed even if styling fails', () => {
  // The sequencing IS the fix, and it is invisible in every other check: an
  // async insert that lands after the reveal looks exactly like one that landed
  // before it in any screenshot taken once the app has settled. So the wiring is
  // asserted here, by name, the way the overlay paths are in dialogs.test.js.
  const style = /async function styleLoadingCover\(wc\) \{([\s\S]*?)\n\}/.exec(MAIN_JS);
  assert.ok(style, 'styleLoadingCover is not in main.js');
  const body = style[1];
  assert.ok(
    body.indexOf('applyTokenCss(wc)') !== -1 && body.indexOf('applyTokenCss(wc)') < body.indexOf('applyThemeCss(wc)'),
    'the token layer must be inserted before the live theme',
  );
  // Awaiting both, and outside the try, so a throw inside cannot skip the
  // reveal: a cover nobody reveals is an app that never appears.
  assert.match(body, /\n\s*coverStyled = true;\n\s*revealMainWindow\(\);/, 'the reveal must follow the styling');
  assert.ok(/try \{[\s\S]*\} catch \{[\s\S]*\}\s*coverStyled = true;/.test(body),
    'a failed insert must still reach the reveal');

  // And the cover is wired to that path, on the event that precedes the first
  // paint, rather than to did-finish-load, which is after it.
  const cover = /wc\.once\('dom-ready', \(\) => \{ void styleLoadingCover\(wc\); \}\)/.test(MAIN_JS);
  assert.ok(cover, 'the loading view is not styled on dom-ready');
  assert.ok(!/wc\.once\('did-finish-load', \(\) => applyThemeCss\(wc\)\);\n\s*\/\/ The cover is usually/.test(MAIN_JS),
    "the cover still themes itself on did-finish-load, which is after its first paint");

  // The reveal waits, and the wait cannot outlive the cover: a guard with no
  // exit is a window that never opens.
  const reveal = /function revealMainWindow\(\) \{([\s\S]*?)\n\}/.exec(MAIN_JS);
  assert.ok(reveal, 'revealMainWindow is not in main.js');
  assert.match(reveal[1], /if \(loadingView && !coverStyled\) return;/, 'the reveal does not wait for the cover');
  const hide = /function hideLoadingCover\(\) \{([\s\S]*?)\n\}/.exec(MAIN_JS);
  assert.ok(hide, 'hideLoadingCover is not in main.js');
  assert.match(hide[1], /loadingView = null;\s*\n\s*coverStyled = true;/, 'hiding the cover must release the reveal');
});
