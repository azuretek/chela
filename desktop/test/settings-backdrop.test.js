// The host's half of the dim behind Settings and About: one dim however many of
// our sheets are up.
//
// The stylesheet's half, and the report this answers, is core/test/backdrop.test.js.
// What only the host can get wrong is WHO is told they are stacked: each sheet is
// its own view with its own scrim, so About opened over Settings painted a second
// dim over the first and the Control UI went nearly black. The page cannot know
// what is under it, so the host says so in the URL, and when the surface that
// held the dim leaves, the one still up takes the dim over.
//
// The pixels are desktop/scripts/test-settings-backdrop.js.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

/** A top-level function's body, by its opening line, skipping the parameter list. */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature + ' is gone from the source');
  let depth = 0;
  let i = source.indexOf('(', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') { depth -= 1; if (depth === 0) break; }
  }
  const open = source.indexOf('{', i);
  depth = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') { depth -= 1; if (depth === 0) return source.slice(open + 1, j); }
  }
  assert.fail(signature + ' has an unbalanced body');
}

/**
 * Run the host's stacking decision against a stubbed set of open overlays.
 *
 * The real functions, lifted from main.js, so the claim is about the code that
 * ships rather than a restatement of it.
 */
function stackingWith(open) {
  const source = [
    MAIN.match(/const DIMMING_OVERLAYS = \[[^\]]*\];/)[0],
    'function dimmedBelow(name) {' + functionBody(MAIN, 'function dimmedBelow(') + '}',
    'function stackedSearch(name, search) {' + functionBody(MAIN, 'function stackedSearch(') + '}',
    'return stackedSearch;',
  ].join('\n');
  const overlayAlive = (name) => open.includes(name);
  return new Function('overlayAlive', 'URLSearchParams', source)(overlayAlive, URLSearchParams);
}

test('About opened over Settings is told a dim is already up, and nothing else is', () => {
  const overSettings = stackingWith(['settings']);
  assert.equal(new URLSearchParams(overSettings('about', '?frameless=1')).get('stacked'), '1',
    'About over Settings draws a second dim over the first');
  assert.equal(new URLSearchParams(overSettings('about', '?frameless=1')).get('frameless'), '1',
    'the stacked mark replaced the rest of the URL instead of joining it');
  const alone = stackingWith([]);
  assert.equal(new URLSearchParams(alone('about', '?frameless=1')).has('stacked'), false,
    'About on its own must dim the window itself');
  assert.equal(new URLSearchParams(alone('settings', '?frameless=1')).has('stacked'), false,
    'Settings on its own must dim the window itself');
  // Settings opened while About is up lands on top of it, over About's dim.
  assert.equal(new URLSearchParams(stackingWith(['about'])('settings', '?')).get('stacked'), '1');
  // Pairing draws no scrim, so it neither dims nor is told about a dim.
  assert.equal(new URLSearchParams(stackingWith(['settings'])('pairing', '?')).has('stacked'), false);
  assert.equal(new URLSearchParams(stackingWith(['pairing'])('about', '?')).has('stacked'), false,
    'the pairing screen has no scrim, so a surface over it must bring its own dim');
});

test('every overlay page is loaded through the stacking decision', () => {
  const open = functionBody(MAIN, 'function openOverlay(');
  assert.match(open, /loadFile\([^;]*search: stackedSearch\(name,/,
    'openOverlay loads its page without asking whether a dim is already up');
});

test('the surface left up takes the dim over when the one under it leaves', () => {
  const close = functionBody(MAIN, 'async function closeOverlay(');
  assert.match(close, /DIMMING_OVERLAYS[\s\S]*classList\.remove\('surface--stacked'\)/,
    'closing Settings under About would leave the window undimmed behind the About card');
});
