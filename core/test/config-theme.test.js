// The appearance store: which theme the app paints our own chrome with, and the
// two events that may move it.
//
// Its own file rather than more cases in config-model.test.js, and the reason is
// the failing-before signal. This is a store that did not exist, so a file that
// imports `themeFor` by name would fail at IMPORT against the older code and
// take every unrelated test in that file down with it, which tells a reader
// nothing about what broke. Imported as a namespace and asserted for its shape
// first, the same run fails on exactly the claim that is missing.
//
// The rules being held here, all of them Abi's:
//
//   the theme PERSISTS: it is never re-derived, reset or clobbered by a launch,
//   a reconnect, or one of our surfaces adopting an appearance;
//   it MOVES on exactly two events, a choice in the Control UI's own theme UI
//   and a switch to a gateway whose theme differs;
//   and because of the second one the value is keyed PER GATEWAY, so moving to
//   a gateway with nothing stored cannot delete the appearance of the one being
//   left behind.
//
// Run with: cd core && npm test

import test from 'node:test';
import assert from 'node:assert';

import * as model from '../config-model.js';

function counter() {
  let n = 0;
  return () => `id-${n++}`;
}

/** A config with two gateways, the first active, and nothing remembered yet. */
function twoGateways() {
  const uuid = counter();
  let cfg = model.blank({ uuid });
  ({ config: cfg } = model.addGateway(cfg, { label: 'Home', url: 'https://home.example.ts.net' }, uuid));
  ({ config: cfg } = model.addGateway(cfg, { label: 'Work', url: 'https://work.example.ts.net' }, uuid));
  return { ...cfg, activeGatewayId: cfg.gateways[0].id };
}

test('the store exists, and a blank config still carries the single fallback slot', () => {
  // The shape is asserted first, so everything below states what is missing in
  // one line instead of failing in whatever order the cases happen to run.
  assert.equal(typeof model.themeFor, 'function', 'config-model exports themeFor');
  assert.equal(typeof model.rememberTheme, 'function', 'config-model exports rememberTheme');

  const cfg = model.blank({ uuid: counter() });
  assert.deepStrictEqual(cfg.themeByGateway, {}, 'a fresh config remembers no gateway');
  // The fallback slot stays in the shape rather than being migrated away: an
  // existing profile keeps the appearance it had, and a gateway that has never
  // been seen has something to paint rather than a default.
  assert.ok('themeMode' in cfg, 'the single fallback slot is still part of the shape');
});

test('the appearance is keyed per gateway, and a switch keeps the other one', () => {
  const cfg = twoGateways();
  const [home, work] = cfg.gateways;

  let next = model.rememberTheme(cfg, home.id, 'light');
  next = model.rememberTheme(next, work.id, 'dark');
  assert.deepStrictEqual(next.themeByGateway, { [home.id]: 'light', [work.id]: 'dark' });

  // Switching to the second gateway remembers ITS theme and leaves the first
  // alone, which is the whole point of the keying: one slot would have the two
  // themes overwriting each other, so switching back would open in the wrong
  // appearance until the page answered.
  const switched = model.rememberTheme(next, work.id, 'light');
  assert.equal(switched.themeByGateway[home.id], 'light', 'the gateway left behind keeps its theme');
  assert.equal(model.themeFor(switched, work.id), 'light', 'and the one switched to answers its own');
  assert.equal(model.themeFor(switched, home.id), 'light');
});

test('a gateway with nothing stored falls back to the last known mode, not a default', () => {
  const cfg = { ...twoGateways(), themeMode: 'light' };
  const [home, work] = cfg.gateways;
  const remembered = model.rememberTheme(cfg, home.id, 'dark');

  // Home was seen and is dark. Work has never been seen, so it answers the last
  // known mode rather than a default, which is what keeps a switch from flaring
  // into the wrong palette while the new gateway is still connecting.
  assert.equal(model.themeFor(remembered, home.id), 'dark');
  assert.equal(model.themeFor(remembered, work.id), 'light');

  // And with nothing known at all the answer is null, which the caller paints
  // as its temporary fallback. Null is a read, not a decision: it is never
  // written anywhere, so it cannot become a stored value.
  assert.equal(model.themeFor(model.blank({ uuid: counter() }), 'nowhere'), null);
});

test('nothing can be written over a stored value by a caller with nothing to say', () => {
  const cfg = twoGateways();
  const [home] = cfg.gateways;
  const stored = model.rememberTheme(cfg, home.id, 'light');

  // Identity, not equality: the desktop's rememberTheme skips its file write on
  // exactly this comparison, so a report that is absent, empty or nonsense has
  // to leave the config it was given. A default written back here is how a
  // chosen theme silently stops being remembered.
  assert.strictEqual(model.rememberTheme(stored, home.id, 'light'), stored, 'the same mode is not a change');
  assert.strictEqual(model.rememberTheme(stored, home.id, null), stored, 'no mode is not a change');
  assert.strictEqual(model.rememberTheme(stored, home.id, ''), stored, 'an empty mode is not a change');
  assert.strictEqual(model.rememberTheme(stored, home.id, 'blue'), stored, 'an unknown mode is not a change');
  assert.strictEqual(model.rememberTheme(stored, null, 'dark'), stored, 'no gateway is not a change');
  assert.strictEqual(model.rememberTheme(stored, undefined, 'dark'), stored, 'an undefined gateway is not a change');
  assert.deepStrictEqual(stored.themeByGateway, { [home.id]: 'light' });
});
