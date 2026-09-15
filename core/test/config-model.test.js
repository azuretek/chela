// The gateway config model, as core owns it.
//
// The persistence is desktop's; the shape and the CRUD rules are shared, so they
// are asserted here. The one that matters most: removing the active gateway must
// clear the active pointer, because a pointer to a gateway that no longer exists
// is a state nothing downstream guards against.

import test from 'node:test';
import assert from 'node:assert';

import {
  blank, activeGateway, addGateway, updateGateway, removeGateway, trustCert,
} from '../config-model.js';

// A deterministic id generator, so a test can assert exact ids.
function counter() {
  let n = 0;
  return () => `id-${n++}`;
}

test('blank materialises the suggested gateways with generated ids', () => {
  const cfg = blank({
    suggestedGateways: [{ label: 'Local', url: 'http://127.0.0.1:18789' }],
    uuid: counter(),
  });
  assert.equal(cfg.gateways.length, 1);
  assert.equal(cfg.gateways[0].id, 'id-0');
  assert.equal(cfg.gateways[0].label, 'Local');
  assert.equal(cfg.activeGatewayId, null);
  assert.equal(cfg.promptMetadata, false);
  assert.equal(cfg.autoUpdate, true);
});

test('blank omits desktop-only fields unless given', () => {
  const mobile = blank({ uuid: counter() });
  assert.ok(!('window' in mobile), 'mobile blank should have no window bounds');
  assert.ok(!('globalShortcut' in mobile), 'mobile blank should have no global shortcut');

  const desktop = blank({
    uuid: counter(),
    window: { width: 1440, height: 920 },
    globalShortcut: 'CommandOrControl+Shift+O',
  });
  assert.deepEqual(desktop.window, { width: 1440, height: 920 });
  assert.equal(desktop.globalShortcut, 'CommandOrControl+Shift+O');
});

test('addGateway appends and returns the created entry', () => {
  const cfg = blank({ uuid: counter() });
  const { config, entry } = addGateway(cfg, { label: 'Home', url: 'https://h.ts.net' }, counter());
  assert.equal(config.gateways.length, 1);
  assert.equal(entry.label, 'Home');
  assert.equal(entry.url, 'https://h.ts.net');
  // The original config is not mutated.
  assert.equal(cfg.gateways.length, 0);
});

test('addGateway falls back to the url as a label', () => {
  const cfg = blank({ uuid: counter() });
  const { entry } = addGateway(cfg, { url: 'https://h.ts.net' }, counter());
  assert.equal(entry.label, 'https://h.ts.net');
});

test('updateGateway patches only the named gateway and keeps the rest', () => {
  const uuid = counter();
  let cfg = blank({ uuid });
  ({ config: cfg } = addGateway(cfg, { label: 'A', url: 'https://a' }, uuid));
  ({ config: cfg } = addGateway(cfg, { label: 'B', url: 'https://b' }, uuid));
  const targetId = cfg.gateways[0].id;
  const next = updateGateway(cfg, targetId, { label: 'A2' });
  assert.equal(next.gateways[0].label, 'A2');
  assert.equal(next.gateways[0].url, 'https://a', 'url unchanged when not patched');
  assert.equal(next.gateways[1].label, 'B', 'other gateway untouched');
});

test('removeGateway clears the active pointer when it removes the active gateway', () => {
  const uuid = counter();
  let cfg = blank({ uuid });
  ({ config: cfg } = addGateway(cfg, { label: 'A', url: 'https://a' }, uuid));
  const activeId = cfg.gateways[0].id;
  cfg = { ...cfg, activeGatewayId: activeId };
  assert.equal(activeGateway(cfg).id, activeId);

  const next = removeGateway(cfg, activeId);
  assert.equal(next.gateways.length, 0);
  assert.equal(next.activeGatewayId, null);
  assert.equal(activeGateway(next), null);
});

test('removeGateway leaves the active pointer alone when removing another', () => {
  const uuid = counter();
  let cfg = blank({ uuid });
  ({ config: cfg } = addGateway(cfg, { label: 'A', url: 'https://a' }, uuid));
  ({ config: cfg } = addGateway(cfg, { label: 'B', url: 'https://b' }, uuid));
  const [a, b] = cfg.gateways;
  cfg = { ...cfg, activeGatewayId: a.id };
  const next = removeGateway(cfg, b.id);
  assert.equal(next.activeGatewayId, a.id);
  assert.equal(next.gateways.length, 1);
});

test('trustCert pins a fingerprint per host without disturbing others', () => {
  const cfg = { ...blank({ uuid: counter() }), trustedCerts: { 'a.ts.net': 'sha256/AAA' } };
  const next = trustCert(cfg, 'b.ts.net', 'sha256/BBB');
  assert.equal(next.trustedCerts['a.ts.net'], 'sha256/AAA');
  assert.equal(next.trustedCerts['b.ts.net'], 'sha256/BBB');
  // Original untouched.
  assert.equal(cfg.trustedCerts['b.ts.net'], undefined);
});
