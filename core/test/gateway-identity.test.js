// Whether an address is an OpenClaw gateway, checked in both directions.
//
// A check that only rejects is as broken as one that accepts everything, so both
// directions are asserted here and the fixture set is held to covering both. The
// rule is pure, so this runs with no server and no network: what it exercises is
// the decision, and the clients' own tests are what prove the bytes on the wire
// reach it.
//
// The three things this file exists to catch, all of which have a silent
// version:
//
//   - a check that accepts anything answering, which is what `Test connection`
//     did before this module existed and what put a stranger's page behind the
//     app's chrome;
//   - a check so strict it refuses a gateway we rely on, meaning the throwaway
//     gateway on a spare port and a gateway behind an unusual host, both of which
//     are cases in the fixture set;
//   - a rule written in this module rather than in the spec both clients read,
//     which is the drift the spec exists to prevent.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAYLOAD_ATTRIBUTES, HEALTH_PATH, HEALTH_OK_KEY, HEADER_NAMES, MAX_BYTES,
  PAYLOAD, CORROBORATED, MESSAGES,
  carriesPayloadMarker, probeTargets, identify,
} from '../gateway-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const spec = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'gateway-identity.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'fixtures', 'gateway-identity.json'), 'utf8'));

/* ------------------------------------------------- the spec is the ONE owner */

test('the module exposes what the spec holds, and nothing of its own', () => {
  assert.deepStrictEqual(PAYLOAD_ATTRIBUTES, spec.payloadAttributes);
  assert.strictEqual(HEALTH_PATH, spec.healthPath);
  assert.strictEqual(HEALTH_OK_KEY, spec.healthOkKey);
  assert.deepStrictEqual(HEADER_NAMES, spec.headerNames);
  assert.strictEqual(MAX_BYTES, spec.maxBytes);
  assert.deepStrictEqual(MESSAGES, spec.messages);
});

test('the sentences the reader sees come from the spec, not from this module', () => {
  // The failure this catches is a sentence typed into the code, which agrees with
  // the spec the day it is written and is the copy that goes stale: the phone
  // reads the same spec and would word the same rejection differently.
  const source = fs.readFileSync(path.join(REPO, 'core', 'gateway-identity.js'), 'utf8');
  for (const sentence of Object.values(spec.messages)) {
    const literal = String(sentence).split('{')[0].trim();
    if (literal.length < 20) continue;
    assert.ok(!source.includes(literal), `the module holds its own copy of a spec sentence: ${literal}`);
  }
});

test('the marker is an attribute, so prose about the product cannot claim it', () => {
  // The distinction that makes the required signal worth requiring: a page can
  // say anything at all, and a page that says "OpenClaw" is not a gateway.
  assert.strictEqual(carriesPayloadMarker('<h1>OpenClaw Control UI</h1>'), false);
  assert.strictEqual(carriesPayloadMarker('<html data-openclaw-control-ui-build-id="x">'), true);
  assert.strictEqual(carriesPayloadMarker('<html data-openclaw-control-ui-base-path="">'), true);
  // A dev build's unsubstituted placeholder is still the shell, because presence
  // is what is read and never the version.
  assert.strictEqual(carriesPayloadMarker('<html data-openclaw-control-ui-build-id="__OPENCLAW_CONTROL_UI_BUILD_ID__">'), true);
  assert.strictEqual(carriesPayloadMarker(''), false);
  assert.strictEqual(carriesPayloadMarker(null), false);
});

test('the search is bounded, so an enormous body is not read whole', () => {
  const huge = `${'x'.repeat(MAX_BYTES + 10)}<html data-openclaw-control-ui-build-id="late">`;
  assert.strictEqual(carriesPayloadMarker(huge), false, 'the marker beyond the window must not be found');
  const inside = `${'x'.repeat(64)}<html data-openclaw-control-ui-build-id="early">`;
  assert.strictEqual(carriesPayloadMarker(inside), true);
});

/* --------------------------------------------------------------- the targets */

