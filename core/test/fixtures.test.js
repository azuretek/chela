// Parity tests: the JS reproduces every golden fixture exactly.
//
// These are the contract a Swift port proves itself against. The fixtures in
// core/fixtures/ are input/output pairs generated from this JS, and both this
// test and the iOS client's Swift tests assert the same pairs, so "the two
// clients agree" is a thing that is checked rather than hoped for. If a spec
// value changes, regenerate the fixtures and both sides move together.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { percent } from '../progress.js';
import { reason, status } from '../connection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

test('progress.percent() reproduces every fixture', () => {
  const { cases } = load('progress.json');
  assert.ok(cases.length > 0, 'expected progress fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(
      percent(input),
      output,
      `percent(${JSON.stringify(input)}) should be ${output}`,
    );
  }
});

test('connection.reason() reproduces every fixture', () => {
  const { reason: cases } = load('connection.json');
  assert.ok(cases.length > 0, 'expected reason fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(
      reason(input.error),
      output,
      `reason(${JSON.stringify(input.error)}) should be ${JSON.stringify(output)}`,
    );
  }
});

test('connection.status() reproduces every fixture', () => {
  const { status: cases } = load('connection.json');
  assert.ok(cases.length > 0, 'expected status fixtures');
  for (const { input, output } of cases) {
    assert.deepStrictEqual(
      status(input),
      output,
      `status(${JSON.stringify(input)}) should be ${JSON.stringify(output)}`,
    );
  }
});
