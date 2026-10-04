
// Plain `node --test`, no Electron. src/build-info.js keeps its parsing and
// formatting free of Electron for exactly this reason; only `read` touches the
// disk, and it takes a path so it can be pointed at a fixture.
//
// Run with: npm test

import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as buildInfo from '../src/build-info.js';
import * as cache from '../src/cache.js';
import { collect as collectBuildInfo, countFromVersion } from '../scripts/build-info.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CLEAN = { commit: SHA, branch: 'main', dirty: false, count: 383, builtAt: '2026-09-02T08:41:07Z' };

/* ------------------------------------------------------------------ normalize */

test('keeps a real 40-character commit and derives the short form', () => {
  const info = buildInfo.normalize(CLEAN);
  assert.equal(info.commit, SHA);
  assert.equal(info.shortCommit, 'a1b2c3d4e5');
  assert.equal(info.shortCommit.length, buildInfo.SHORT_LENGTH);
});

test('uppercase hashes are folded, so the same build never looks like two', () => {
  assert.equal(buildInfo.normalize({ ...CLEAN, commit: SHA.toUpperCase() }).commit, SHA);
});

test('anything that is not a 40-char hash is no commit at all', () => {
  // Half a hash is worse than none: it would still be shown, and it would still
  // be compared, while identifying nothing.
  for (const commit of ['a1b2c3d', 'main', '', null, 42, `${SHA}extra`, 'z'.repeat(40)]) {
    assert.equal(buildInfo.normalize({ ...CLEAN, commit }).commit, null, `for ${String(commit)}`);
  }
});

test('a corrupt or empty file degrades instead of throwing', () => {
  for (const raw of [null, undefined, '', 0, [], 'nonsense']) {
    assert.deepEqual(buildInfo.normalize(raw), {
      commit: null, shortCommit: null, branch: null, dirty: false, count: null, builtAt: null,
    });
  }
});

test('the build number is a positive integer or nothing', () => {
  // A string, a zero or a fraction is a truncated or hand-edited stamp, and a
  // build number that lies about which build this is would be worse than one
  // that is absent.
  assert.equal(buildInfo.normalize(CLEAN).count, 383);
  for (const count of ['383', 0, -1, 1.5, null, undefined, NaN]) {
    assert.equal(buildInfo.normalize({ ...CLEAN, count }).count, null, `for ${String(count)}`);
  }
});

test('dirty is only true when it is literally true', () => {
  // A truthy-but-not-true value ("false", 1) must not silently mark a release
  // build as dirty, it would suppress the commit as a cache fingerprint.
  assert.equal(buildInfo.normalize({ ...CLEAN, dirty: 'false' }).dirty, false);
  assert.equal(buildInfo.normalize({ ...CLEAN, dirty: true }).dirty, true);
});

/* ----------------------------------------------------------- readableVersion */

test('the version a person reads drops the build and commit tail', () => {
  // The defect this replaces: 0.0.1-dev.383.59f34d85a8 welded a version, a
  // count and a sha into one string everywhere a person read "the version".
  // What a person reads is the front of it; the count and the commit are rows
  // of their own on About (identityFields below).
  assert.equal(buildInfo.readableVersion('0.0.1-dev.383.59f34d85a8'), '0.0.1-dev');
});

test('a channel other than dev is read through the same function the check uses', () => {
  // The first prerelease identifier is the channel (channelOf), and it STAYS in
  // the version: it is what tells a reader, and the client-context block, that
  // this is not a stable build.
  assert.equal(buildInfo.readableVersion('1.2.3-beta.7.abcdef1234'), '1.2.3-beta');
});

test('a stable version is already a version', () => {
  assert.equal(buildInfo.readableVersion('1.0.1'), '1.0.1');
  assert.equal(buildInfo.readableVersion('  1.0.1\n'), '1.0.1');
});

test('a dirty dev build reads as the dev version, its marker going with the commit', () => {
  assert.equal(buildInfo.readableVersion('1.0.1-dev.148.758853d656.dirty'), '1.0.1-dev');
});

