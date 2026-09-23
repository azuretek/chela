import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { THEMES, PRIMARY, hex, themeForAccent, choose, iconFile, alternateIconName } from '../app-icons.js';
import { checkout } from './upstream-classes.js';

test('the spec has exactly one primary theme, and ids and accents are unique', () => {
  assert.equal(THEMES.filter((t) => t.primary).length, 1);
  assert.equal(PRIMARY.id, 'claw');
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  const accents = THEMES.flatMap((t) => [t.dark, t.light]);
  assert.equal(new Set(accents).size, accents.length, 'two themes share an accent, so one of them could never be recognised');
  for (const a of accents) assert.match(a, /^#[0-9a-f]{6}$/, `${a} is not lowercase #rrggbb`);
});

test('hex reads every form a computed accent arrives in', () => {
  assert.equal(hex('rgb(244, 114, 182)'), '#f472b6');
  assert.equal(hex('rgba(244, 114, 182, 0.5)'), '#f472b6');
  assert.equal(hex('rgb(244 114 182)'), '#f472b6');
  assert.equal(hex('#F472B6'), '#f472b6');
  assert.equal(hex('#fff'), '#ffffff');
  assert.equal(hex('oklch(0.7 0.1 350)'), null);
  assert.equal(hex('rgb(300, 0, 0)'), null);
  assert.equal(hex(undefined), null);
});

test('a theme is recognised by its accent in either mode', () => {
  assert.equal(themeForAccent('rgb(90, 182, 216)').id, 'tide');
  assert.equal(themeForAccent('rgb(31, 111, 143)').id, 'tide');
  assert.equal(themeForAccent('rgb(1, 2, 3)'), null);
});

test('choose picks neon for dark, paper for light, and the primary icon for a custom palette', () => {
  assert.deepEqual(choose('rgb(90, 182, 216)', 'dark'), { theme: themeForAccent('#5ab6d8'), mode: 'dark', file: 'icons/tide-dark.png' });
  assert.equal(choose('rgb(31, 111, 143)', 'light').file, 'icons/tide-light.png');
  assert.equal(choose('rgb(1, 2, 3)', 'light').file, iconFile('claw', 'light'));
  assert.equal(choose(undefined, undefined).file, 'icons/claw-dark.png');
  assert.equal(alternateIconName(PRIMARY), null);
  assert.equal(alternateIconName(themeForAccent('#5ab6d8')), 'AppIcon-tide');
});

test('the accents are still the ones the Control UI checkout declares', (t) => {
  const { dir, present } = checkout();
  if (!present) return t.skip(`no Control UI checkout at ${dir}`);
  const declared = {};
  const themes = path.join(dir, 'public', 'themes');
  if (!existsSync(themes)) return t.skip(`no themes directory at ${themes}`);
  for (const t2 of THEMES.filter((x) => !x.primary)) {
    const css = readFileSync(path.join(themes, `${t2.id === 'openknot' ? 'knot' : t2.id}.css`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [name, mode] of [[t2.id, 'dark'], [`${t2.id}-light`, 'light']]) {
      const bodies = [...css.matchAll(new RegExp(`\\[data-theme="${name}"\\][^{]*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
      const accent = (bodies.match(/--accent\s*:\s*([^;]+);/) || [])[1];
      declared[`${t2.id}/${mode}`] = accent && accent.trim().toLowerCase();
    }
  }
  for (const t2 of THEMES.filter((x) => !x.primary)) {
    assert.equal(declared[`${t2.id}/dark`], t2.dark, `${t2.id}'s dark accent moved upstream: update spec/app-icons.json and run npm run icons`);
    assert.equal(declared[`${t2.id}/light`], t2.light, `${t2.id}'s light accent moved upstream: update spec/app-icons.json and run npm run icons`);
  }
  const base = readFileSync(path.join(dir, 'src', 'styles', 'base.css'), 'utf8');
  assert.ok(base.includes(`--accent: ${PRIMARY.dark};`), 'the default theme\'s dark accent moved upstream');
  assert.ok(base.includes(`--accent: ${PRIMARY.light};`), 'the default theme\'s light accent moved upstream');
});
