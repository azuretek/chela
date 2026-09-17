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
import { nextPhase, reason, status } from '../connection.js';
import { create, sentence } from '../notices.js';
import {
  blank, activeGateway, addGateway, updateGateway, removeGateway, trustCert,
} from '../config-model.js';
import { withTokenHandoff } from '../gateway-url.js';
import * as updates from '../updates.js';
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
 * The phase moves, which are the other half of what a row shows: a phase is
 * only ever reached through one of these, so a move that is wrong here is a row
 * that says the wrong thing however good the copy above is.
 *
 * The two that matter most are the ones that HOLD `pending`. A device waiting
 * for approval is reconnected every few seconds on purpose, and each attempt
 * moves this state twice, so a `connect` or a `connected` that dropped the
 * phase would make the row flicker once per retry, which is the shape of bug
 * this reducer exists to prevent.
 */
test('connection.nextPhase() reproduces every phase fixture', () => {
  const { phase: cases } = load('connection.json');
  assert.ok(cases.length > 0, 'expected phase fixtures');
  for (const { name, from, event, to } of cases) {
    assert.strictEqual(nextPhase(from, event), to, name);
  }
});

test('a retry while pending never surfaces, in any order it can arrive', () => {
  const { sequence: cases } = load('connection.json');
  assert.ok(cases.length > 0, 'expected sequence fixtures');
  for (const { name, from, events, phases, never } of cases) {
    let at = from;
    const seen = [];
    for (const event of events) {
      at = nextPhase(at, event);
      seen.push(at);
      for (const banned of never || []) {
        assert.notStrictEqual(at, banned, `${name}: reached ${banned} after ${JSON.stringify(event)}`);
      }
    }
    assert.deepStrictEqual(seen, phases, name);
  }
});