test('a string that is not a version is shown unchanged, not dressed up', () => {
  // Inventing a version for something that is not one would be worse than
  // showing what arrived; the row above still renders.
  for (const bad of ['latest', '', null, undefined, '1.2', 'v1.2.3']) {
    assert.equal(buildInfo.readableVersion(bad), bad == null ? '' : String(bad), `for ${String(bad)}`);
  }
});

/* ----------------------------------------------------------- identityFields */

test('the commit and the build number are rows of their own, not welded into the version', () => {
  assert.deepEqual(buildInfo.identityFields(CLEAN), [
    { label: 'Commit', value: 'a1b2c3d4e5' },
    { label: 'Build', value: '383' },
    { label: 'Built', value: '2026-09-02 08:41Z' },
  ]);
});

test('a branch other than main is named, because that is the surprising case', () => {
  assert.deepEqual(buildInfo.identityFields({ ...CLEAN, branch: 'fix-clicks' }).at(-1),
    { label: 'Branch', value: 'fix-clicks' });
});

test('a dirty tree says so on the commit, whose hash does not describe what was built', () => {
  assert.deepEqual(buildInfo.identityFields({ ...CLEAN, dirty: true })[0],
    { label: 'Commit', value: 'a1b2c3d4e5-dirty' });
});

test('running from source shows no identity rows rather than inventing one', () => {
  // npm start and the tests both land here; it is a normal state, not an error.
  assert.deepEqual(buildInfo.identityFields(buildInfo.normalize(null)), []);
});

test('a missing build date or count drops that row instead of printing a broken one', () => {
  assert.deepEqual(buildInfo.identityFields({ ...CLEAN, builtAt: null, count: null }),
    [{ label: 'Commit', value: 'a1b2c3d4e5' }]);
  assert.deepEqual(buildInfo.identityFields({ ...CLEAN, builtAt: 'whenever' }).map((r) => r.label),
    ['Commit', 'Build']);
});

/* -------------------------------------------------------------------- buildId */

test('a clean packaged build identifies itself by commit', () => {
  assert.equal(buildInfo.buildId(CLEAN), SHA);
});

test('a dirty build has no usable id', () => {
  // Every build from a dirty tree shares one hash, so trusting it would stop
  // detecting upgrades during precisely the work that rebuilds most often.
  assert.equal(buildInfo.buildId({ ...CLEAN, dirty: true }), null);
  assert.equal(buildInfo.buildId(buildInfo.normalize(null)), null);
});

/* ----------------------------------------------------------------------- read */

test('a missing build-info.json is the source-build shape, not a crash', () => {
  const missing = path.join(os.tmpdir(), 'chela-desktop-no-such-build-info.json');
  fs.rmSync(missing, { force: true });
  assert.equal(buildInfo.read(missing).commit, null);
});

