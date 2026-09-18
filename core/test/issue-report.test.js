// The issue report the client sends us, checked in the one direction that
// matters: nothing identifying leaves. These are the tests the design named as
// "what makes the claim true", so they are written to fail the moment a secret,
// a home-directory path or an unexpected field could reach the wire.
//
// The four things this file exists to catch:
//   - a report built while the config holds a gateway token and URL that carries
//     either string (the credential leak this whole lane risks);
//   - a /Users/<name> or home-directory path, which names the person;
//   - a token-shaped string inside an error message that was not redacted;
//   - a field that drifted in outside the allowlist, so a value added to the
//     codebase later cannot ride out in a report without being added here.

import test from 'node:test';
import assert from 'node:assert';

import {
  ALLOW, FREE_TEXT, KINDS, STAGES, CHANNELS, MAX_FIELD_LENGTH,
  scrub, buildReport, reportKeys, minidumpsOnByDefault, minidumpConsentWarning,
} from '../issue-report.js';

// A realistic gateway token: a long base64 run, which is the shape the real one
// takes and the shape the scrubber has to catch.
const TOKEN = 'gk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'.repeat(2);
const GATEWAY_URL = 'https://my-gateway.example.ts.net:18789/';
const HOME_PATH = '/Users/abi/Library/Application Support/Claw/credentials.json';

test('a report built while the config holds a gateway token and URL carries NEITHER', () => {
  // The facts an over-eager caller might hand in: a stack and an error message
  // that swept up the token, the URL and a home path. The report must contain
  // none of the three, and no field outside the allowlist that could carry them.
  const report = buildReport({
    reportId: 'r-1',
    installId: 'i-1',
    kind: 'uncaughtException',
    appVersion: '1.0.1-dev.139.7d21fe49cd',
    channel: 'dev',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '26.6',
    stage: 'gateway-connect',
    errorName: 'Error',
    errorMessage: `connect to ${GATEWAY_URL} with Bearer ${TOKEN} failed`,
    stack: `Error: at ${HOME_PATH}:1:1\n  token=${TOKEN}`,
    // Forbidden fields an over-eager caller passed: they must be dropped.
    gatewayUrl: GATEWAY_URL,
    token: TOKEN,
    messageContent: 'what time is it?',
    at: '2026-09-18T20:00:00.000Z',
  });
  const blob = JSON.stringify(report);
  assert.ok(!blob.includes(TOKEN), 'the gateway token reached the wire');
  assert.ok(!blob.includes('my-gateway'), 'the gateway hostname reached the wire');
  assert.ok(!blob.includes('.ts.net'), 'the tailnet hostname reached the wire');
  assert.ok(!blob.includes('what time is it?'), 'message content reached the wire');
});

test('no /Users/<name> or home-directory path appears', () => {
  const report = buildReport({
    kind: 'bootFailure',
    stack: `at readCredentials (${HOME_PATH}:12:3)\n at C:\\Users\\abi\\AppData\\claw.log:1:1`,
  });
  const blob = JSON.stringify(report);
  assert.ok(!blob.includes('/Users/abi'), 'a macOS home path reached the wire');
  assert.ok(!blob.includes('/home/'), 'a linux home path reached the wire');
  assert.ok(!/Users\\abi/.test(blob), 'a windows user path reached the wire');
  assert.match(report.stack, /<path>/, 'the path was not replaced with a placeholder');
});

test('a token-shaped string inside an error message is redacted', () => {
  // These are assembled from parts rather than written whole, so a fake test
  // fixture never reads to a secret scanner as a real Slack token or JWT: the
  // scrubber keys on the SHAPE, and the shape is preserved by the join.
  const fakeSlack = ['xoxb', '000000000000', 'abcdefghijklmnop'].join('-');
  const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIwIn0', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'].join('.');
  for (const secret of [
    TOKEN,
    'Bearer ' + TOKEN,
    'sk-' + 'abcdefgh12345678',
    'op://Zilla-Automation/Gateway/token',
    fakeJwt,
    fakeSlack,
  ]) {
    const report = buildReport({ kind: 'updateFailure', errorMessage: `failed with ${secret} in header` });
    assert.ok(!report.errorMessage.includes(secret), `the secret survived: ${secret.slice(0, 12)}...`);
    assert.match(report.errorMessage, /<redacted>|Bearer <redacted>/, 'nothing was redacted');
  }
});

