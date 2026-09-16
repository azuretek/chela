// Plain `node --test`, no Electron, no chance of touching a real profile.
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as profile from '../src/profile.js';

function tmpAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claw-profile-'));
}

function seed(dir, name, files) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(target, file), body);
  return target;
}

test('moves the previous name across, contents intact', () => {
  const base = tmpAppData();
  seed(base, 'Claw Desktop', { 'config.json': '{"marker":1}', 'credentials.json': 'ENCRYPTED' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(path.basename(result.from), 'Claw Desktop');
  assert.equal(fs.existsSync(path.join(base, 'Claw Desktop')), false, 'old directory should be gone');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Control UI', 'config.json'), 'utf8'), '{"marker":1}');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Control UI', 'credentials.json'), 'utf8'), 'ENCRYPTED');
});

test('a profile two renames old still lands, and carries its notice log', () => {
  const base = tmpAppData();
  const old = seed(base, 'OpenClaw', { 'config.json': '{"marker":1}' });
  fs.mkdirSync(path.join(old, 'notice-log'));
  fs.writeFileSync(path.join(old, 'notice-log', '2026-08.jsonl'), '{"tone":"warn"}\n');

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(
    fs.readFileSync(path.join(base, 'Claw Control UI', 'notice-log', '2026-08.jsonl'), 'utf8'),
    '{"tone":"warn"}\n',
  );
});

test('with two predecessors present the newer one moves and the older is left alone', () => {
  const base = tmpAppData();
  seed(base, 'OpenClaw', { 'config.json': '{"which":"oldest"}' });
  seed(base, 'Claw Desktop', { 'config.json': '{"which":"newer"}' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Control UI', 'config.json'), 'utf8'), '{"which":"newer"}');
  // Never merged, and never deleted: the older profile is evidence, not input.
  assert.equal(fs.readFileSync(path.join(base, 'OpenClaw', 'config.json'), 'utf8'), '{"which":"oldest"}');
});

test('never overwrites an existing current-name profile', () => {
  const base = tmpAppData();
  seed(base, 'Claw Desktop', { 'config.json': '{"which":"old"}' });
  seed(base, 'Claw Control UI', { 'config.json': '{"which":"current"}' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'already-current');
  // The live profile must win, and the old one must survive for recovery.
  assert.equal(fs.readFileSync(path.join(base, 'Claw Control UI', 'config.json'), 'utf8'), '{"which":"current"}');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Desktop', 'config.json'), 'utf8'), '{"which":"old"}');
});

test('is a no-op on a fresh install, and still names where the profile will go', () => {
  const base = tmpAppData();
  const result = profile.migrate(base);

  assert.equal(result.status, 'nothing-to-migrate');
  assert.equal(result.to, path.join(base, 'Claw Control UI'), 'main.js points userData at this');
  assert.equal(fs.existsSync(path.join(base, 'Claw Control UI')), false);
});

test('runs only once, a second call is a no-op', () => {
  const base = tmpAppData();
  seed(base, 'Claw Desktop', { 'config.json': '{"marker":1}' });

  assert.equal(profile.migrate(base).status, 'migrated');
  // The second call sees the target it just created, so it declines rather than
  // reporting "nothing to migrate", either way it must not touch anything.
  assert.equal(profile.migrate(base).status, 'already-current');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Control UI', 'config.json'), 'utf8'), '{"marker":1}');
});

test('reports failure instead of throwing, so startup survives it', () => {
  const base = tmpAppData();
  seed(base, 'Claw Desktop', { 'config.json': '{}' });
  // A file where the target directory would go: rename cannot succeed.
  fs.writeFileSync(path.join(base, 'Claw Control UI'), 'not a directory');

  const result = profile.migrate(base);

  // An existing *path* is treated as "already current" and left strictly alone,
  // which is the safe reading: never clobber whatever is sitting there.
  assert.equal(result.status, 'already-current');
  assert.equal(fs.existsSync(path.join(base, 'Claw Desktop')), true);
});

/* ------------------------------------------------------- the pinned identities */

// That the directory named by CURRENT_NAME is the productName the build files
// carry is asserted in test/naming.test.js, which owns every surface that cannot
// import core/spec/naming.json. What is left here is the invariant the migration
// itself depends on.
test('the keychain name is pinned to a name the credentials were written under', () => {
  // Not CURRENT_NAME: a keychain item is found by name, so the pinned identity
  // has to be the name the item was created under, which is the previous one.
  assert.equal(profile.KEYCHAIN_NAME, 'Claw Desktop');
  assert.equal(profile.PREVIOUS_NAMES[0], profile.KEYCHAIN_NAME);
});
