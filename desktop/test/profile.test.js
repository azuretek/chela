// Plain `node --test`, no Electron, no chance of touching a real profile.
// Run with: npm test
//
// Every name in here is read from the spec rather than written down, and that is
// the lesson of the two renames this file has already been through: a test that
// hardcodes the previous name fails the moment the product is renamed, while one
// that walks PREVIOUS_NAMES keeps working and keeps proving the same thing.
// PREV is the newest predecessor, which is the one a machine migrating today
// still has; FIRST is the oldest, the profile two renames back.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as profile from '../src/profile.js';

const { CURRENT_NAME, PREVIOUS_NAMES } = profile;
const PREV = PREVIOUS_NAMES[0];
const FIRST = PREVIOUS_NAMES[PREVIOUS_NAMES.length - 1];

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
  seed(base, PREV, { 'config.json': '{"marker":1}', 'credentials.json': 'ENCRYPTED' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(path.basename(result.from), PREV);
  assert.equal(fs.existsSync(path.join(base, PREV)), false, 'old directory should be gone');
  assert.equal(fs.readFileSync(path.join(base, CURRENT_NAME, 'config.json'), 'utf8'), '{"marker":1}');
  assert.equal(fs.readFileSync(path.join(base, CURRENT_NAME, 'credentials.json'), 'utf8'), 'ENCRYPTED');
});

test('a profile two renames old still lands, and carries its notice log', () => {
  const base = tmpAppData();
  const old = seed(base, FIRST, { 'config.json': '{"marker":1}' });
  fs.mkdirSync(path.join(old, 'notice-log'));
  fs.writeFileSync(path.join(old, 'notice-log', '2026-08.jsonl'), '{"tone":"warn"}\n');

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(
    fs.readFileSync(path.join(base, CURRENT_NAME, 'notice-log', '2026-08.jsonl'), 'utf8'),
    '{"tone":"warn"}\n',
  );
});

test('with two predecessors present the newer one moves and the older is left alone', () => {
  const base = tmpAppData();
  seed(base, FIRST, { 'config.json': '{"which":"oldest"}' });
  seed(base, PREV, { 'config.json': '{"which":"newer"}' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(fs.readFileSync(path.join(base, CURRENT_NAME, 'config.json'), 'utf8'), '{"which":"newer"}');
  // Never merged, and never deleted: the older profile is evidence, not input.
  assert.equal(fs.readFileSync(path.join(base, FIRST, 'config.json'), 'utf8'), '{"which":"oldest"}');
});

test('never overwrites an existing current-name profile', () => {
  const base = tmpAppData();
  seed(base, PREV, { 'config.json': '{"which":"old"}' });
  seed(base, CURRENT_NAME, { 'config.json': '{"which":"current"}' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'already-current');
  // The live profile must win, and the old one must survive for recovery.
  assert.equal(fs.readFileSync(path.join(base, CURRENT_NAME, 'config.json'), 'utf8'), '{"which":"current"}');
  assert.equal(fs.readFileSync(path.join(base, PREV, 'config.json'), 'utf8'), '{"which":"old"}');
});

test('is a no-op on a fresh install, and still names where the profile will go', () => {
  const base = tmpAppData();
  const result = profile.migrate(base);

  assert.equal(result.status, 'nothing-to-migrate');
  assert.equal(result.to, path.join(base, CURRENT_NAME), 'main.js points userData at this');
  assert.equal(fs.existsSync(path.join(base, CURRENT_NAME)), false);
});

test('runs only once, a second call is a no-op', () => {
  const base = tmpAppData();
  seed(base, PREV, { 'config.json': '{"marker":1}' });

  assert.equal(profile.migrate(base).status, 'migrated');
  // The second call sees the target it just created, so it declines rather than
  // reporting "nothing to migrate", either way it must not touch anything.
  assert.equal(profile.migrate(base).status, 'already-current');
  assert.equal(fs.readFileSync(path.join(base, CURRENT_NAME, 'config.json'), 'utf8'), '{"marker":1}');
});

test('reports failure instead of throwing, so startup survives it', () => {
  const base = tmpAppData();
  seed(base, PREV, { 'config.json': '{}' });
  // A file where the target directory would go: rename cannot succeed.
  fs.writeFileSync(path.join(base, CURRENT_NAME), 'not a directory');

  const result = profile.migrate(base);

  // An existing *path* is treated as "already current" and left strictly alone,
  // which is the safe reading: never clobber whatever is sitting there.
  assert.equal(result.status, 'already-current');
  assert.equal(fs.existsSync(path.join(base, PREV)), true);
});

/* ------------------------------------------------------- the pinned identities */

// That the directory named by CURRENT_NAME is the productName the build files
// carry is asserted in test/naming.test.js, which owns every surface that cannot
// import core/spec/naming.json. What is left here is the invariant the migration
// itself depends on.
test('the keychain name is pinned to a name the credentials were written under', () => {
  // The item is found BY NAME, so pinning it to the current name would ask the
  // Keychain for an item that does not exist, get a fresh random password, and
  // be unable to read one byte of credentials.json. It stays at the name it was
  // created under, which is therefore a predecessor in the chain, never the
  // current name.
  assert.equal(profile.KEYCHAIN_NAME, 'Claw Desktop');
  assert.ok(
    PREVIOUS_NAMES.includes(profile.KEYCHAIN_NAME),
    'the item names a predecessor the chain migrates from',
  );
  assert.notEqual(profile.KEYCHAIN_NAME, CURRENT_NAME);
});