test('reads a real generated file back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bi-')), 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(CLEAN));
  assert.equal(buildInfo.read(file).shortCommit, 'a1b2c3d4e5');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('malformed JSON on disk falls back rather than taking startup down', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bi-')), 'build-info.json');
  fs.writeFileSync(file, '{"commit": "a1b2c3');
  assert.equal(buildInfo.read(file).commit, null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

/* ------------------------------------------- the fingerprint it feeds into */

test('the commit is the fingerprint when there is one', () => {
  assert.equal(
    cache.buildFingerprint({ version: '1.0.0', commit: SHA }),
    `1.0.0:${SHA}`,
  );
});

test('two builds of one version differ by commit alone', () => {
  // The bug this replaces: both builds are 1.0.0, and before the stamp existed
  // the only thing separating them was the app bundle's mtime.
  assert.notEqual(
    cache.buildFingerprint({ version: '1.0.0', commit: SHA }),
    cache.buildFingerprint({ version: '1.0.0', commit: SHA.replace(/^a/, 'b') }),
  );
});

test('with no commit it still falls back to size and mtime', () => {
  assert.equal(
    cache.buildFingerprint({ version: '1.0.0', size: 171204, mtimeMs: 1788390000000, commit: null }),
    '1.0.0:171204:1788390000000',
  );
});

/* --------------------------------------------------- the generator, offline */

test('the generator reads the repo it lives in', () => {
  // Not asserting a specific hash, it moves every commit. What must hold is
  // that it produces a usable stamp for THIS checkout, which is the only way to
  // catch the git invocation itself breaking.
  const info = collectBuildInfo();
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof info.dirty, 'boolean');
  assert.ok(Number.isInteger(info.count) && info.count > 0, `no build number: ${info.count}`);
  assert.match(info.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('CI environment variables stand in when git is unavailable', () => {
  // A build from a tarball or an image with no .git, the workflow still knows
  // what it checked out.
  const info = collectBuildInfo({
    GITHUB_SHA: SHA, GITHUB_REF_NAME: 'v1.2.3', PATH: '/nonexistent',
  });
  assert.ok(info.commit, 'a commit should be resolved from somewhere');
});

/* ---------------------------------------------------------------- the About box */

// The About STATE is composed in main.js, which is Electron's entry and cannot
// be imported here, so this reads it the way the other desktop tests that reach
// it do (see about-reference.test.js). The values are pinned by the pure
// functions above; what is pinned here is the WIRING, because both halves fail
// silently: a header that stops using the readable version goes back to welding
// a commit into "the version", and a facts list that stops spreading the
// identity rows drops the commit and the build number from About entirely.
const MAIN = (() => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  // Comments stripped, so a quoted example is not read as code.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
})();

test('About shows the version a person reads, and the commit and build as their own rows', () => {
  assert.match(MAIN, /buildInfo\.readableVersion\(app\.getVersion\(\)\)/,
    'the About version is not the readable version, so it can still carry a commit');
  assert.match(MAIN, /buildInfo\.identityFields\(buildStamp\)/,
    'About does not carry the commit/build rows');
});

test('the client-context block carries the readable version, not the build version', () => {
  // The block names this client to an agent; welding the count and the sha into
  // that name is the reported defect.
  const block = MAIN.match(/function promptMetadataConfig\(\)[\s\S]*?\n\}/);
  assert.ok(block, 'promptMetadataConfig is gone');
  assert.match(block[0], /appVersion: buildInfo\.readableVersion\(app\.getVersion\(\)\)/,
    'the client-context block still sends the build version');
});

/* ---------------------------------------------------- the count CI hands over */

test('the commit count is read out of the version CI hands over', () => {
  assert.deepEqual(countFromVersion('0.0.1-dev.401.869926a290'), { count: 401, sha: '869926a290' });
});

test('anything that is not a dev version with a count and a sha yields nothing', () => {
  // The shape belongs to devVersion in scripts/version.js, so a caller that
  // guessed at it would be a second owner of it.
  for (const bad of ['1.0.1', '0.0.1-dev', '0.0.1-dev.401', '0.0.1-dev.0.869926a290', '0.0.1-dev.401.zzzzzzzzzz', 'latest', '', null]) {
    assert.equal(countFromVersion(bad), null, 'for ' + String(bad));
  }
});

test('the handed count is used when it names this commit, and git answers otherwise', () => {
  // CI's packaging job checks out depth 1, so git says 1 while the version job,
  // which has the full history, says 401. The version is the owner.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(HERE, '..', '..'), encoding: 'utf8' }).trim();
  assert.equal(collectBuildInfo({ CLAW_BUILD_VERSION: '0.0.1-dev.999.' + head.slice(0, 10) }).count, 999);
  const other = collectBuildInfo({ CLAW_BUILD_VERSION: '0.0.1-dev.999.0000000000' });
  assert.notEqual(other.count, 999);
});

test('the workspace cache the release workflow creates is ignored, not dirt', () => {
  // The stamp counts untracked files as dirt, and the workflow puts the
  // Electron caches under the workspace. A warm cache therefore made every CI
  // build stamp itself dirty, which About drew as a commit describing nothing.
  // Measured 2026-10-04: one file under .cache flipped collect() to dirty: true.
  const root = path.join(HERE, '..', '..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(workflow.includes('github.workspace }}/.cache/'),
    'the release workflow no longer creates a .cache inside the workspace');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('/.cache/'),
    'the workspace .cache is not ignored, so a warm-cache build reads as dirty');
});
