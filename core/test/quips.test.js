// The line under the loading bar, as core owns it.
//
// Two things here can actually break something: a list that runs out leaves the
// last line frozen, which is the appearance of the hang this exists to disprove;
// and a line that reads as a real status message is a lie told next to a real
// progress bar. Both are properties of the data in spec/quips.json, so they are
// asserted here at the source rather than only in each client.

import test from 'node:test';
import assert from 'node:assert';

import { QUIPS, ROTATE_MS, quipAt, startAt } from '../quips.js';

test('there are enough lines that a wait does not repeat itself quickly', () => {
  assert.ok(QUIPS.length >= 12, `only ${QUIPS.length} lines`);
  assert.equal(new Set(QUIPS).size, QUIPS.length, 'the list repeats itself');
});

test('the rotation wraps rather than running out', () => {
  const first = quipAt(0);
  assert.equal(quipAt(QUIPS.length), first);
  assert.equal(quipAt(QUIPS.length * 7), first);
  for (const step of [0, 1, 5, 99, 1e6]) {
    assert.ok(QUIPS.includes(quipAt(step)), `step ${step} produced nothing`);
  }
});

test('a fractional step is floored, so the wall clock can drive it', () => {
  assert.equal(quipAt(2.9), quipAt(2));
});

test('the offset shifts the whole sequence without skipping a line', () => {
  const shifted = QUIPS.map((_, i) => quipAt(i, 3));
  assert.equal(new Set(shifted).size, QUIPS.length, 'an offset run misses lines');
});

test('a negative or oversized step still lands on a real line', () => {
  for (const step of [-1, -50, Number.MAX_SAFE_INTEGER]) {
    assert.ok(QUIPS.includes(quipAt(step)), `step ${step} fell off the list`);
  }
});

test('startAt stays inside the list for any seed', () => {
  for (const seed of [0, 0.5, 0.999999, 1, -0.3]) {
    const at = startAt(seed);
    assert.ok(Number.isInteger(at) && at >= 0 && at < QUIPS.length, `seed ${seed} gave ${at}`);
  }
});

test('no line claims to describe a step the app is performing', () => {
  const forbidden = /\b(verif|authent|connect|download|load|handshak|resolv|retry|error|fail)/i;
  for (const line of QUIPS) {
    assert.doesNotMatch(line, forbidden, `"${line}" reads as a status message`);
  }
});

test('the lines are short enough for one row at the narrowest window', () => {
  for (const line of QUIPS) {
    assert.ok(line.length <= 48, `"${line}" is ${line.length} characters`);
  }
});

test('the rotation is slow enough to read and fast enough to move', () => {
  assert.ok(ROTATE_MS >= 2000 && ROTATE_MS <= 6000, `${ROTATE_MS}ms`);
});
