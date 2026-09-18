// Every spec is classified, and the classification is checked.
//
// A spec in core/spec/ is consumed by an interface in one of two ways, and the
// difference is not stylistic:
//
//   mirrored  the interface ports the values as constants and a parity test
//             asserts them against this file on disk. Right where a value is a
//             name or a number, because two copies of a value can be compared.
//
//   bundled   the interface ships the file and reads it at runtime, so there is
//             no copy to drift. Right where the file holds a PROGRAM, because a
//             port of a script is a second copy of the program in another
//             language, which is the fork the shared file exists to prevent.
//
// This file is the inventory, and it exists because the split used to be
// described in prose as "one spec is the exception". That was wrong twice: eight
// specs are bundled, and an exception is a thing nobody checks. A spec with no
// entry here fails this test, so its author has to say how it is consumed rather
// than leave the next reader to work it out.

import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(HERE, '..', 'spec');
const PROJECT = path.join(HERE, '..', '..', 'mobile', 'project.yml');

// Ported as constants, proven against the spec by a parity test.
const MIRRORED = {
  'connection.json': 'connection state and its wording, proven against the fixtures',
  'feed.json': 'the releases-feed reader, read by UpdateFeed.swift and the desktop',
  'notices.json': 'notice tones and wording, mirrored by Notices.swift',
  'quips.json': 'the rotating lines, mirrored by Quips',
  'release.json': 'the release package names; the iOS client mirrors the OTA names it builds an install URL from, which lands with the OTA work',
  'tokens.json': 'notice colours and timings, mirrored by NoticeTokens.swift',
  'updates.json': 'the per-platform update policy, mirrored by UpdatePolicy.swift',
};

// Shipped as a resource and read at runtime, because a mirror of it would be a
// second copy of something rather than a comparable value.
const BUNDLED = {
  'app-settings-affordance.json': 'holds the one injected script that adds the footer control',
  'naming.json': 'read at runtime for the product name, the repo slug and each client shorthand',
  'progress.json': 'read at runtime for the milestone order, the floors and the easing constants',
  'device-identity.json': 'holds two injected scripts, the device keypair seed and the capture',
  'gateway-identity.json': 'holds the signals a payload is recognised by, so "is this an OpenClaw gateway" is one answer rather than one per platform',
  'native-control-auth.json': 'read at runtime for the global name, the client mode and the operator scopes',
  'pairing.json': 'holds the one injected script that observes the page gateway socket for a pairing close',
  'prompt-metadata.json': 'holds the injected script that puts the client-context block on every prompt',
  'settings.json': 'travels with the shared settings page, which cannot read it at runtime itself',
  'upstream-reference.json': 'read at runtime by the reference page host',
};

function specNames() {
  return readdirSync(SPECS).filter((name) => name.endsWith('.json')).sort();
}

// What the iOS app ships, read from the file that knows: its own project.
function shippedByProject() {
  const yaml = readFileSync(PROJECT, 'utf8');
  const found = new Set();
  for (const line of yaml.split('\n')) {
    const match = line.match(/^\s+-\s+path:\s+\.\.\/core\/spec\/([a-z0-9-]+\.json)\s*$/);
    if (match) found.add(match[1]);
  }
  return found;
}

test('every spec is classified, and the bundled half is what the app ships', () => {
  const names = specNames();
  assert.ok(names.length > 0, 'expected specs in core/spec');

  for (const name of names) {
    assert.ok(
      MIRRORED[name] || BUNDLED[name],
      name + ' is unclassified. Add it to MIRRORED or BUNDLED in this test and say why: a value can be mirrored and compared, a program has to be shipped.',
    );
  }
  for (const name of [...Object.keys(MIRRORED), ...Object.keys(BUNDLED)]) {
    assert.ok(names.includes(name), name + ' is classified here but is not in core/spec');
    assert.ok(!(MIRRORED[name] && BUNDLED[name]), name + ' cannot be both mirrored and bundled');
  }

  // project.yml is the authority on what the app carries, so a spec this test
  // calls bundled and that file does not must fail here rather than at runtime,
  // where a missing resource is a client that silently knows less.
  assert.deepEqual(
    [...shippedByProject()].sort(),
    Object.keys(BUNDLED).sort(),
    'mobile/project.yml and this test disagree about which specs the app reads at runtime',
  );
});

test('a mirrored spec holds no program, so a mirror of it stays comparable', () => {
  for (const name of Object.keys(MIRRORED)) {
    const text = readFileSync(path.join(SPECS, name), 'utf8');
    assert.ok(
      !/"hook"\s*:/.test(text),
      name + ' now holds a script, so it cannot be mirrored any more: move it to BUNDLED and ship it.',
    );
  }
});
