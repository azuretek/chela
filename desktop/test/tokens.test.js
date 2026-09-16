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
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { MODES, TONES, stylesheet, values, resolve, toneColours } from '../src/tokens.js';
import * as chrome from '../src/chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'src', 'ui');
const BANNER_CSS = fs.readFileSync(path.join(UI, 'banner.css'), 'utf8');
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
