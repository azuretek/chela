// The appearance store as the desktop persists it: one file, one key per
// gateway, and a launch that touches nothing.
//
// This is the half core/config-model.test.js cannot see. The model owns the
// rules; this owns the fact that the app keeps them on DISK, against the right
// gateway, and that starting up does not rewrite them. A test of the model alone
// would pass while the desktop wrote the wrong key, or wrote on every launch.
//
// The property Abi asked to be proven is here as a test rather than asserted in
// prose: after a launch-like sequence, the config file is byte for byte and
// timestamp for timestamp what it was. That is what "our surfaces only read the
// theme" means at the level it can be measured: an app that re-derives a theme
// has to write it down somewhere, and this is the only place it could write.
//
// Run with: cd desktop && npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config, { setUserDataDir } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

/** A throwaway profile, so a run cannot disturb the app someone actually uses. */
function profile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-theme-store-'));
  setUserDataDir(dir);
  return dir;
}

/** Two gateways, the first active. Returns the config as the app would see it. */
function withTwoGateways() {
  const dir = profile();
  const home = config.addGateway({ label: 'Home', url: 'https://home.example.ts.net' });
  const work = config.addGateway({ label: 'Work', url: 'https://work.example.ts.net' });
  config.update({ activeGatewayId: home.id });
  return { dir, home, work };
}

/** The store's own file, as bytes, and when it was last written. */
function fingerprint(dir) {
  const file = path.join(dir, 'config.json');
  return { bytes: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
}

test('a launch reads the appearance and writes nothing at all', () => {
  const { dir, home, work } = withTwoGateways();

  // What a launch does: read the config, look at the active gateway, ask which
  // appearance it was last seen in. Every one of those is a read.
  config.rememberTheme(home.id, 'light');
  config.rememberTheme(work.id, 'dark');
  const before = fingerprint(dir);

  assert.equal(config.themeFor(home.id), 'light');
  assert.equal(config.themeFor(work.id), 'dark');
  assert.equal(config.activeGateway().id, home.id);

  // Byte for byte and timestamp for timestamp. A store that re-derives an
  // appearance has to write it down, and this asserts that nothing did.
  const after = fingerprint(dir);
  assert.strictEqual(after.bytes, before.bytes, 'the config file was rewritten during a read-only launch');
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'the config file was touched during a read-only launch');
});

test('adopting the appearance a gateway is already in writes nothing', () => {
  const { dir, home } = withTwoGateways();
  config.rememberTheme(home.id, 'dark');
  const before = fingerprint(dir);

  // The page reports its theme on every load. When it matches what is stored
  // there is nothing to record, and recording it anyway is how a stored value
  // gets replaced by whatever a launch happened to see first.
  assert.strictEqual(config.rememberTheme(home.id, 'dark'), false, 'a repeat must not report a write');
  const after = fingerprint(dir);
  assert.strictEqual(after.bytes, before.bytes, 'a no-op remember rewrote the config');
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'a no-op remember touched the config');
});

test('a theme survives a restart, per gateway, with the other gateway intact', () => {
  const { dir, home, work } = withTwoGateways();
  config.rememberTheme(home.id, 'light');
  config.rememberTheme(work.id, 'dark');

  // A restart, as far as the store can tell: the cache is dropped and the file
  // is read again. What a reader chose in the Control UI has to come back, for
  // the gateway that chose it and for no other.
  setUserDataDir(dir);
  assert.equal(config.themeFor(home.id), 'light', 'the chosen theme did not survive a restart');
  assert.equal(config.themeFor(work.id), 'dark', 'the other gateway lost its theme');

  // And moving to the other gateway does not delete the one being left.
  config.update({ activeGatewayId: work.id });
  assert.equal(config.themeFor(home.id), 'light', 'switching away deleted the theme of the gateway left behind');
});

test('a config written before the store existed keeps the appearance it had', () => {
  const dir = profile();
  // An older profile: one slot, no per-gateway map. Reading it must answer the
  // slot for every gateway rather than the default, and must not write.
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({
    gateways: [{ id: 'old', label: 'Old', url: 'https://old.example.ts.net' }],
    activeGatewayId: 'old',
    themeMode: 'light',
  }, null, 2)}\n`);
  setUserDataDir(dir);
  const before = fingerprint(dir);

  assert.equal(config.themeFor('old'), 'light');
  assert.equal(config.themeFor('never-seen'), 'light', 'a gateway with no entry answers the last known mode');
  const after = fingerprint(dir);
  assert.strictEqual(after.bytes, before.bytes, 'reading an older config rewrote it');
});

test('no surface of ours writes the appearance, and the cover only reads one', () => {
  // The side-effect guard, and the reason it is a test rather than a comment:
  // the loading cover adopting an appearance is exactly the kind of change that
  // acquires a "while we are here, remember this" line, and that line is how a
  // theme chosen upstream gets quietly replaced. The cover is the first thing
  // painted, so it is the surface with the most to gain and the most to lose.
  const style = /async function styleLoadingCover\(wc\) \{([\s\S]*?)\n\}/.exec(MAIN_JS);
  const reveal = /function revealMainWindow\(\) \{([\s\S]*?)\n\}/.exec(MAIN_JS);
  assert.ok(style, 'styleLoadingCover is not in main.js');
  assert.ok(reveal, 'revealMainWindow is not in main.js');

  for (const [name, body] of [['styleLoadingCover', style[1]], ['revealMainWindow', reveal[1]]]) {
    assert.ok(!/config\.(update|rememberTheme)\(/.test(body),
      `${name} writes the appearance store; a surface adopting a theme must never decide one`);
  }
  // And it does read one, so this is not passing by being empty of the subject.
  assert.match(style[1], /applyTokenCss|applyThemeCss/, 'the cover is expected to take the token layer and the live theme');
  assert.ok(/config\.themeFor\(/.test(MAIN_JS), 'the appearance is read through config.themeFor');
});
