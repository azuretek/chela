import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the shipped Electron callback with mocked native handles, not Chromium.
test('a lost foreground renderer attempts recovery once', () => {
  const main = fs.readFileSync(new URL('../../desktop/src/main.js', import.meta.url), 'utf8');
  const start = main.indexOf("  wc.on('render-process-gone'");
  const source = main.slice(start, main.indexOf('  return view;', start));
  let callback;
  let recovered = 0;
  const context = vm.createContext({
    wc: { on: (_, fn) => { callback = fn; } },
    page: () => context.wc,
    view: {}, attempt: false, payloadGateway: 'one',
    details: { reason: 'crashed' },
    destroyGatewayView() {}, showConnectionFailure() {},
    queueRendererRecovery: () => { recovered++; },
  });
  vm.runInContext(source, context);
  callback({}, { reason: 'crashed' });
  assert.equal(recovered, 1);
});

function harness() {
  let foreground = true;
  let gateway = { id: 'one', url: 'https://example.test/' };
  const loads = [];
  const tasks = [];
  const wc = { isDestroyed: () => false, getURL: () => 'https://example.test/chat/session-one' };
  const context = vm.createContext({
    URL, WeakSet, config: { activeGateway: () => gateway }, page: () => wc,
    payloadGateway: 'one', connection: { phase: 'connected' }, connectionState: { CONNECTED: 'connected' },
    settingsIsPage: false,
    mainWindow: { isDestroyed: () => false, isVisible: () => foreground, isFocused: () => foreground },
    setImmediate: (fn) => tasks.push(fn), loadActiveGateway: (args) => loads.push(args),
  });
  const main = fs.readFileSync(new URL('../../desktop/src/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('const rendererRecoveryUsed =');
  vm.runInContext(main.slice(start, main.indexOf('/* ------------------------------------------------------------ wake/reconnect */', start)), context);
  return { context, wc, loads, tasks, foreground: (v) => { foreground = v; }, gateway: (v) => { gateway = v; } };
}

test('one automatic replacement retains the gateway route and never loops', () => {
  const h = harness();
  h.context.queueRendererRecovery(h.wc);
  h.tasks.shift()();
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].rendererLoss.route, 'https://example.test/chat/session-one');
  h.context.queueRendererRecovery(h.wc);
  assert.equal(h.tasks.length, 0);
  assert.equal(h.loads.length, 1);
});

test('background death defers until foreground', () => {
  const h = harness();
  h.foreground(false);
  h.context.queueRendererRecovery(h.wc);
  h.tasks.shift()();
  assert.equal(h.loads.length, 0);
  h.foreground(true);
  h.context.resumeLostRenderer();
  assert.equal(h.loads.length, 1);
});

for (const cancel of ['gateway', 'settings', 'generation']) {
  test('stale renderer recovery is cancelled by ' + cancel, () => {
    const h = harness();
    h.context.queueRendererRecovery(h.wc);
    if (cancel === 'gateway') h.gateway({ id: 'two', url: 'https://other.test/' });
    if (cancel === 'settings') h.context.settingsIsPage = true;
    if (cancel === 'generation') vm.runInContext('rendererRecoveryEpoch++', h.context);
    h.tasks.shift()();
    h.context.resumeLostRenderer();
    assert.equal(h.loads.length, 0);
  });
}

test('authentication refusal remains an explicit boundary', () => {
  const h = harness();
  h.context.connection.phase = 'failed';
  h.context.queueRendererRecovery(h.wc);
  assert.equal(h.tasks.length, 0);
  assert.equal(h.loads.length, 0);
});
