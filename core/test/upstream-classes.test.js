// The classes our pages borrow from the Control UI, and the guard that keeps the
// borrowing honest. The card values the notice banner borrows from the same card
// are held to the same pin further down.
//
// The failure this exists for is silent in both directions:
//
//   upstream renames or redeclares one  our markup keeps the old name, the rule
//                                     it resolved to is gone, and the element
//                                     renders unstyled rather than erroring. A
//                                     content-hashed stylesheet cannot be
//                                     imported, so nothing else can notice.
//   we edit our copy                 ui.css holds a copy of each declaration. A
//                                     hand-edit there is invisible in a diff of
//                                     the page and renders as a slightly
//                                     different control forever.
//
// So the pin records each class and its declarations, our stylesheet is held to
// the pin, and the checkout, when it is readable, is held to the pin as well.
// Both checks are needed: the first catches drift HERE, and only the second can
// see a rename UPSTREAM.
//
// On where this lives. `cd core && npm test` is the only suite that runs it, and
// that suite is not a CI gate (release.yml runs desktop/test, and the mobile
// pipeline runs xcodebuild). That is deliberate rather than incidental: the live
// half needs the OpenClaw checkout, and a release runner has none, so leaving
// this out of CI is what keeps a rename guard from blocking a release. The cost
// is that the guard is only as current as the machine it runs on, which is
// stated in the test itself rather than assumed.
//
// Run with: cd core && npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  PIN, REPO, checkout, normalizeDeclarations, readPin, ruleBody, uiSources,
} from './upstream-classes.js';

const pin = readPin();
const uiCss = fs.readFileSync(path.join(REPO, 'core', 'ui', 'ui.css'), 'utf8');
const tokensSpec = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'tokens.json'), 'utf8'));
const sources = uiSources();
const uiText = sources.map((s) => s.text).join('\n');

/** Where a class name is used by our own pages, as file names. */
function usedIn(name) {
  return sources.filter((s) => s.text.includes(name)).map((s) => s.file);
}

/** The value a `card.dismiss.size`-style path names in the token spec. */
function valueAt(path) {
  let node = tokensSpec;
  for (const step of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(step in node)) {
      throw new Error(`tokens.json has no ${path}`);
    }
    node = node[step];
  }
  return node;
}

/**
 * Is `value` a standalone value inside `declaration`, rather than part of a
 * longer one?
 *
 * Plain containment would pass on the wrong thing: a spec recording `8px` would
 * read as present in a rule that declares `18px`, so the guard would report a
 * drift it had just failed to see. A value boundary on both sides is what makes
 * the check about the value.
 */
function declares(declaration, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(declaration);
}

test('the pin describes a reference at all', () => {
  // A pin that lost its classes would turn every assertion below into one that
  // cannot fail, which is the failure mode a file like this has.
  assert.ok(pin.classes.length >= 15, `only ${pin.classes.length} pinned classes`);
  assert.equal(pin.upstream.repo, 'openclaw');
  assert.equal(pin.upstream.package, 'ui');
  assert.match(pin.upstream.version, /^\d+\.\d+\.\d+$/, `no upstream version: ${pin.upstream.version}`);
  assert.ok(pin.upstream.checkout.includes('CLAW_OPENCLAW_UI'),
    'the pin does not say how the checkout is located, so the guard below cannot be reproduced');
  assert.equal(pin.upstream.readOnly, true, 'the pin does not say the checkout is read-only');
});

test('every pinned class is complete, and named once per selector', () => {
  for (const entry of pin.classes) {
    for (const field of ['name', 'selector', 'file', 'component', 'rule', 'replaces', 'why']) {
      assert.equal(typeof entry[field], 'string', `${entry.selector || '?'} has no ${field}`);
      assert.ok(entry[field].length > 2, `${entry.selector}.${field} is empty`);
    }
    assert.ok(entry.selector.startsWith('.'), `${entry.selector} is not a class selector`);
    assert.match(entry.file, /^src\/styles\/[\w-]+\.css$/, `${entry.selector} names a file outside ui/src/styles`);
    assert.match(entry.component, /^src\/(components|pages)\/[\w-]+\.ts$/,
      `${entry.selector} names no upstream component, so where to look for a rename is unrecorded`);
    assert.ok(entry.rule.endsWith(';'), `${entry.selector} rule is not a declaration list`);
  }
  const selectors = pin.classes.map((e) => e.selector);
  assert.equal(new Set(selectors).size, selectors.length, 'a selector is pinned twice');
});