test('the probe asks the configured address itself, and the health marker', () => {
  const targets = probeTargets('https://example-host:18789/');
  assert.strictEqual(targets.document, 'https://example-host:18789/');
  assert.deepStrictEqual(targets.health, ['https://example-host:18789/healthz']);
});

test('a gateway behind a base path gets its health marker asked for both ways', () => {
  // The unusual-host case: a gateway mounted under a path serves the marker
  // either at the origin root or under its own mount, and the client cannot know
  // which, so both are asked and either answering is enough.
  const targets = probeTargets('https://example-host/example-path/');
  assert.strictEqual(targets.document, 'https://example-host/example-path/');
  assert.deepStrictEqual(targets.health, [
    'https://example-host/healthz',
    'https://example-host/example-path/healthz',
  ]);
});

test('an address that will not parse is handed back as nothing rather than thrown', () => {
  assert.deepStrictEqual(probeTargets('not a url'), { document: null, health: [] });
});

/* -------------------------------------------------------- the two directions */

test('the fixture set covers both directions, or it proves half a rule', () => {
  // A fixture set that only rejected would leave the acceptance path unproven,
  // and one that only accepted is what `Test connection` already was.
  const outcomes = new Set(fixtures.cases.map((c) => c.output.ok));
  assert.ok(outcomes.has(true), 'no fixture is accepted');
  assert.ok(outcomes.has(false), 'no fixture is rejected');
  const strengths = new Set(fixtures.cases.map((c) => c.output.strength).filter(Boolean));
  assert.ok(strengths.has(PAYLOAD) && strengths.has(CORROBORATED),
    `the fixtures must cover both strengths, not just ${[...strengths].join(', ')}`);
  for (const fixture of fixtures.cases) {
    assert.ok(String(fixture.why || '').length > 40, `${fixture.name}: says nothing about why it is a case`);
  }
  assert.ok(fixtures.cases.length >= 10, `only ${fixtures.cases.length} cases`);
});

test('identify() reproduces every fixture', () => {
  for (const fixture of fixtures.cases) {
    const got = identify(fixture.observed);
    assert.strictEqual(got.ok, fixture.output.ok, `${fixture.name}: ok disagrees (${JSON.stringify(got.evidence)})`);
    assert.strictEqual(got.strength, fixture.output.strength, `${fixture.name}: strength disagrees`);
  }
});

test('every accepted case passed on a signal the spec names, not on the status code', () => {
  // The heart of it. Accepted is only ever a consequence of a marker or of the
  // recorded corroboration, never of a 200: the case below is the exact shape the
  // old `Test connection` accepted, and it must be refused.
  const stranger = identify({
    document: { status: 200, contentType: 'text/html', body: '<html><body>Sign in to the network</body></html>' },
    health: null,
    headers: {},
  });
  assert.strictEqual(stranger.ok, false, 'a plain 200 was accepted');

  for (const fixture of fixtures.cases.filter((c) => c.output.ok)) {
    const observed = fixture.observed;
    const marker = carriesPayloadMarker(observed.document && observed.document.body);
    const corroborated = fixture.output.strength === CORROBORATED;
    assert.ok(marker || corroborated, `${fixture.name}: accepted with neither a marker nor corroboration`);
  }
});

test('each named signal alone is refused, so no single claimable one carries the decision', () => {
  const html = { status: 200, contentType: 'text/html', body: '<html><body>hello</body></html>' };
  const health = { status: 200, contentType: 'application/json', body: '{"ok":true,"status":"live"}' };
  const headers = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" };
  assert.strictEqual(identify({ document: html, health, headers: {} }).ok, false, 'health alone was enough');
  assert.strictEqual(identify({ document: html, health: null, headers }).ok, false, 'headers alone were enough');
  assert.strictEqual(identify({ document: html, health, headers: { 'x-frame-options': 'DENY' } }).ok, false,
    'two of three headers were enough');
});

