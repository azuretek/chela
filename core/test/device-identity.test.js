// The device-identity bridge: the JS reproduces every golden fixture, and the
// injected scripts are ONE owner rather than one copy per client.
//
// The golden seed statements in core/fixtures/device-identity.json are the
// contract the Swift port proves itself against, the same shape as the other
// parity fixtures in this tree. What a fixture cannot carry is asserted here: the
// storage key matches the page's own constant, the two injected scripts read from
// the spec are exercised as real JavaScript against a localStorage model, and the
// seed converges (it restores a persisted identity only when the page has none,
// so it never clobbers a fresh one the page just minted).

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

import {
  DEVICE_IDENTITY_STORAGE_KEY,
  DEVICE_IDENTITY_SEED_GLOBAL,
  DEVICE_IDENTITY_MESSAGE_NAME,
  DEVICE_IDENTITY_POLL_INTERVAL_MS,
  seedInstallation,
  captureScript,
} from '../device-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

test('device-identity constants match the fixture and the page', () => {
  const fixture = load('device-identity.json');
  assert.strictEqual(DEVICE_IDENTITY_STORAGE_KEY, fixture.storageKey);
  assert.strictEqual(DEVICE_IDENTITY_SEED_GLOBAL, fixture.seedGlobal);
  assert.strictEqual(DEVICE_IDENTITY_MESSAGE_NAME, fixture.messageName);
  assert.strictEqual(DEVICE_IDENTITY_POLL_INTERVAL_MS, fixture.pollIntervalMs);
  // The one key the page keeps its keypair under. Pinned as a literal so a drift
  // from the checkout's DEVICE_IDENTITY_STORAGE_KEY is a deliberate edit here.
  assert.strictEqual(DEVICE_IDENTITY_STORAGE_KEY, 'openclaw-device-identity-v1');
});

test('seedInstallation() reproduces every fixture', () => {
  const { seed: cases } = load('device-identity.json');
  assert.ok(cases.length > 0, 'expected seed fixtures');
  for (const { name, input, output } of cases) {
    assert.strictEqual(seedInstallation(input), output, `${name}: the seed statement disagrees`);
  }
});

/*
 * A localStorage model, so the injected scripts are exercised as real
 * JavaScript rather than trusted as text. Only the two methods the scripts use.
 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    _map: map,
  };
}

/** Run the seed statement for a persisted identity against a storage model. */
function runSeed(identity, storage) {
  const context = { window: { localStorage: storage } };
  vm.createContext(context);
  vm.runInContext(seedInstallation({ identity }), context);
  return context;
}

test('the seed restores a persisted identity into an empty store', () => {
  const identity = '{"version":1,"deviceId":"d","publicKey":"pk","privateKey":"sk","createdAtMs":0}';
  const storage = makeStorage();
  runSeed(identity, storage);
  assert.strictEqual(
    storage.getItem(DEVICE_IDENTITY_STORAGE_KEY),
    identity,
    'the persisted identity should be restored before the page reads it',
  );
});

test('the seed never clobbers an identity the page already has', () => {
  // Convergence: a page that already minted its own key must keep it. The seed
  // restores only into an EMPTY slot, so a persisted value from an older install
  // does not overwrite a fresh one, which would split the paired identity.
  const persisted = '{"version":1,"deviceId":"old","publicKey":"pk-old","privateKey":"sk-old","createdAtMs":0}';
  const fresh = '{"version":1,"deviceId":"new","publicKey":"pk-new","privateKey":"sk-new","createdAtMs":1}';
  const storage = makeStorage({ [DEVICE_IDENTITY_STORAGE_KEY]: fresh });
  runSeed(persisted, storage);
  assert.strictEqual(
    storage.getItem(DEVICE_IDENTITY_STORAGE_KEY),
    fresh,
    'the seed must not overwrite an identity already in the store',
  );
});

test('no persisted identity leaves an empty store empty', () => {
  const storage = makeStorage();
  runSeed(undefined, storage);
  assert.strictEqual(
    storage.getItem(DEVICE_IDENTITY_STORAGE_KEY),
    null,
    'with nothing to restore the seed does nothing',
  );
});

test('the capture script posts the current identity and only on change', () => {
  const identity = '{"version":1,"deviceId":"d","publicKey":"pk","privateKey":"sk","createdAtMs":0}';
  const storage = makeStorage({ [DEVICE_IDENTITY_STORAGE_KEY]: identity });
  const posted = [];
  let scheduled = null;
  const context = {
    window: {
      localStorage: storage,
      webkit: { messageHandlers: { [DEVICE_IDENTITY_MESSAGE_NAME]: { postMessage: (v) => posted.push(v) } } },
    },
    // Capture the interval callback rather than running it, so the test drives
    // the polling by hand instead of on a real clock.
    setInterval: (fn) => { scheduled = fn; return 1; },
  };
  vm.createContext(context);
  vm.runInContext(captureScript(), context);

  // The immediate read on install posts the identity once.
  assert.deepStrictEqual(posted, [identity], 'the capture should post the current identity on install');
  assert.strictEqual(typeof scheduled, 'function', 'the capture should schedule a poll');

  // A poll with no change posts nothing more.
  scheduled();
  assert.deepStrictEqual(posted, [identity], 'an unchanged identity should not post again');

  // A rotation posts the new value once.
  const rotated = '{"version":1,"deviceId":"e","publicKey":"pk2","privateKey":"sk2","createdAtMs":2}';
  storage.setItem(DEVICE_IDENTITY_STORAGE_KEY, rotated);
  scheduled();
  assert.deepStrictEqual(posted, [identity, rotated], 'a rotated identity should post once');
});

test('the capture script installs its send hook exactly once', () => {
  const storage = makeStorage();
  const context = {
    window: { localStorage: storage, webkit: { messageHandlers: { [DEVICE_IDENTITY_MESSAGE_NAME]: { postMessage: () => {} } } } },
    setInterval: () => 1,
  };
  vm.createContext(context);
  vm.runInContext(captureScript(), context);
  vm.runInContext(captureScript(), context);
  assert.strictEqual(
    context.window.__clawDeviceIdentityCaptureInstalled,
    true,
    'the capture marks itself installed so a second injection is a no-op',
  );
});