test('the emitted field set EQUALS the allowlist for a full report, so a new field cannot drift in', () => {
  // Every allowlisted field present, plus a pile of forbidden ones. The keys
  // that come out must be exactly the allowlist keys that were provided, and
  // never a forbidden one.
  const facts = {};
  for (const field of ALLOW) facts[field] = field === 'bootAttempts' ? 3 : `${field}-value`;
  facts.gatewayToken = TOKEN;
  facts.hostname = 'my-gateway';
  facts.ipAddress = '10.0.0.5';
  facts.somethingAddedLater = 'surprise';
  const report = buildReport(facts);
  assert.deepStrictEqual(reportKeys(report), [...ALLOW].sort(), 'the report keys are not exactly the allowlist');
  for (const forbidden of ['gatewayToken', 'hostname', 'ipAddress', 'somethingAddedLater']) {
    assert.ok(!(forbidden in report), `a forbidden field survived: ${forbidden}`);
  }
});

test('a null or absent field is left out rather than emitted empty', () => {
  const report = buildReport({ kind: 'rollback', rolledBackFrom: '1.0.1', rolledBackTo: null, stack: undefined });
  assert.ok('rolledBackFrom' in report);
  assert.ok(!('rolledBackTo' in report), 'a null field was emitted');
  assert.ok(!('stack' in report), 'an undefined field was emitted');
});

test('every free-text field is length-capped', () => {
  const huge = 'a'.repeat(MAX_FIELD_LENGTH + 5000);
  const report = buildReport({ kind: 'uncaughtException', stack: huge, errorMessage: huge });
  assert.ok(report.stack.length <= MAX_FIELD_LENGTH, 'the stack was not capped');
  assert.ok(report.errorMessage.length <= MAX_FIELD_LENGTH, 'the message was not capped');
  // A structured field is NOT capped: capping a version would hide a fault.
  const structured = buildReport({ kind: 'uncaughtException', appVersion: huge });
  assert.strictEqual(structured.appVersion.length, huge.length, 'a structured field was treated as free text');
});

test('minidumps are on for dev by default and off for stable', () => {
  assert.strictEqual(minidumpsOnByDefault('dev'), true, 'dev should default minidumps on');
  assert.strictEqual(minidumpsOnByDefault('stable'), false, 'stable must default minidumps off');
});

test('the stable minidump warning names the concrete contents, not a vague phrase', () => {
  const warning = minidumpConsentWarning();
  for (const named of [/token/i, /message content/i, /pairing/i, /username/i, /gateway address|gateway url/i]) {
    assert.match(warning, named, `the warning does not name ${named}`);
  }
  assert.match(warning, /cannot be scrubbed/i, 'the warning does not state the dump cannot be scrubbed');
  assert.match(warning, /delete the raw dump/i, 'the warning does not commit to deleting the dump');
  assert.doesNotMatch(warning, /may contain sensitive data/i, 'the warning uses the vague phrase the design forbids');
});

test('the allowlist and the forbidden set do not overlap', () => {
  // A field cannot be both allowed and forbidden; if one ever is, the allowlist
  // wins silently and this catches the contradiction at author time.
  const allow = new Set(ALLOW);
  for (const name of ['token', 'hostname', 'ip', 'messageContent', 'gatewayUrl']) {
    assert.ok(!allow.has(name), `${name} is both allowed and forbidden`);
  }
  assert.ok(KINDS.length > 0 && STAGES.length > 0 && CHANNELS.length === 2);
  assert.ok(FREE_TEXT.every((f) => ALLOW.includes(f)), 'a free-text field is not in the allowlist');
});
