// Parity tests: the JS reproduces every golden feed fixture exactly.
//
// The same shape as updates.test.js and version.test.js. The fixtures in
// core/fixtures/feed.json are the contract the iOS client's UpdateFeed.swift
// proves itself against, so "the two clients read one feed the same way" is
// checked rather than hoped for. Change the reading rule, regenerate the
// fixtures, and both sides move together.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { newerVersion, versionOf, feedUrl, channelFor, DEV_CHANNEL } from '../feed.js';
import spec from '../spec/feed.json' with { type: 'json' };
import naming from '../spec/naming.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

test('newerVersion() reproduces every fixture', () => {
  const { cases } = load('feed.json');
  assert.ok(cases.length > 0, 'expected feed fixtures');
  for (const { name, document, current, newer, throws } of cases) {
    if (throws) {
      assert.throws(() => newerVersion(document, current), /not a version/, name);
      continue;
    }
    assert.strictEqual(newerVersion(document, current), newer, name);
  }
});

test('versionOf() reads the version out of a document, or null', () => {
  assert.equal(versionOf({ version: '1.2.3' }), '1.2.3');
  assert.equal(versionOf({ version: '  1.2.3\n' }), '1.2.3', 'trimmed, the way a version arrives from anywhere');
  assert.equal(versionOf({ version: '' }), null);
  assert.equal(versionOf({ channel: 'dev' }), null);
  // A remote document a client did not write can be anything, and none of these
  // is a reason to crash a background check.
  for (const bad of [null, undefined, 'a string', 42, [], { version: 5 }]) {
    assert.equal(versionOf(bad), null, `for ${JSON.stringify(bad)}`);
  }
});

test('a build reads its own channel from its version, not a setting', () => {
  assert.equal(channelFor('1.0.1-dev.148.abc1234567'), DEV_CHANNEL);
  assert.equal(channelFor('1.0.1'), spec.channels.stable, 'a stable build reads the stable channel');
});

test('the feed URL is built from the repo slug and the shared pages path', () => {
  // The one string the workflow and feedUrl() share is spec.pagesPath, so the
  // URL is asserted against it rather than written out, the same discipline the
  // naming assertions use for a surface that cannot import the value.
  const repo = { owner: naming.repo.owner, name: naming.repo.name };
  assert.equal(
    feedUrl(DEV_CHANNEL, repo),
    `https://${repo.owner}.github.io/${repo.name}/${spec.pagesPath}/${DEV_CHANNEL}.json`,
  );
  // Public, so no gateway auth is needed to read it, which is the whole reason
  // the phone can run this check before it can authenticate.
  assert.ok(feedUrl(DEV_CHANNEL, repo).startsWith('https://'), 'a public https URL');
});
