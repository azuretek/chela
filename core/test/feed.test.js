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

import { newerVersion, isNewerBuild, tagVersion, newestOnChannel, feedUrl, releaseNotesUrl, channelFor, iosAvailable, IOS_MARKER, DEV_CHANNEL, STABLE_CHANNEL } from '../feed.js';
// The two comparisons, side by side on purpose: `compare` is the one an update
// check must NOT make, and these tests say so by asserting it disagrees.
import { compare, release, compareRelease, isNewerRelease } from '../version.js';
import spec from '../spec/feed.json' with { type: 'json' };
import naming from '../spec/naming.json' with { type: 'json' };
import { releasesUrl } from '../naming.js';

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

/*
 * ★ THE PHANTOM-UPDATE FIX, as a fixture the phone and the desktop both read.
 *
 * The desktop reads every release, because its own installers are on any release
 * it published. The phone reads a NARROWER feed: a release is offered only when
 * it carries the iOS availability marker in its body, meaning a TestFlight build
 * of that version is installable. So a desktop-only release, the newest entry in
 * the feed, is invisible to the phone. These cases pass { iosOnly: true }, which
 * is the audience the Swift client defaults to (UpdateFeed.newerVersion's only
 * caller is the phone). The desktop cases above deliberately do not, so the two
 * audiences are proven to read the same feed differently.
 */
test('newerVersion({ iosOnly }) offers the phone only releases with a TestFlight build', () => {
  const { iosCases } = load('feed.json');
  assert.ok(iosCases.length > 0, 'expected iOS feed fixtures');
  for (const { name, document, current, newer } of iosCases) {
    assert.strictEqual(newerVersion(document, current, { iosOnly: true }), newer, name);
  }
});

test('a desktop-only release is offered to the desktop but not to the phone', () => {
  // The exact bug: the newest release has no TestFlight build. The desktop still
  // offers it (its installers are on it); the phone must not.
  const document = {
    entries: [
      { id: '.../releases/v1.0.1-dev.279.9a58115cb1', title: 'v1.0.1-dev.279.9a58115cb1', content: '<p>a .github-only change</p>' },
    ],
  };
  assert.strictEqual(newerVersion(document, '1.0.1-dev.148.abc1234567'), '1.0.1-dev.279.9a58115cb1', 'the desktop reads every release');
  assert.strictEqual(newerVersion(document, '1.0.1-dev.148.abc1234567', { iosOnly: true }), null, 'the phone is offered nothing without the marker');
});

test('iosAvailable() reads the marker out of an entry body, or false', () => {
  assert.equal(iosAvailable({ content: 'notes\n' + IOS_MARKER }), true);
  assert.equal(iosAvailable({ content: IOS_MARKER }), true, 'the marker alone is enough');
  assert.equal(iosAvailable({ content: '<p>desktop only</p>' }), false, 'a body without the marker is not available');
  // A non-answer for anything a feed a client did not write can hand it, and the
  // safe direction: an unrecognised shape is not offered to the phone.
  for (const bad of [null, undefined, {}, { content: 5 }, { content: null }, 'a string', 42]) {
    assert.equal(iosAvailable(bad), false, `for ${JSON.stringify(bad)}`);
  }
});

/*
 * The link a client puts behind "release notes". It exists because the wrong
 * answer shipped: the phone's Release notes button opened TestFlight, which is
 * where a build waits rather than where its notes are. The notes for a release
 * are the release's own page, and with no version to name it is the channel's
 * list, which naming.js already owns.
 */
test('releaseNotesUrl() reproduces every fixture', () => {
  const { releaseNotes } = load('feed.json');
  assert.ok(releaseNotes.length > 0, 'expected release-notes fixtures');
  const repo = `${naming.repo.owner}/${naming.repo.name}`;
  for (const { name, version, output } of releaseNotes) {
    assert.strictEqual(releaseNotesUrl(repo, version), output, name);
  }
});

test('a release-notes link is the release page, never a store or a download page', () => {
  const repo = `${naming.repo.owner}/${naming.repo.name}`;
  const url = releaseNotesUrl(repo, '1.0.1-dev.149.abc');
  assert.ok(url.startsWith(`${releasesUrl}/tag/v`), url);
  assert.ok(!url.includes('testflight'), 'a release-notes link must not point at a distribution channel');
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
  const repo = `${naming.repo.owner}/${naming.repo.name}`;
  assert.equal(
    feedUrl(repo),
    `https://github.com/${repo.owner}/${repo.name}/${spec.releasesPath}`,
  );
  // github.com rather than api.github.com, so no api rate limit applies to a
  // five-minute dev check, and public so the phone needs no gateway auth to read
  // it.
  assert.ok(feedUrl(repo).startsWith('https://github.com/'), 'a public github.com https URL');
});

/*
 * ★ THE RELEASE-ONLY RULE, and the bug it fixes.
 *
 * Our dev versions carry a tail after the release (`1.0.1-dev.195.6387043585`)
 * that is build and commit information. Its BASIS changed, so a newer build can
 * carry a LOWER number than an older one, and a check that RANKS that tail
 * inverts: it decides the installed build is ahead of the feed, offers nothing,
 * and the client stops updating while its number appears to go backwards.
 *
 * These are that failure, in both directions, because a check that always says
 * yes is as wrong as one that always says no.
 */

