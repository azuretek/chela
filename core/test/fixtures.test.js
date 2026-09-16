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
import { create, sentence } from '../notices.js';
import {
  clean, clientIdentity, formatBlock, inject, shouldInject, transformFrame,
} from '../prompt-metadata.js';

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

/*
 * The notice model's half of the same contract.
 *
 * The fixtures are a sequence of operations rather than a single call, because
 * the store's rules are about what changes between calls: an id replaces rather
 * than stacks, an identical set reports no change so the banner does not
 * re-render, reading leaves it in the store, and a notice that changes after
 * being read becomes unread again. Each step's return value is asserted as well
 * as the state at the end, since every one of those rules is answered by the
 * boolean rather than by the map.
 */
function applyOp(store, op) {
  switch (op.op) {
    case 'set': return store.set(op.id, op.notice);
    case 'markRead': return store.markRead(op.id);
    case 'markAllRead': return store.markAllRead();
    case 'clear': return store.clear(op.id);
    default: throw new Error(`unknown op in the notices fixture: ${op.op}`);
  }
}

function snapshot(store) {
  const notice = {};
  for (const n of store.list()) {
    notice[n.id] = {
      tone: n.tone,
      message: n.message,
      detail: n.detail,
      dismissible: n.dismissible,
      progress: n.progress,
      action: n.action,
      read: n.read,
    };
  }
  return { size: store.size(), list: store.list().map((n) => n.id), unread: store.unread().map((n) => n.id), notice };
}

/*
 * The client-context block's half of the same contract.
 *
 * The block is what every client puts on every outbound prompt, so its shape is
 * the one thing both clients have to render identically: the same header rule,
 * the same field order, the same value cleaning, and the same two reasons not to
 * inject at all. The script itself is not in this fixture, by design; its one
 * owner is core/spec/prompt-metadata.json, which both clients read.
 */
test('prompt-metadata.clean() reproduces every fixture', () => {
  const { clean: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected clean fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(clean(input), output, `clean(${JSON.stringify(input)}) should be ${JSON.stringify(output)}`);
  }
});

test('prompt-metadata.formatBlock() reproduces every fixture', () => {
  const { block: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected block fixtures');
  for (const { name, metadata, client, output } of cases) {
    assert.strictEqual(
      formatBlock(metadata, client ?? 'desktop'),
      output,
      `${name}: the block disagrees`,
    );
  }
});

test('prompt-metadata.shouldInject() reproduces every fixture', () => {
  const { shouldInject: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected shouldInject fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(shouldInject(input.message), output, `shouldInject(${JSON.stringify(input.message)}) should be ${output}`);
  }
});

test('prompt-metadata.inject() reproduces every fixture', () => {
  const { inject: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected inject fixtures');
  for (const { name, input, output } of cases) {
    assert.strictEqual(inject(input.message, input.block), output, `${name}: inject disagrees`);
  }
});

test('prompt-metadata.transformFrame() reproduces every fixture', () => {
  const { frame: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected frame fixtures');
  for (const { name, input, output } of cases) {
    assert.strictEqual(
      transformFrame(input.data, { enabled: input.enabled, block: input.block, client: input.client ?? 'desktop' }),
      output,
      `${name}: the frame disagrees`,
    );
  }
});

test('prompt-metadata.clientIdentity() reproduces every fixture', () => {
  const { clientIdentity: cases } = load('prompt-metadata.json');
  assert.ok(cases.length > 0, 'expected clientIdentity fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(clientIdentity(input.label, input.version), output, `clientIdentity(${JSON.stringify(input)}) should be ${JSON.stringify(output)}`);
  }
});

test('notices.sentence() reproduces every fixture', () => {
  const { sentence: cases } = load('notices.json');
  assert.ok(cases.length > 0, 'expected sentence fixtures');
  for (const { input, output } of cases) {
    assert.strictEqual(sentence(input), output, `sentence(${JSON.stringify(input)}) should be ${JSON.stringify(output)}`);
  }
});

test('the notice store reproduces every fixture', () => {
  const { store: cases } = load('notices.json');
  assert.ok(cases.length > 0, 'expected notice store fixtures');
  for (const fixture of cases) {
    const store = create();
    const returns = fixture.ops.map((op) => applyOp(store, op));
    assert.deepStrictEqual(returns, fixture.returns, `${fixture.name}: the returns disagree`);
    assert.deepStrictEqual(snapshot(store), fixture.expect, `${fixture.name}: the state disagrees`);
  }
});