test('every pinned class is one our own pages actually use', () => {
  // The other direction, and the one that keeps the pin about THIS repo: a class
  // recorded here but used nowhere is a rule we would be checking for no reason,
  // and it reads as a claim that we adopt it.
  for (const entry of pin.classes) {
    const files = usedIn(entry.name);
    assert.ok(files.length > 0, `${entry.name} is pinned but nothing in core/ui uses it`);
  }
  // And the one class that must be on both surfaces, since the whole report was
  // that the About page had no way back: a pin entry that only ever landed on
  // one page would pass everything above.
  const back = usedIn('settings-sidebar__back');
  assert.ok(back.includes('settings.html'), `the back control is not in settings.html: ${back.join(', ')}`);
  assert.ok(back.includes('about.html'), `the back control is not in about.html: ${back.join(', ')}`);
});

test('our stylesheet declares exactly what the pin records', () => {
  // The local half. `local` is the escape for a declaration of our own that a
  // page shape forces, and it is a list rather than a free hand: whatever it
  // holds is asserted here too, so it cannot grow quietly.
  for (const entry of pin.classes) {
    const ours = ruleBody(uiCss, entry.selector);
    assert.notStrictEqual(ours, null, `ui.css has no rule for ${entry.selector}`);
    const local = entry.local || [];
    const expected = normalizeDeclarations(`${entry.rule} ${local.join('; ')}`);
    assert.equal(normalizeDeclarations(ours), expected,
      `ui.css's ${entry.selector} is not the pinned declaration list`);
  }
});

test('the pin is the only place a borrowed declaration is written down', () => {
  // A pinned declaration list copied to a SECOND selector in ui.css is the drift
  // this file exists to prevent, one indirection further out: the copy would keep
  // rendering after the pinned rule was corrected. Compared as whole declaration
  // lists rather than property by property, because every hover rule in the sheet
  // mentions `background` and `color` and that is not a copy of anything.
  const declared = [...uiCss.matchAll(/^([^{}@/][^{}]*)\{([^}]*)\}/gm)]
    .map(([, selector, body]) => ({ selector: selector.trim(), decls: normalizeDeclarations(body) }));
  for (const entry of pin.classes) {
    const expected = normalizeDeclarations(entry.rule);
    const copies = declared.filter((r) => r.decls === expected && !r.selector.includes(entry.selector));
    assert.deepStrictEqual(copies.map((c) => c.selector), [],
      `${entry.selector}'s declaration list is also declared by another rule`);
  }
});

test('the checkout still declares every pinned class', () => {
  const { dir, present, source } = checkout();
  // Loud rather than skipped. A guard that quietly does not run is the same
  // thing as no guard, and this one is the only thing that can see a rename.
  assert.ok(present,
    `the upstream class pin cannot be verified: no OpenClaw checkout at ${dir} (from ${source}). `
    + 'Set CLAW_OPENCLAW_UI to its ui/ directory, or run this suite on a host that has the checkout.');
  assert.match(pin.upstream.checkout, /checkout/);

  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8'));
    return cache.get(rel);
  };

  for (const entry of pin.classes) {
    const body = ruleBody(read(entry.file), entry.selector);
    assert.notStrictEqual(body, null,
      `${entry.selector} is gone from upstream ${entry.file} (pinned at ${pin.upstream.version}): `
      + 'a rename upstream leaves our markup matching nothing, so update the pin and our markup together');
    assert.equal(normalizeDeclarations(body).replace(/\s+/g, ' '), entry.rule.replace(/\s+/g, ' '),
      `${entry.selector} still exists in upstream ${entry.file} but no longer declares what was pinned: `
      + 're-read the rule, then update the pin and ui.css in the same commit');
  }
});

