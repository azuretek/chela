import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PALETTE, PAPER, BUCKETS, PRIMARY, STEPS, KEY, SECOND_OFFSET, SECOND_ROLES, NEUTRAL,
  hex, lch, fromLch, bucketFor, palettesFor, choose, alternateIconName, spec, inLiftBand, fillsSquare,
} from '../app-icons.js';
import { checkout } from './upstream-classes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hueGap = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

test('the shipped set is STEPS hues round the wheel from the design key, then one neutral pair', () => {
  assert.equal(BUCKETS.length, STEPS + 1);
  assert.equal(BUCKETS.filter((b) => b.primary).length, 1);
  assert.equal(PRIMARY, BUCKETS[0]);
  assert.ok(hueGap(PRIMARY.hue, KEY) < 1e-9, 'the primary icon is not the design key hue');
  BUCKETS.slice(0, STEPS).forEach((b, i) => assert.ok(hueGap(b.hue, KEY + (i * 360) / STEPS) < 1e-9));
  assert.equal(BUCKETS.at(-1).hue, null);
  assert.equal(Math.abs(SECOND_OFFSET), 130);
});

test('hex reads every form a computed accent arrives in', () => {
  assert.equal(hex('rgb(244, 114, 182)'), '#f472b6');
  assert.equal(hex('rgba(244, 114, 182, 0.5)'), '#f472b6');
  assert.equal(hex('rgb(244 114 182)'), '#f472b6');
  assert.equal(hex('#F472B6'), '#f472b6');
  assert.equal(hex('#fff'), '#ffffff');
  assert.equal(hex('oklch(0.7 0.1 350)'), null);
  assert.equal(hex(undefined), null);
});

test('an accent takes the nearest hue, a colourless one the neutral pair, and none the primary', () => {
  for (const b of BUCKETS.slice(0, STEPS)) {
    for (const dh of [-12, 0, 12]) {
      const accent = fromLch(0.68, 0.14, (b.hue + dh + 360) % 360);
      assert.equal(bucketFor(accent).id, b.id, `${accent} did not land on ${b.id}`);
    }
  }
  assert.equal(bucketFor('#808080').id, 'neutral');
  assert.equal(bucketFor('#1f1f1f').id, 'neutral');
  assert.equal(bucketFor(undefined), PRIMARY);
  assert.equal(choose(undefined, undefined).file, `icons/${PRIMARY.id}-dark.png`);
  assert.equal(choose('#808080', 'light').file, 'icons/neutral-light.png');
  assert.equal(choose('#808080', 'light', { full: true }).file, 'icons/neutral-light-full.png');
  assert.equal(fillsSquare('darwin'), false);
  assert.equal(fillsSquare('win32'), true);
  assert.equal(fillsSquare('linux'), true);
  assert.equal(alternateIconName(PRIMARY), null);
  assert.equal(alternateIconName(BUCKETS[3]), `AppIcon-${BUCKETS[3].id}`);
});

test('every role keeps the design lightness, and takes the first or second hue by its role', () => {
  const design = { ...PALETTE, ...PAPER };
  for (const b of BUCKETS.slice(0, STEPS)) {
    const p = palettesFor(b), all = { ...p.dark, ...p.light };
    const second = (b.hue + SECOND_OFFSET + 360) % 360;
    for (const [name, value] of Object.entries(all)) {
      const got = lch(value), want = lch(design[name]);
      const lifted = SECOND_ROLES.has(name) && inLiftBand(second);
      if (!lifted) assert.ok(Math.abs(got.L - want.L) < 0.02, `${b.id} ${name} lightness moved`);
      if (got.C > 0.03) assert.ok(hueGap(got.h, SECOND_ROLES.has(name) ? second : b.hue) < 4, `${b.id} ${name} is not on its hue`);
    }
  }
});

test('the second colour is only an accent: three roles, never the tile', () => {
  assert.deepEqual([...SECOND_ROLES].sort(), ['deep', 'skyBottom', 'violet']);
});

test('the neutral pair has almost no colour', () => {
  const p = palettesFor(BUCKETS.at(-1));
  for (const v of Object.values({ ...p.dark, ...p.light })) assert.ok(lch(v).C < 0.05, `${v} is not neutral`);
});

test('the generated spec matches this module, and every sample is chosen as it says', () => {
  const file = path.join(HERE, '..', 'spec', 'app-icons.json');
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(spec(), null, 2) + '\n', 'core/spec/app-icons.json is stale: run npm run icons');
  const s = spec();
  assert.equal(s.neutralChroma, NEUTRAL.chroma);
  for (const x of s.samples) assert.equal(bucketFor(x.accent).id, x.bucket);
  // A sample must sit well inside its bucket so the Swift mirror, rounding a little
  // differently, still chooses the same one.
  for (const x of s.samples) {
    const { C, h } = lch(x.accent);
    if (C < NEUTRAL.chroma + 0.01) continue;
    const b = BUCKETS.find((y) => y.id === x.bucket);
    assert.ok(hueGap(h, b.hue) < 360 / STEPS / 2 - 2, `${x.accent} sits on a bucket edge`);
  }
});

test('every theme the Control UI checkout declares lands on a bucket near its own hue', (t) => {
  // No theme is named here or in the module: this only checks the rule against
  // whatever the checkout has today, so a theme added upstream is covered too.
  const { dir, present } = checkout();
  const themes = path.join(dir, 'public', 'themes');
  if (!present || !existsSync(themes)) return t.skip(`no Control UI themes at ${themes}`);
  let seen = 0;
  for (const f of readdirSync(themes)) {
    const css = readFileSync(path.join(themes, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/--accent\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      seen += 1;
      const accent = m[1].toLowerCase(), b = bucketFor(accent), { C, h } = lch(accent);
      if (b.hue === null) assert.ok(C < NEUTRAL.chroma, `${f}: ${accent} went neutral`);
      else assert.ok(hueGap(h, b.hue) <= 360 / STEPS / 2 + 1e-9, `${f}: ${accent} is far from its bucket`);
    }
  }
  assert.ok(seen > 0, 'found no accents to check');
});
