// The dim behind Settings and About: the Control UI stays visible under a
// translucent dim rather than washing into the page colour.
//
// Reported 2026-09-25: "the control ui sort of flickers into the background color
// as the settings/about us pages slide up". The scrim was --bg at 70%, so as it
// faded in with the sheet the interface behind it faded into the page colour. The
// dim is now the Control UI's own mobile nav drawer backdrop, so opening a sheet
// dims the interface the way opening its drawer does.
//
// What is asserted here is the stylesheet's half, which is every client's half:
//   1. The dim is black at 44% in both appearance blocks, and matches the drawer
//      backdrop upstream declares when the OpenClaw checkout is readable.
//   2. A sheet still fades its dim in and out with the slide (the animation is
//      core/test/motion.test.js's claim; the colour is this one's).
//   3. The page-as-window case keeps the opaque page colour: nothing is behind it.
//   4. A second sheet over the first draws no dim of its own, and inside the
//      phone's native sheet the page draws none either, because the platform does.
//
// The pixels are desktop/scripts/test-settings-backdrop.js, and the host's half
// (who is told it is stacked) is desktop/test/settings-backdrop.test.js.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, checkout, topLevelRules, stripComments } from './upstream-classes.js';

const UI_CSS = fs.readFileSync(path.join(REPO, 'core', 'ui', 'ui.css'), 'utf8');
const SURFACE_JS = fs.readFileSync(path.join(REPO, 'core', 'ui', 'surface.js'), 'utf8');

/** The drawer backdrop's colour, as upstream declares it. */
const DIM = 'rgb(0 0 0 / 44%)';

/** Every value a custom property is given, in source order, comments removed. */
function declarations(css, name) {
  const found = [];
  const re = new RegExp('(?:^|[;{\\s])' + name.replace(/-/g, '\\-') + '\\s*:\\s*([^;}]+)', 'g');
  for (const m of stripComments(css).matchAll(re)) found.push(m[1].trim());
  return found;
}

/** The declarations of a rule anywhere in the sheet (nested included), by exact selector. */
function ruleBodies(css, selector) {
  const src = stripComments(css);
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) bodies.push(m[2]);
  }
  return bodies;
}

const property = (body, name) => {
  const m = body.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
};

test('the dim is the drawer backdrop, black at 44%, in both appearances', () => {
  const values = declarations(UI_CSS, '--scrim');
  assert.deepStrictEqual(values, [DIM, DIM],
    'the scrim must be declared once per appearance block as ' + DIM + ', and reads ' + JSON.stringify(values)
    + '. A value derived from --bg is the wash that faded the Control UI into the page colour.');
});

test('the dim matches the Control UI drawer backdrop upstream declares', (t) => {
  const where = checkout();
  const file = path.join(where.dir, 'src', 'styles', 'layout.mobile.css');
  if (!where.present || !fs.existsSync(file)) {
    t.skip('no OpenClaw checkout at ' + where.source + ', so the recorded value stands unverified');
    return;
  }
  const rule = topLevelRules(fs.readFileSync(file, 'utf8'))
    .find((r) => r.selector.replace(/\s+/g, ' ').trim() === '.shell--mobile-nav .shell-nav-backdrop');
  assert.ok(rule, 'upstream no longer declares .shell--mobile-nav .shell-nav-backdrop, so the dim has lost its reference');
  assert.equal(property(rule.body, 'background'), DIM,
    'upstream now paints its drawer backdrop differently, so the two dims no longer match');
});

test('a sheet dims with the scrim, and the page-as-window keeps its page colour', () => {
  const scrim = ruleBodies(UI_CSS, '.scrim').map((b) => property(b, 'background')).filter(Boolean);
  assert.deepStrictEqual(scrim, ['var(--scrim)'], 'the scrim paints something other than the dim: ' + JSON.stringify(scrim));
  const asPage = ruleBodies(UI_CSS, 'body.as-page .scrim').map((b) => property(b, 'background')).filter(Boolean);
  assert.deepStrictEqual(asPage, ['var(--bg)'],
    'Settings as the whole window has nothing behind it, so it must stay on the opaque page colour');
});

test('a sheet over a sheet keeps one dim, and the native sheet draws none of its own', () => {
  const stacked = ruleBodies(UI_CSS, 'html.surface--stacked .scrim').map((b) => property(b, 'background'));
  assert.deepStrictEqual(stacked, ['transparent'], 'About over Settings would stack a second dim on the first');
  const native = ruleBodies(UI_CSS, 'html.surface--native-sheet body:not(.as-page) .scrim').map((b) => property(b, 'background'));
  assert.deepStrictEqual(native, ['transparent'],
    'inside the phone sheet a dim of ours would darken the sheet around the card; the platform already dims behind it');
  // Read by the shared page script, before first paint, from the URL the host gives.
  assert.match(SURFACE_JS, /has\('stacked'\)[\s\S]{0,200}classList\.add\('surface--stacked'\)/,
    'ui/surface.js no longer marks a stacked surface, so the host saying so changes nothing');
  const markAt = SURFACE_JS.indexOf("classList.add('surface--stacked')");
  const surfaceObject = SURFACE_JS.indexOf('window.clawSurface = {');
  assert.ok(markAt > 0 && markAt < surfaceObject, 'the stacked mark must run as the script loads, not on a later call');
});