test('release() drops the build and commit tail, and compareRelease() ignores it', () => {
  assert.equal(release('1.0.1-dev.195.6387043585'), '1.0.1');
  assert.equal(release('1.0.1'), '1.0.1');
  assert.equal(release('1.0.1-dev.12.1758000000.dirty'), '1.0.1');
  assert.equal(release('latest'), null, 'not a version at all');

  // Two builds of the same release are EQUAL by release, whatever their tails
  // say. That equality is what makes the order uninvertible.
  assert.equal(compareRelease('1.0.1-dev.12.1758000000', '1.0.1-dev.195.6387043585'), 0);
  assert.equal(isNewerRelease('1.0.1-dev.12.1758000000', '1.0.1-dev.195.6387043585'), false);
  // The release still orders, which is the one thing it is allowed to refuse.
  assert.equal(isNewerRelease('1.0.0-dev.900.1700000000', '1.0.1-dev.195.6387043585'), false);
  assert.equal(isNewerRelease('1.0.2-dev.1.1', '1.0.1-dev.195.6387043585'), true);
});

test('★ the reported bug: an old-scheme tail that looks HIGHER than the feed is still offered the newest', () => {
  // Installed: a build from the old scheme, where the number after `dev` was a
  // commit count. In the feed: builds from the new scheme, where it is a build
  // count, so every number published since is LOWER.
  const installed = '1.0.1-dev.195.6387043585';
  const newest = '1.0.1-dev.12.1758000000';
  const document = {
    entries: [
      { id: `.../releases/v${newest}` },
      { id: '.../releases/v1.0.1-dev.11.1757000000' },
    ],
  };

  // The old comparison, which is what shipped, says there is nothing to offer.
  // This assertion is the bug, pinned: if it ever flips, the retired comparator
  // has started ranking the release only and the fix can be simplified.
  assert.equal(compare(newest, installed) > 0, false,
    'ranking the tail concludes the installed build is AHEAD, which is the frozen check');

  assert.equal(isNewerBuild(newest, installed), true);
  assert.equal(newerVersion(document, installed), newest);
});

test('★ with the feed tails running BACKWARDS, the newest by feed order still wins', () => {
  // Every published number is below the installed one and they descend as they
  // get newer. The feed's own ordering is the signal, so the newest entry is
  // still the answer.
  const document = {
    entries: [
      { id: '.../releases/v1.0.1-dev.3.1759000000' },
      { id: '.../releases/v1.0.1-dev.20.1758500000' },
    ],
  };
  assert.equal(compare('1.0.1-dev.3.1759000000', '1.0.1-dev.20.1758500000') > 0, false,
    'the tail ranks this lower than the installed build');
  assert.equal(newerVersion(document, '1.0.1-dev.20.1758500000'), '1.0.1-dev.3.1759000000');
});

test('★ a genuinely OLDER release is still not offered, in both channels', () => {
  const dev = { entries: [{ id: '.../releases/v1.0.0-dev.900.1700000000' }] };
  assert.equal(newerVersion(dev, '1.0.1-dev.195.6387043585'), null,
    'an older release is a step backwards, not an update');

  const stable = { entries: [{ id: '.../releases/v1.0.0' }] };
  assert.equal(newerVersion(stable, '1.0.1'), null);
  assert.equal(isNewerBuild('1.0.0', '1.0.1'), false);
});

test('the build we are running is not offered back to us', () => {
  // The tail still counts here, for what it literally is: an identity. Without
  // that, a check that cannot tell the feed's newest from the build in front of
  // it would offer the same build on every check forever.
  assert.equal(isNewerBuild('1.0.1-dev.12.1758000000', '1.0.1-dev.12.1758000000'), false);
  const document = { entries: [{ id: '.../releases/v1.0.1-dev.12.1758000000' }] };
  assert.equal(newerVersion(document, '1.0.1-dev.12.1758000000'), null);
});

test('★ one owner, iOS audience: newerVersion({ iosOnly }) and the filtered newestOnChannel cannot disagree', () => {
  const { iosCases } = load('feed.json');
  for (const { name, document, current, newer } of iosCases) {
    const advertised = newestOnChannel(document, channelFor(current), { iosOnly: true });
    const decision = advertised === null ? null : (isNewerBuild(advertised, current) ? advertised : null);
    assert.equal(decision, newer, `${name}: the iOS filter path disagrees with newerVersion`);
  }
});

test('★ one owner: newerVersion() and isNewerBuild() cannot disagree', () => {
  // The desktop reaches the rule through isNewerBuild directly (its updater's
  // own comparison ranks the tail, so main.js re-decides with this), and the
  // feed path reaches it through newerVersion. Same owner, so a candidate the
  // feed path offers is one the desktop path offers.
  const { cases } = load('feed.json');
  for (const { name, document, current, newer, throws } of cases) {
    if (throws) continue;
    const advertised = newestOnChannel(document, channelFor(current));
    const decision = advertised === null ? null : (isNewerBuild(advertised, current) ? advertised : null);
    assert.equal(decision, newer, `${name}: isNewerBuild disagrees with newerVersion`);
  }
});

test('an unreadable version is a surfaced fault on both sides of the rule', () => {
  assert.throws(() => isNewerBuild('1.0.2', 'latest'), /not a version/);
  assert.throws(() => isNewerBuild('latest', '1.0.1'), /not a version/);
});