test('what it does NOT protect against is stated where the next reader will look', () => {
  // Named rather than implied, because the shape of a check like this invites the
  // reading that it is a security control, and it is not one.
  const why = spec.why.join(' ');
  for (const claim of ['does not authenticate', 'impersonates', 'not a security']) {
    assert.ok(why.includes(claim), `the spec no longer says it ${claim}`);
  }
  // And the same claim reaches the code the next person edits.
  const source = fs.readFileSync(path.join(REPO, 'core', 'gateway-identity.js'), 'utf8');
  assert.match(source, /not a security/i, 'the module no longer says what this is not');
});

/* ------------------------------------------------------ the cases we rely on */

test('a throwaway gateway is accepted, because it is a case we rely on', () => {
  // Asserted as its own case rather than left inside the fixture loop: a rule
  // that quietly started requiring a credential or a configured gateway would
  // break the testing lane, and the breakage would look like a gateway problem.
  const throwaway = identify({
    document: {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html data-openclaw-control-ui-base-path="" data-openclaw-control-ui-build-id="2026.9.4-release-3a9d69db306c">',
    },
    health: null,
    headers: {},
  });
  assert.strictEqual(throwaway.ok, true);
  assert.strictEqual(throwaway.strength, PAYLOAD);
});

/* ------------------------------------------------------------- the sentences */

test('a rejection names what was seen rather than only that it failed', () => {
  const refused = identify({
    document: { status: 200, contentType: 'text/html', body: '<html><body>hello</body></html>' },
    health: null,
    headers: {},
  });
  assert.deepStrictEqual(refused.evidence, {
    status: 200,
    sawDocument: true,
    payloadMarker: false,
    healthOk: false,
    headersPresent: 0,
    headersExpected: HEADER_NAMES.length,
  });
  assert.match(refused.message, /not an OpenClaw gateway/, 'the reader is not told plainly what happened');
  assert.match(refused.message, /200/, 'the reader is not told what the address actually answered');
  assert.match(refused.message, /nothing was loaded/i, 'the reader is not told that nothing was loaded');
});

test('the weaker acceptance says so in its own sentence', () => {
  const weak = identify({
    document: { status: 401, contentType: 'text/html', body: '<html><body>Sign in</body></html>' },
    health: { status: 200, contentType: 'application/json', body: '{"ok":true,"status":"live"}' },
    headers: { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" },
  });
  assert.strictEqual(weak.strength, CORROBORATED);
  assert.notStrictEqual(weak.message, identify({
    document: { status: 200, contentType: 'text/html', body: '<html data-openclaw-control-ui-build-id="x">' },
    health: null,
    headers: {},
  }).message, 'both accepted paths word themselves identically, so the weaker one is not surfaced');
});

test('an address that never answered is a different sentence from a rejection', () => {
  const silent = identify({ document: null, health: null, headers: {}, error: 'ECONNREFUSED' });
  const refused = identify({
    document: { status: 200, contentType: 'text/html', body: '<html><body>hello</body></html>' },
    health: null,
    headers: {},
  });
  assert.notStrictEqual(silent.message, refused.message,
    'a gateway that is down and an address that is not a gateway are the same sentence');
  assert.match(silent.message, /did not answer|ECONNREFUSED/);
});

test('an errored connect is never narrated as having answered', () => {
  // The self-contradiction fault: a fetch that carried an error used to fill the
  // rejection with "That address did not answer: {reason}" AND "It answered, but
  // nothing it served identifies OpenClaw" in one breath. The errored case now
  // has its own sentence, and neither wording may claim a reply that never came.
  const errored = identify({ document: null, health: null, headers: {}, error: 'ECONNREFUSED' });
  assert.match(errored.message, /ECONNREFUSED/, 'the reason the reader needs is not surfaced');
  assert.doesNotMatch(errored.message, /it answered/i,
    'an address that only errored is still narrated as having answered');

  // The no-document, no-error case is a distinct sentence too, and it must not
  // claim a reply either: nothing answered, so nothing was served.
  const noDocument = identify({ document: null, health: null, headers: {} });
  assert.doesNotMatch(noDocument.message, /it answered/i,
    'a no-document rejection still claims it answered');
  assert.notStrictEqual(errored.message, noDocument.message,
    'the errored and the silent-no-error cases share one sentence again');
});
