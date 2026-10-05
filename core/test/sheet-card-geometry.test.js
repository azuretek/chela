// The card inside the phone's native sheet: it is the sheet's own surface, top
// aligned and full height, so choosing a shorter tab or moving to About never
// moves the container.
//
// Reported 2026-10-04 (issue #172) from a running build: the About card settled
// well below the Settings card, and the shorter Behaviour tab pulled the Settings
// card's top down with it. The cause is layout, not content. The scrim centres a
// card that is only as tall as its content, so the card's top edge tracks its
// height: measured on a rendered page at a 440x924 phone viewport, the card's top
// read 24 / 155 / 272 for Gateways / Behaviour / About before this rule, and the
// same top and the same full height for all three after it. The rendered half is
// the pull request's probe output; this is the stylesheet's half.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, stripComments } from './upstream-classes.js';

const UI_CSS = fs.readFileSync(path.join(REPO, 'core', 'ui', 'ui.css'), 'utf8');

/** The declarations of a rule anywhere in the sheet, by exact selector. */
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

test('inside the native sheet the card fills the sheet, so its top cannot move', () => {
  const native = ruleBodies(UI_CSS, 'html.surface--native-sheet .scrim').map((b) => property(b, 'align-items')).filter(Boolean);
  assert.deepStrictEqual(native, ['stretch'],
    'the native-sheet scrim must stretch its card so a shorter tab, or About, cannot move its top edge, and reads '
    + JSON.stringify(native));
});

test('a dialog outside a native sheet still centres its card', () => {
  const plain = ruleBodies(UI_CSS, '.scrim').map((b) => property(b, 'align-items')).filter(Boolean);
  assert.deepStrictEqual(plain, ['center'],
    'the shared dialog layout must keep centring its card, and reads ' + JSON.stringify(plain));
});
