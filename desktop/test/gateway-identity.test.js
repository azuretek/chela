// The desktop's half of the gateway identity check, and the half that matters:
// the app must not point a web view at an address it has not identified.
//
// Two of the assertions here are about SOURCE, because the code they are about
// drives Electron windows and cannot be unit-run: the connect path must call the
// identification before it loads anything, and a refusal must not load. The rest
// exercise the shared rule through the module the desktop actually imports, which
// is what makes the desktop's verdict the same verdict the phone reaches.
//
// The live proof, both directions and against a real gateway, is
// scripts/test-gateway-identity.js: it runs the shipped app against a throwaway
// gateway and against a stranger's page and reads the verdict the app itself
// produced. These tests are the ones that run everywhere.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { identify, probeTargets, PAYLOAD, CORROBORATED, MAX_BYTES } from '../../core/gateway-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));

/* ------------------------------------------------- what the app must do */

test('the desktop identifies an address before the web view is pointed at it', () => {
  assert.match(main, /import \* as gatewayIdentity from '\.\.\/\.\.\/core\/gateway-identity\.js'/,
    'main.js does not read the shared identity rule');
  assert.match(main, /async function identifyBeforeConnect\(/, 'there is no identification step before a connect');
  // The ORDER is the requirement, not the presence of both calls: the gate has to
  // run inside loadActiveGateway and only reach the connect once it answers yes.
  const loadBlock = main.match(/function loadActiveGateway\(\)[\s\S]*?\n\}/);
  assert.ok(loadBlock, 'loadActiveGateway is gone');
  assert.match(loadBlock[0], /identifyBeforeConnect\(gw\)/,
    'the connect path does not identify the address first');
  assert.match(loadBlock[0], /beginGatewayConnect\(gw\)/,
    'the connect no longer goes through the identified path');
  const gate = loadBlock[0].indexOf('identifyBeforeConnect(gw)');
  const connect = loadBlock[0].indexOf('beginGatewayConnect(gw)');
  assert.ok(gate >= 0 && connect > gate, 'the connect is reachable without the identification');
});

test('a refusal does not load the address, and says plainly what it is', () => {
  const refusal = main.match(/async function identifyBeforeConnect\(gw\)[\s\S]*?\n\}/);
  assert.ok(refusal, 'identifyBeforeConnect is gone');
  // It must NOT reach the load. `beginGatewayConnect` is the only caller that
  // loads, and this path must not call it.
  assert.doesNotMatch(refusal[0], /beginGatewayConnect|loadURL|startGatewayAttempt/,
    'the refusal path can still load the address it refused');
  // And the reader is told, in the app's own banner, which is where a failure the
  // reader can act on belongs.
  assert.match(refusal[0], /is not an OpenClaw gateway/, 'the refusal says nothing a reader can act on');
  assert.match(refusal[0], /setNotice\('connection'/, 'the refusal does not reach the reader at all');
  assert.match(refusal[0], /connectionState\.FAILED/, 'the connection is not reported as failed');
});

test('the verdict is cached per gateway, so a retry does not re-probe', () => {
  // The pairing cadence reissues the connect every few seconds, so a probe per
  // attempt would be two extra requests against a gateway that is already busy
  // answering them. The cache is keyed by id AND url so an edited address is
  // re-identified rather than trusted.
  assert.match(main, /const identifiedGateways = new Map\(\)/,
    'the identification is not remembered, so every retry re-probes');
  assert.match(main, /function identityKey\(gw\) \{\s*return `\$\{gw\.id\} \$\{gw\.url\}`;/,
    'the cache key does not include the url, so an edited address keeps its old verdict');
  assert.match(main, /function forgetIdentity\(gw\)/, 'there is no way to make a gateway be re-identified');
});

test('the probe reads the body, because the required signal is inside it', () => {
  // A header is the cheapest thing on the wire to copy and the first thing a
  // proxy rewrites; OpenClaw's own marker on <html> is what actually identifies
  // the payload, so the probe cannot discard the body the way it used to.
  assert.match(main, /const PROBE_REDIRECTS = \d+/, 'redirects are not bounded');
  assert.match(main, /gatewayIdentity\.MAX_BYTES/, 'the body read is not bounded by the spec');
  assert.match(main, /body: Buffer\.concat\(chunks\)\.toString\('utf8'\)\.slice\(0, gatewayIdentity\.MAX_BYTES\)/,
    'the probe does not read a bounded body, so the marker cannot be found');
  // And it follows redirects rather than judging them: a gateway behind a proxy
  // that bounces `/` is a real gateway, and its 301 is not an identity.
  assert.match(main, /REDIRECT_CODES\.includes\(res\.statusCode\)[\s\S]{0,400}probeRequest\(next/,
    'a redirect is judged instead of followed, which refuses a real gateway behind a proxy');
});

test('the settings page gets the verdict, not only a "reachable"', () => {
  const testGateway = main.match(/async function testGateway\(rawUrl\)[\s\S]*?\n\}/);
  assert.ok(testGateway, 'testGateway is gone');
  assert.match(testGateway[0], /gatewayIdentity\.identify\(observed\)/, 'Test connection does not identify what answered');
  assert.match(testGateway[0], /identity: \{ accepted: verdict\.ok, strength: verdict\.strength/,
    'the verdict strengths are thrown away, so the weaker acceptance cannot be told apart');
  // The self-signed note survives: it is still the routine state of a gateway on
  // its own listener and the reader still has to be told about it.
  assert.match(testGateway[0], /self-signed/, 'the certificate note was dropped by the identity check');
});

/* --------------------------------- what the shared rule decides, from here */

test('a stranger page is refused with a sentence that names what happened', () => {
  const verdict = identify({
    document: { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>Router</h1></body></html>' },
    health: { status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' },
    headers: { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" },
  });
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.message, /not an OpenClaw gateway/);
  assert.match(verdict.message, /HTTP 200/, 'the reader is not told what the address actually answered');
});

test('a gateway the app relies on is accepted, including a throwaway one', () => {
  // The shape a throwaway gateway actually serves, measured on a spare port with
  // --auth none --allow-unconfigured: the shell, no credential, no configuration.
  const verdict = identify({
    document: {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html data-openclaw-control-ui-base-path="" data-openclaw-control-ui-build-id="2026.9.4-release-3a9d69db306c" lang="en">',
    },
    health: { status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"status":"live"}' },
    headers: {},
  });
  assert.strictEqual(verdict.ok, true, 'the throwaway lane would be refused');
  assert.strictEqual(verdict.strength, PAYLOAD);
});

test('the weaker acceptance is labelled as weaker wherever it is reported', () => {
  const weak = identify({
    document: { status: 401, contentType: 'text/html', body: '<html><body>Sign in</body></html>' },
    health: { status: 200, contentType: 'application/json', body: '{"ok":true,"status":"live"}' },
    headers: { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" },
  });
  assert.strictEqual(weak.strength, CORROBORATED);
  // The desktop logs it where a support question would look.
  assert.match(main, /gatewayIdentity\.CORROBORATED/, 'the weaker acceptance is not told apart from the required one');
  assert.match(main, /accepted on its health marker and headers/, 'the weaker acceptance is logged without saying so');
});

test('the probe asks the address as configured, and the health marker beside it', () => {
  const targets = probeTargets('https://example-host:18789/');
  assert.strictEqual(targets.document, 'https://example-host:18789/');
  assert.ok(targets.health.includes('https://example-host:18789/healthz'));
  assert.ok(MAX_BYTES > 1024, 'the read window is too small to contain an opening tag');
});
