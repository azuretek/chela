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

import { newerVersion, tagVersion, newestOnChannel, feedUrl, channelFor, DEV_CHANNEL, STABLE_CHANNEL } from '../feed.js';
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

test('tagVersion() recovers the version from an entry id or title, or null', () => {
  assert.equal(tagVersion({ id: 'tag:github.com,2008:Repository/1/v1.2.3', title: 'anything' }), '1.2.3',
    'the id carries the tag and is preferred');
  assert.equal(tagVersion({ id: '', title: 'v1.2.3' }), '1.2.3', 'the title is the fallback when the id is empty');
  assert.equal(tagVersion({ id: '.../releases/1.2.3' }), '1.2.3', 'a tag without a v prefix is still read');
  // A remote document a client did not write can be anything, and none of these
  // is a reason to crash a background check.
  for (const bad of [null, undefined, 'a string', 42, [], {}, { id: 5 }]) {
    assert.equal(tagVersion(bad), null, `for ${JSON.stringify(bad)}`);
  }
});

test('newestOnChannel() takes the newest entry belonging to the channel', () => {
  const document = {
    entries: [
      { id: '.../releases/v1.0.2' },
      { id: '.../releases/v1.0.1-dev.9.abc1234567' },
    ],
  };
  assert.equal(newestOnChannel(document, STABLE_CHANNEL), '1.0.2', 'stable skips the dev entry');
  assert.equal(newestOnChannel(document, DEV_CHANNEL), '1.0.1-dev.9.abc1234567', 'dev skips the stable entry');
  assert.equal(newestOnChannel({ entries: [] }, DEV_CHANNEL), null, 'no entries, nothing to return');
  assert.equal(newestOnChannel({}, DEV_CHANNEL), null, 'a document with no entries array is a non-answer, not a crash');
  assert.equal(newestOnChannel(null, DEV_CHANNEL), null);
});

test('a build reads its own channel from its version, not a setting', () => {
  assert.equal(channelFor('1.0.1-dev.148.abc1234567'), DEV_CHANNEL);
  assert.equal(channelFor('1.0.1'), STABLE_CHANNEL, 'a stable build reads the stable channel');
});

test('the feed URL is the releases Atom feed, built from the repo slug', () => {
  // The one string the reader and the spec share is spec.releasesPath, so the
  // URL is asserted against it rather than written out, the same discipline the
  // naming assertions use for a surface that cannot import the value.
  const repo = { owner: naming.repo.owner, name: naming.repo.name };
  assert.equal(
    feedUrl(repo),
    `https://github.com/${repo.owner}/${repo.name}/${spec.releasesPath}`,
  );
  // github.com rather than api.github.com, so no api rate limit applies to a
  // five-minute dev check, and public so the phone needs no gateway auth to read
  // it.
  assert.ok(feedUrl(repo).startsWith('https://github.com/'), 'a public github.com https URL');
});
