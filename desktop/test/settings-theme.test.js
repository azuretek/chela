// The theme relay, and the guard that measures it.
//
// Reported 2026-09-17, the second time this page's colours have gone wrong: "the
// settings page somehow lost its theme, it's using the default dark". The cause
// was a hole in the LIVE TOKEN ALLOWLIST, not a stray colour: the app filters what
// a Control UI may hand over through core/spec/tokens.json's `live` list, and the
// build being run predated `--card` and `--bg-elevated` being in it. The settings
// GROUPS are drawn on `--card`, so every group was ui.css's copy of the Control
// UI's DEFAULT dark card inside a window wearing the reader's own palette.
//
// The file-level half of that is guarded in core/test/live-tokens.test.js, which
// compares the two LISTS. That was not enough, and this file holds the parts that
// were not:
//
//   1. the relay resolved the palette but said nothing when it could not, so a
//      fallback and a fault looked identical from outside;
//   2. a name exported from chrome.js but left out of its DEFAULT export is
//      undefined at every call site in main.js, which is an uncaught TypeError on
//      every theme report rather than a missing log line. That was written into
//      this very change and caught by measuring the app rather than by reading it;
//   3. the PAGE was never measured, which is where the fault is visible at all.
//      scripts/test-settings-theme.js is that measurement: it serves a palette,
//      opens the real settings surface, and requires every colour ui.css declares
//      to come back as the published value, in both appearances, plus a stated
//      fallback when nothing resolves. The tests below hold that harness to those
//      claims, because a harness that quietly stopped comparing would go on
//      printing OK.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const main = read(DESKTOP, 'src', 'main.js');
const chrome = read(DESKTOP, 'src', 'chrome.js');
const harness = read(DESKTOP, 'scripts', 'test-settings-theme.js');
const spec = JSON.parse(read(REPO, 'core', 'spec', 'tokens.json'));

test('every name the app reaches for on the default chrome export is exported', () => {
  // A name exported by declaration and left out of the default object is
  // undefined where main.js uses it, and main.js imports the default. That is not
  // a missing log line: the throw happens inside an ipcMain listener, so it is an
  // uncaught exception in the main process, which Electron reports with a modal
  // dialog and which blocks the app until someone dismisses it. Measured on
  // 2026-09-17: the app stopped booting, with one line in its log and nothing on
  // stderr, and the stack only appeared once uncaughtException was hooked.
  const block = /export default \{([\s\S]*?)\n\};/.exec(chrome);
  assert.ok(block, 'chrome.js no longer has a default export this test can read');
  const members = new Set(block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line)));
  // A file path in a comment or a string ("src/chrome.js") matches this pattern
  // too, and names 'js' rather than anything the app calls, so those extensions
  // are dropped rather than counted as a missing export.
  const EXTENSIONS = new Set(['js', 'cjs', 'mjs', 'ts']);
  const reached = new Set([...main.matchAll(/chrome\.([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1])
    .filter((name) => !EXTENSIONS.has(name)));
  const missing = [...reached].filter((name) => !members.has(name));
  assert.deepStrictEqual(missing, [],
    'main.js calls chrome.<name> for these names, which the default export does not carry: ' + missing.join(', '));
});

test('the app STATES a palette it could not resolve, rather than falling back in silence', () => {
  // The reported symptom IS the silent fallback: ui.css's own palette is a
  // perfectly good dark one, so a page wearing it looks deliberate. What makes the
  // difference is that the app says which palette is in force and why a report was
  // refused, which is what the harness asserts in its no-palette case.
  assert.match(chrome, /export function themeRefusal\(report\)/,
    'nothing names the reason a report could not be turned into a theme');
  assert.match(main, /no resolved palette, so our pages are using their own/,
    'the app no longer says it is painting from its own fallback palette');
  assert.match(main, /refusing this report because/,
    'a refused report is silent again, so a fault and a fallback look identical');
  // And the refusal is real rather than decorative: the handler returns, so an
  // unusable report cannot be adopted by the code below it.
  const handler = /ipcMain\.on\('chrome:theme'[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(handler, 'the chrome:theme handler is no longer readable here');
  assert.match(handler[0], /if \(chrome\.themeRefusal\(report\)\) \{[\s\S]*?return;\s*\}/,
    'an unusable report is no longer refused before it is parsed into a theme');
});

test('the settings surface is measured against a published palette, in both appearances', () => {
  // The measurement itself. Both appearances are required: against the DEFAULT
  // palette a page that ignored the live theme looks correct, which is how this
  // went unnoticed the first time, and a single-appearance check sails past it.
  assert.match(harness, /--appearance light\|dark/, 'the harness no longer takes an appearance');
  assert.match(harness, /const CASE = flag\('case', 'palette'\)/, 'the harness no longer has cases');
  for (const name of ["'palette'", "'none'", "'switch'"]) {
    assert.ok(harness.includes(name), 'the harness no longer covers the ' + name + ' case');
  }
  // It reads the two lists from their ONE owner rather than restating them: the
  // live list is what the app filters through, and the owned names are what must
  // NOT be taken from the page.
  assert.match(harness, /SPEC\.live\.tokens/, 'the harness restates the live list instead of reading it');
  assert.match(harness, /SPEC\.live\.ours/, 'the harness does not read the names ui.css owns');
  assert.ok(Array.isArray(spec.live.ours) && spec.live.ours.length >= 4,
    'the spec no longer states which palette names are ours, so a hole cannot be told from a decision');
  // Every declared colour is compared, and the comparison is against the PUBLISHED
  // value rather than against the stylesheet: the fault was a name that never
  // arrived, and "differs from what I declared" is not that claim.
  assert.match(harness, /every colour ui.css declares comes from the published palette/,
    'the harness no longer makes the claim this file is about');
  assert.match(harness, /and its group surfaces from the palette/,
    'the harness no longer checks the surface the reported fault was on');
  // And the fallback case is a stated one, which is the other half of the fix.
  assert.match(harness, /the app states that no palette resolved/,
    'the no-palette case no longer requires the app to say so');
});
