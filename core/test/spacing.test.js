// Spacing, from the fourth rule in ui/CONVENTIONS.md.
//
// The fault this pins, reported 2026-09-17 in the phone's About sheet: the fact
// table follows the cached-code card at no gap at all, so the table sat hard under
// the card's own edge while the two cards above it were spaced. The rule that
// existed asked whether the block BELOW a card was itself a card, and the table is
// not one, so the question never reached it.
//
// The rule is read from the stylesheet rather than restated here, because its value
// is a token: a second copy of 12px in a test is a copy that drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'ui');
const css = readFileSync(path.join(UI, 'ui.css'), 'utf8');
const html = readFileSync(path.join(UI, 'about.html'), 'utf8');

test('the spacing scale is the one the rules name', () => {
  const scale = [...css.matchAll(/--space-(\d): (\d+)px;/g)].map((m) => Number(m[2]));
  assert.deepEqual(scale, [4, 8, 12, 16, 20, 24, 32, 40],
    'the scale changed, so every rule that names it changed with it');
});

test('the card gap is one value, and it covers the block BELOW as well as the card', () => {
  assert.match(
    css,
    /:where\(\.settings-group \+ \*, :not\(\.settings-group\) \+ \.settings-group\) \{ margin-top: var\(--space-3\); \}/,
    'a block that follows a card takes no gap again',
  );
});

test('the card gap cannot displace a block that asks for spacing of its own', () => {
  // :where() is the whole of that guarantee, so it is asserted rather than assumed:
  // written as an ordinary sibling rule this has a specificity of its own and
  // silently flattens the heading margins and the settings footer.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ownerRules = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /margin-top: var\(--space-3\)/.test(m[2]) && /settings-group/.test(m[1]));
  assert.equal(ownerRules.length, 1, 'more than one rule owns the card gap');
  assert.match(ownerRules[0][1].trim(), /^:where\(/, 'the card gap is an assignment rather than a fallback');
});

test('the About fact table is a block the rule reaches', () => {
  const group = html.indexOf('id="clear-cache-group"');
  const facts = html.indexOf('<div id="facts"></div>');
  assert.ok(group > 0, 'the cached-code card is gone');
  assert.ok(facts > group, 'the fact table is not after the cached-code card');
  // Siblings inside .modal__body: nothing wraps the table between it and the card,
  // which is what makes the card + anything rule match it.
  assert.match(html.slice(group, facts), /<\/div>\s*\n\s*<!-- Filled in by about\.js/,
    "the fact table is no longer the card's next sibling, so the gap rule cannot reach it");
});


test('the About header mark is placed from the tokens, not a number of its own', () => {
  // Reported on 1.0.1-dev.358: the mark sat left of the cards below it and 25px
  // off its name. Where it lands is measured on the rendered page (AboutLayoutTests
  // on the phone, desktop/scripts/test-about-surface.js on the desktop); this pins
  // that the two values it rests on stay derived, so a change to the body's
  // padding or the row's inset moves the mark with the cards.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const headline = /\.modal__headline \{([^}]*)\}/.exec(bare);
  assert.ok(headline, 'the header row rule is gone');
  assert.match(headline[1], /margin-left: calc\(var\(--modal-body-inline\) \+ 1px \+ var\(--space-4\) - 12px\);/,
    'the mark is no longer inset by the body padding, the card border and the row inset');
  assert.match(headline[1], /gap: calc\(var\(--space-3\) - 9px\);/,
    'the mark to the name is no longer --space-3');
  assert.match(bare, /\.modal__body \{[^}]*padding: 16px var\(--modal-body-inline\) var\(--modal-body-inline\);/,
    'the body pads with something other than the value the header lines up against');
});