test('the checkout is the version the pin names', () => {
  // Not a failure condition on its own, which is why it is a separate test: a
  // checkout ahead of the pin means the guard above is checking a version this
  // repo has not been reconciled with, and that is worth saying out loud.
  const { dir, present } = checkout();
  assert.ok(present, 'no checkout to read a version from');
  const version = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')).version;
  assert.equal(version, pin.upstream.version,
    `the checkout is OpenClaw ${version} and the pin says ${pin.upstream.version}: `
    + 're-run the pin and reconcile any class upstream moved');
});

/* ------------------------------------------------------ the banner's half */

// The notice banner is a strip over someone else's page rather than a panel in a
// sidebar, so it borrows the card's MEASUREMENTS and not its markup. Same two
// ends, same failure to catch: the spec records a value with a provenance, and
// nothing until this test compared the two.
//
// Measured on 2026-09-16 against the checkout: two of those recorded values had
// drifted from the rules they cite. The card surface was recorded as
// --bg-elevated where the floating chrome it was taken from mixes --panel, which
// is a different colour in the light theme; and the row gap was recorded as 12px
// where the summary row it cites is 8px. Both rendered happily.

test('the pinned card values describe a reference at all', () => {
  assert.ok(pin.values.length >= 15, `only ${pin.values.length} pinned card values`);
  assert.ok(pin.ours.length >= 2, 'nothing is recorded as deliberately ours, so the unverifiable ones read as verified');
});

test('every pinned card value is complete and resolves in the token spec', () => {
  for (const entry of pin.values) {
    for (const field of ['path', 'file', 'selector', 'property', 'expect', 'why']) {
      assert.equal(typeof entry[field], 'string', `${entry.path || '?'} has no ${field}`);
      assert.ok(entry[field].length > 1, `${entry.path}.${field} is empty`);
    }
    assert.match(entry.file, /^src\/styles\/[\w-]+\.css$/, `${entry.path} names a file outside ui/src/styles`);
    // The path is the whole point of the local half: it is where the value the
    // banner paints with actually lives, so an entry pointing at nothing would be
    // a value checked from one side only.
    assert.ok(valueAt(entry.path) !== undefined, `tokens.json has no ${entry.path}`);
  }
  // And no `ours` entry may restate a pinned path: a value that is both verified
  // and claimed as ours has two answers.
  for (const note of pin.ours) {
    for (const entry of pin.values) {
      assert.ok(!note.startsWith(`${entry.path} `),
        `${entry.path} is pinned and also listed as ours`);
    }
  }
});

test('the banner still draws the card values upstream declares', () => {
  // The LOCAL half, and the one that failed first: the value in the token spec is
  // what the banner paints with, so a spec that has drifted from the rule it cites
  // is a banner that looks different from the card it is a copy of.
  for (const entry of pin.values) {
    const value = String(valueAt(entry.path));
    assert.ok(declares(entry.expect, value),
      `tokens.json's ${entry.path} is ${value}, which is not the value upstream declares for `
      + `${entry.selector} ${entry.property} (${entry.expect})`);
  }
});

test('the checkout still declares every pinned card value', () => {
  const { dir, present } = checkout();
  assert.ok(present, `the card value pin cannot be verified: no OpenClaw checkout at ${dir}`);
  const cache = new Map();
  for (const entry of pin.values) {
    if (!cache.has(entry.file)) cache.set(entry.file, fs.readFileSync(path.join(dir, entry.file), 'utf8'));
    const body = ruleBody(cache.get(entry.file), entry.selector);
    assert.notStrictEqual(body, null,
      `${entry.selector} is gone from upstream ${entry.file}: the banner's ${entry.path} cites a rule that `
      + 'no longer exists, so re-read the card and update the pin and tokens.json together');
    const decls = normalizeDeclarations(body).split(';').map((d) => d.trim()).filter(Boolean);
    const found = decls.find((d) => d.slice(0, d.indexOf(':')).trim() === entry.property);
    assert.ok(found, `${entry.selector} no longer declares ${entry.property} in upstream ${entry.file}`);
    const value = found.slice(found.indexOf(':') + 1).trim();
    assert.equal(value, entry.expect,
      `${entry.selector} ${entry.property} is now ${value} and was pinned as ${entry.expect}: `
      + 're-read the card, then update the pin and tokens.json in the same commit');
  }
});
