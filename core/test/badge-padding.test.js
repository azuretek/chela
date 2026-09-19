// The connection-state pill's own box: the green CONNECTED mark on a gateway row,
// and its warn/err/muted siblings. Reported 2026-09-18 (Abi) as "the padding on
// the green connected-status text", a pill whose caps floated in a line box
// inherited from the body's 1.55 leading while its 2px vertical padding could not
// balance it and its 8px flanks read tight against a full-radius end.
//
// This is a source guard rather than a render one on purpose: the fault is the
// declared box, not a computed accident, and the box is what a reader edits back.
// The rendered proof is desktop/scripts/measure-badge.mjs and the capture-pages
// shots, which show the pill centred on the action buttons' line; here the claim
// is that the .badge rule declares a line box sized to its glyph and padding even
// enough to read as a pill, so a later edit that puts the loose leading back fails
// the one place somebody still knows why it was tightened.
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

/** The declarations inside the first rule matching a selector, comments stripped. */
function ruleBody(css, selector) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp('(^|[},])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{');
  const m = re.exec(withoutComments);
  assert.ok(m, `ui.css has no ${selector} rule`);
  const open = withoutComments.indexOf('{', m.index);
  return withoutComments.slice(open + 1, withoutComments.indexOf('}', open));
}

/** One declared property's value inside a rule body, or null. */
function prop(body, name) {
  const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)').exec(body);
  return m ? m[1].trim() : null;
}

const BADGE = ruleBody(UI_CSS, '.badge');

test('the badge declares a line box sized to its own glyph, not the body leading', () => {
  // 1, exactly, rather than the inherited 1.55: a caps pill is one line and its
  // box should be that line. Inheriting the body's leading is the fault reported,
  // because it is what left the caps floating with air the vertical padding could
  // not balance.
  assert.strictEqual(prop(BADGE, 'line-height'), '1',
    'the badge no longer pins its line box to its glyph, so it inherits the body leading again');
});

test('the badge pads evenly enough to read as a pill', () => {
  const padding = prop(BADGE, 'padding');
  assert.ok(padding, 'the badge declares no padding at all');
  const parts = padding.split(/\s+/).map((p) => parseFloat(p));
  assert.strictEqual(parts.length, 2, `the badge padding is not a block/inline pair: "${padding}"`);
  const [block, inline] = parts;
  // The vertical padding was 2px against a 16px line box, which is the cramp. It
  // has to grow, and stay in proportion to the inline flank so the pill is not
  // taller than it is padded at the ends.
  assert.ok(block >= 3, `the badge's block padding is ${block}px, still the cramped value`);
  assert.ok(inline >= block, `the badge's inline padding (${inline}px) is tighter than its block padding (${block}px), so the pill is taller than its ends are open`);
});

test('the badge centres its single line rather than pinning it to the top', () => {
  // inline-flex + align-items:center is what puts the pill on the action buttons'
  // line rather than at the top of the row: a caps mark shorter than the buttons
  // beside it has to be centred against them, not baseline-aligned to a taller box.
  assert.match(prop(BADGE, 'display') || '', /inline-flex/,
    'the badge is not an inline-flex box, so it cannot centre its line against the taller controls beside it');
  assert.match(prop(BADGE, 'align-items') || '', /center/,
    'the badge does not centre its content on the cross axis');
});
