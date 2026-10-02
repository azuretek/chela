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

test('About takes the settings card out of the way before it arrives', () => {
  const about = functionBody(MAIN, 'async function openAboutSurface(');
  assert.match(about, /coverBelow\('about'\)[\s\S]{0,120}openOverlay\('about'\)/,
    'the settings card must be out of the way before the About card arrives, or both are on screen at once');
  const close = functionBody(MAIN, 'async function closeOverlay(');
  assert.match(close, /revealBelow\(name\)/, 'closing About must bring the settings card back');
});

test('the interface behind a sheet blurs while a dimming one is up', () => {
  const sync = functionBody(MAIN, 'async function syncSurfaceBehind(');
  assert.match(sync, /DIMMING_OVERLAYS\.some\(/, 'the blur is not tied to the overlays that dim');
  assert.match(MAIN, /const SURFACE_BEHIND_CSS = \[[\s\S]{0,1200}backdrop-filter: blur/, 'the injected stylesheet carries no blur');
  assert.match(functionBody(MAIN, 'function openOverlay('), /syncSurfaceBehind\(\)/, 'opening a sheet never raises the blur behind it');
  assert.match(functionBody(MAIN, 'async function closeOverlay('), /syncSurfaceBehind\(\)/, 'closing a sheet never drops the blur behind it');
});
/**
 * The real syncSurfaceBehind and forgetSurfaceBehind, run against a fake page.
 *
 * The document is simulated rather than composited: insertCSS records which
 * document it landed in, and a navigation starts a new one that holds nothing,
 * which is the shape the real Electron WebContents has.
 */
function behindHarness() {
  const source = [
    'const SURFACE_BEHIND_CSS = "html::before{backdrop-filter:blur(14px)}";',
    'const DIMMING_OVERLAYS = ["settings", "about"];',
    'async function syncSurfaceBehind() {' + functionBody(MAIN, 'async function syncSurfaceBehind(') + '}',
    'function forgetSurfaceBehind(wc) {' + functionBody(MAIN, 'function forgetSurfaceBehind(') + '}',
    'return { syncSurfaceBehind, forgetSurfaceBehind };',
  ].join('\n');
  return new Function('page', 'overlayAlive', 'behindCssKeys', 'console', source);
}

/** A page with one document, replaced on navigation, as Electron has. */
function fakePage() {
  return {
    id: 7,
    document: 'first',
    inserts: [],
    isDestroyed() { return false; },
    async insertCSS(css) {
      const key = 'key-' + this.inserts.length;
      this.inserts.push({ key, document: this.document, css });
      return key;
    },
    async executeJavaScript() {},
  };
}

test('a reload re-inserts the surface-behind stylesheet instead of trusting the stale key', async () => {
  const behindCssKeys = new Map();
  const fake = fakePage();
  const overlays = ['settings'];
  const { syncSurfaceBehind, forgetSurfaceBehind } = behindHarness()(
    () => fake,
    (name) => overlays.includes(name),
    behindCssKeys,
    { warn() {} },
  );

  await syncSurfaceBehind();
  assert.equal(fake.inserts.length, 1, 'the first sheet did not insert the blur stylesheet');
  assert.equal(behindCssKeys.get(fake.id), 'key-0', 'the first insert was not recorded');

  // A reload: a new document, and the host's did-navigate forgets the old key.
  // With the stale key left in place the next sheet flips its class against a
  // stylesheet the new document never received -- the blur gone after a reload.
  fake.document = 'second';
  forgetSurfaceBehind(fake);
  // The re-sync is fire-and-forget (the host is in an event handler), so let its
  // insert settle before reading the map back.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.inserts.length, 2, 'the stylesheet was not re-inserted for the reloaded document');
  assert.equal(fake.inserts[1].document, 'second', 'the second insert did not land in the new document');
  assert.equal(behindCssKeys.get(fake.id), 'key-1', 'the map still names the old document key');

  // And the stale key really is what used to skip the insert: with one planted,
  // a sync for an open sheet adds nothing.
  behindCssKeys.set(fake.id, 'stale');
  await syncSurfaceBehind();
  assert.equal(fake.inserts.length, 2, 'a stale key must still skip the insert, or this test is not about the key');
});

test('the host forgets the behind stylesheet on a committed navigation and on teardown', () => {
  assert.match(MAIN, /did-navigate[\s\S]{0,240}forgetSurfaceBehind\(wc\)/, 'a navigation never forgets the document-scoped stylesheet');
  assert.match(functionBody(MAIN, 'function destroyGatewayView('), /behindCssKeys\.delete\(/, 'a discarded view leaves a stale behind key behind');
});

