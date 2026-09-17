// The Control UI this app was built against, named in About.
//
// Claw wraps OpenClaw's Control UI and depends on it in a pinned way: the
// classes our pages borrow come out of one revision of it (core/spec/upstream-reference.json,
// held there by the guard in core/test/upstream-classes.test.js). Which revision
// that is belongs on About, because it is the first thing anyone debugging a
// rendering problem needs and the one thing nobody can look up after the fact.
//
// The desktop's half is two lines of wiring, and both halves of it are silent
// when they break:
//
//   a version written into main.js      agrees with the pin on the day it is
//                                       typed and keeps agreeing after the pin
//                                       moves, which is the copy that goes stale;
//   a reference the host stops passing  leaves the row undrawn, and a page with
//                                       one fewer line still renders perfectly.
//
// So this reads the two ends rather than the value: main.js must take the
// reference out of the pin, and it must write no version of its own. The RENDERED
// row is checked against the pin in scripts/capture-pages.js, which loads the
// real page and reads the text off the screen.
//
// `src/main.js` is Electron's entry and cannot be imported here, so this reads it
// the way the other desktop tests that reach it do (see dialogs.test.js).
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const REPO = path.join(HERE, '..', '..');

const pin = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'upstream-reference.json'), 'utf8'));

/** main.js with its comments removed, so a quoted version is not read as one. */
function code(file) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

const main = code(path.join(SRC, 'main.js'));

test('the About state takes the Control UI reference out of the pin', () => {
  // The pin is the one owner of which upstream revision our borrowed components
  // came from, so the host reads it rather than deciding it. The import is
  // asserted by path because that IS the arrangement: a second copy of the
  // version, or of the pin, is the thing this file is against.
  assert.match(main, /core\/spec\/upstream-reference\.json/,
    'main.js does not read the pin, so About cannot name the Control UI this build targets');
  assert.match(main, /upstreamReference\.upstream\.version/,
    'main.js does not take the version from the pin');
  assert.match(main, /upstreamReference\.upstream\.commit/,
    'main.js does not take the commit from the pin, so About cannot say which revision it means');
  assert.match(main, /controlUI:\s*\{/,
    'the About state carries no controlUI, which is the key the shared page draws the row from');
});

test('main.js writes no Control UI version of its own', () => {
  // A literal here would pass every other check in this file on the day it was
  // typed, and go on printing the version the pin used to name.
  assert.doesNotMatch(main, /\b20\d\d\.\d+\.\d+\b/,
    'main.js holds a version literal, which is a second copy of what the pin owns');
});

test('the pin records an identity, not just a version', () => {
  // Asserted here as well as in core's guard because this test is the one that
  // reads the pin for the desktop, and a pin that lost its commit would leave the
  // row naming a release rather than the revision it came from.
  assert.match(pin.upstream.version, /^\d+\.\d+\.\d+$/, `no upstream version: ${pin.upstream.version}`);
  assert.match(pin.upstream.commit, /^[0-9a-f]{40}$/, `no upstream commit: ${pin.upstream.commit}`);
});
