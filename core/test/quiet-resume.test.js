import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createWake } from '../../desktop/src/wake.js';

for (const events of [
  ['powerMonitor:suspend', 'powerMonitor:resume'],
  ['powerMonitor:lock-screen', 'powerMonitor:suspend', 'powerMonitor:resume', 'powerMonitor:unlock-screen'],
  ['net:offline', 'net:online'],
  ['page:socket-dropped'],
]) {
  test('surviving document is retained: ' + events.join(', '), () => {
    let discarded = 0;
    let covered = 0;
    let recoveries = 0;
    const wake = createWake({
      close: () => discarded++,
      cover: () => covered++,
      reconnect: () => recoveries++,
    });
    events.forEach(event => wake.reportRaw(event));
    assert.equal(discarded, 0);
    assert.equal(covered, 0);
    assert.equal(recoveries, 1);
  });
}

test('native resume paths delegate transport recovery without navigating', () => {
  const main = fs.readFileSync(new URL('../../desktop/src/main.js', import.meta.url), 'utf8');
  const wake = main.slice(main.indexOf('const wake = createWake('), main.indexOf('let onlinePoll'));
  assert.doesNotMatch(wake, /loadActiveGateway|showLoadingCover|payloadGateway = null/);
  const mobile = fs.readFileSync(new URL('../../mobile/Chela/ContentView.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(mobile, /wake.reconnect = .*pairing.reconnectNow/);
});

// Execute the actual native callback, rather than merely examining its spelling.
// Electron transport is mocked; this is not a Chromium/sleep integration proof.
test('desktop callback avoids navigation and permits repeated healthy wakes', async () => {
  const main = fs.readFileSync(new URL('../../desktop/src/main.js', import.meta.url), 'utf8');
  const callback = main.slice(main.indexOf('const wake = createWake('), main.indexOf('let onlinePoll'));
  let navigations = 0;
  let activations = 0;
  const context = vm.createContext({
    createWake,
    console,
    payloadGateway: 'existing',
    pageReloading: false,
    page: () => ({ isDestroyed: () => false, executeJavaScript: async () => { activations++; } }),
    config: { activeGateway: () => true },
    loadActiveGateway: () => { navigations++; },
    showLoadingCover: () => { throw new Error('unexpected cover'); },
  });
  vm.runInContext(callback + ';globalThis.nativeWake = wake', context);
  for (const raw of ['powerMonitor:suspend', 'powerMonitor:resume']) context.nativeWake.reportRaw(raw);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigations, 0);
  assert.equal(activations, 1);
  assert.equal(context.nativeWake.state, 'awake');
  context.nativeWake.reportRaw('net:offline');
  context.nativeWake.reportRaw('net:online');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activations, 2);
  assert.equal(navigations, 0);
  assert.equal(context.nativeWake.state, 'awake');
});
