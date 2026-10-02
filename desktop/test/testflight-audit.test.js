// The one-line rule the TestFlight audit asserts, held to fixtures.
//
// scripts/release/testflight-audit.mjs reports the builds on TestFlight that are not
// on the line the repository is publishing. The report is worth reading only if it is
// right about which line that is, and the case that decides it is the one measured on
// 2026-10-01: the line moved DOWN from 1.0.1 to 0.0.1, so a rule that ranked the
// builds themselves would have kept the 91 stranded ones and called the one current
// build the stray. The line is an input here for exactly that reason.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';

import { groupByLine, expiryBody, publishedLine } from '../../scripts/release/testflight-audit.mjs';

const build = (marketing, number, { expired = false } = {}) => ({
  id: 'id-' + marketing + '-' + number,
  marketing,
  build: number,
  expired,
  uploadedDate: '2026-09-15T19:21:46-07:00',
});

test('every live build on the line is clean', () => {
  const r = groupByLine([build('0.0.1', '375'), build('0.0.1', '376')], '0.0.1');
  assert.equal(r.line, '0.0.1');
  assert.equal(r.lives, 2);
  assert.deepEqual(r.strays, []);
});

test('the 2026-10-01 shape: the line moved down, and the old line is stranded', () => {
  const r = groupByLine([
    build('0.0.1', '375'),
    build('1.0.1', '368'),
    build('1.0.1', '367'),
    build('1.0.1', '366'),
  ], '0.0.1');
  assert.deepEqual(r.strays.map((b) => b.build), ['368', '367', '366']);
  assert.deepEqual(r.lines, [
    { marketing: '0.0.1', live: 1, expired: 0 },
    { marketing: '1.0.1', live: 3, expired: 0 },
  ]);
});

test('the same record once the old line is expired is clean', () => {
  const r = groupByLine([
    build('0.0.1', '375'),
    build('1.0.1', '368', { expired: true }),
    build('1.0.1', '367', { expired: true }),
  ], '0.0.1');
  assert.deepEqual(r.strays, []);
  assert.equal(r.expired, 2);
  assert.equal(r.lives, 1);
});

test('a live build BELOW the line is stranded too', () => {
  const r = groupByLine([build('1.0.1', '368'), build('0.0.1', '375')], '1.0.1');
  assert.deepEqual(r.strays.map((b) => b.marketing), ['0.0.1']);
});

test('an expired build is never stranded, whatever line it is on', () => {
  const r = groupByLine([build('0.0.1', '375'), build('1.0.1', '368', { expired: true })], '0.0.1');
  assert.deepEqual(r.strays, []);
});

test('no live build at all is not a stray', () => {
  const r = groupByLine([build('1.0.1', '368', { expired: true })], '0.0.1');
  assert.equal(r.lives, 0);
  assert.deepEqual(r.strays, []);
});

test('a marketing version that is not one is reported, never thrown', () => {
  const r = groupByLine([build('0.0.1', '375'), build('not-a-version', '376')], '0.0.1');
  assert.equal(r.unknown.length, 1);
  assert.deepEqual(r.strays, []);
});

test('a line that is not a version is a fault', () => {
  assert.throws(() => groupByLine([build('0.0.1', '375')], 'main'), /not a version line/);
});

test('the publishing line is the newest tag, with the v it is written with stripped', () => {
  const run = () => JSON.stringify([{ tagName: 'v0.0.1-dev.375.f67b6c3219' }]);
  assert.deepEqual(publishedLine(run), { line: '0.0.1', tag: 'v0.0.1-dev.375.f67b6c3219' });
});

test('no published release is a fault, not an empty audit', () => {
  assert.throws(() => publishedLine(() => JSON.stringify([])), /no published release/);
});

test('a newest tag that is not a version is a fault', () => {
  assert.throws(() => publishedLine(() => JSON.stringify([{ tagName: 'nightly' }])), /does not name a version/);
});
test('the expiry body is the one the web session takes', () => {
  assert.deepEqual(expiryBody('abc'), { data: { type: 'builds', id: 'abc', attributes: { expired: true } } });
});