test('the pending copy comes from the spec rather than a literal in the row', () => {
  const spec = JSON.parse(readFileSync(path.join(HERE, '..', 'spec', 'connection.json'), 'utf8'));
  const row = status({ isActive: true, phase: 'pending' });
  assert.strictEqual(row.label, spec.pendingLabel);
  assert.strictEqual(row.detail, spec.pendingDetail);
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
    // The store's own answer to what a card's X means, which is the rule the
    // download card turns on: a dismissClears notice leaves the store and anything
    // else is read. In the fixture so both clients agree about which act a closed
    // card performed, rather than each deciding at its own call site.
    case 'dismiss': return store.dismiss(op.id);
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

/*
 * The gateway config model's half of the same contract.
 *
 * The desktop keeps its config in a file and the phone keeps its own in
 * UserDefaults, and what has to be identical is the model between the two: a
 * phone that disagreed about what removing the active gateway does, or about
 * whether an unknown id is an error, would be a drift bug that only shows up as
 * a list that moved on one device.
 *
 * The ids are supplied by the fixture rather than generated, because a generated
 * id cannot be compared between two ports, and the ops are a sequence rather than
 * a single call because most of these rules are about what the NEXT call sees.
 */

/** A config from a fixture's seed, with the platform's defaults left out. */
function seeded(seed) {
  return {
    ...blank({ suggestedGateways: [], uuid: () => 'unused' }),
    gateways: seed.gateways,
    activeGatewayId: seed.activeGatewayId ?? null,
    trustedCerts: seed.trustedCerts ?? {},
  };
}

function applyConfigOp(cfg, op) {
  switch (op.op) {
    case 'add': return addGateway(cfg, { label: op.label, url: op.url }, () => op.id).config;
    case 'update': return updateGateway(cfg, op.id, op.patch);
    case 'remove': return removeGateway(cfg, op.id);
    // The pointer is set directly: choosing a gateway is the caller's decision,
    // and the model has no rule about it beyond what removing one does.
    case 'active': return { ...cfg, activeGatewayId: op.id };
    case 'trustCert': return trustCert(cfg, op.host, op.fingerprint);
    default: throw new Error(`unknown op in the config-model fixture: ${op.op}`);
  }
}

function configSnapshot(cfg) {
  return {
    gateways: cfg.gateways.map((g) => ({ id: g.id, label: g.label, url: g.url })),
    activeGatewayId: cfg.activeGatewayId ?? null,
    trustedCerts: cfg.trustedCerts ?? {},
  };
}

test('config-model.blank() reproduces every fixture', () => {
  const { blank: cases } = load('config-model.json');
  assert.ok(cases.length > 0, 'expected config-model blank fixtures');
  for (const fixture of cases) {
    let n = 0;
    const cfg = blank({ suggestedGateways: fixture.suggested, uuid: () => fixture.ids[n++] });
    assert.deepStrictEqual(configSnapshot(cfg), fixture.expect, `${fixture.name}: the fresh config disagrees`);
    for (const key of fixture.absent) {
      // A config that carried a phone's window bounds would be a value nothing
      // could use and nothing would notice, which is why the absence is asserted
      // rather than the emptiness.
      assert.ok(!(key in cfg), `${fixture.name}: ${key} should not be in a config that was not given one`);
    }
    for (const [key, value] of Object.entries(fixture.flags)) {
      assert.strictEqual(cfg[key], value, `${fixture.name}: ${key} disagrees`);
    }
  }
});

test('the config model reproduces every fixture', () => {
  const { cases } = load('config-model.json');
  assert.ok(cases.length > 0, 'expected config-model fixtures');
  for (const fixture of cases) {
    let cfg = seeded(fixture.seed);
    for (const op of fixture.ops) cfg = applyConfigOp(cfg, op);
    assert.deepStrictEqual(configSnapshot(cfg), fixture.expect, `${fixture.name}: the config disagrees`);
    // The active pointer and the lookups that read it agree with each other at
    // the end of every case: a pointer that names nothing is the state these
    // rules exist to prevent.
    const active = activeGateway(cfg);
    if (cfg.activeGatewayId === null) assert.strictEqual(active, null, `${fixture.name}: found an active gateway with no pointer`);
    else assert.strictEqual(active?.id, cfg.activeGatewayId, `${fixture.name}: the pointer names nothing`);
  }
});

/*
 * The token handoff's half of the same contract.
 *
 * Every client builds the same address to hand a stored credential over on, and
 * the two things a port is most likely to get wrong are pinned here: an existing
 * fragment survives with the token merged into it, and a token already in the
 * fragment is REPLACED rather than duplicated, which is what makes a connect
 * self-heal a stale one.
 */
test('gateway-url.withTokenHandoff() reproduces every fixture', () => {
  const { cases } = load('gateway-url.json');
  assert.ok(cases.length > 0, 'expected gateway-url fixtures');
  for (const fixture of cases) {
    assert.strictEqual(
      withTokenHandoff(fixture.url, fixture.token ?? undefined),
      fixture.output,
      `${fixture.name}: the handoff disagrees`,
    );
  }
});

/*
 * What a check answers, in both directions.
 *
 * `checkAnswer` is the composition both clients raise a notice from, so a case
 * that returns null is as much a part of the contract as one that returns a
 * sentence: null is the scheduled check that found nothing, which is the silence
 * a background check is supposed to keep, and it is pinned here so neither
 * client can turn it into a banner.
 */
test('updates.checkAnswer() reproduces every fixture', () => {
  const { answers } = load('updates.json');
  assert.ok(answers.length > 0, 'expected update answer fixtures');
  for (const fixture of answers) {
    assert.deepStrictEqual(
      updates.checkAnswer(fixture.input),
      fixture.output,
      `${fixture.name}: the answer disagrees`,
    );
  }
  // Both directions are present, because a fixture set that only covered one of
  // them would let the other rot while this test stayed green.
  const outcomes = new Set(answers.map((a) => a.input.outcome));
  assert.ok(outcomes.has('available') && outcomes.has('current'),
    `the fixtures must cover an available and a current answer; got ${[...outcomes].join(', ')}`);
});
