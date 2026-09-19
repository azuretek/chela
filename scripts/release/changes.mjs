// Whether a commit ships anything, and therefore whether anything may be
// released from it.
//
// ★ THE ONE PLACE. This file is the single owner of the release trigger set:
// which paths make a commit releasable, and which do not. Neither pipeline
// carries a path filter any more, so there is nothing here to keep in step with
// a second copy, and a test (desktop/test/release-trigger.test.js) fails if one
// is ever added back.
//
// The rule this implements is Abi's, 2026-09-18:
//
//   "we only need a release if something actually changed, so docs and other
//    things like that definitely do not need a release at all, feel free to skip
//    that"
//
// What that changed. The path filter used to decide whether a release WAITED for
// the other platform, and the answer for a commit touching only one client's tree
// was "publishing is unaffected". That escape is how a .github-only commit
// published a GitHub Release the phone read as an update while no TestFlight build
// existed behind it (v1.0.1-dev.279.9a58115cb1, PR #39). The filter now answers a
// different question: does anything get published from this commit AT ALL. A
// commit that ships waits for every platform, with no escape; a commit that does
// not ship publishes nothing at all, and neither pipeline publishes on its behalf.
//
// The classification is EXCLUSION rather than inclusion. A path ships unless it
// matches one of the entries below, so a directory nobody thought about when this
// file was written is treated as shipped and is gated by the whole matrix, rather
// than being silently exempt and never reaching anyone. The two failure directions
// are not equally bad: publishing a release for a commit that changed nothing
// costs a version number, while a shipped fix that never reaches anyone costs the
// fix.
//
//   node scripts/release/changes.mjs                      # reads the event from the environment
//   node scripts/release/changes.mjs --files a.md src/x.js
//   node scripts/release/changes.mjs --event push --before <sha> --sha <sha>
//
// Writes GitHub Actions outputs (release, reason) to $GITHUB_OUTPUT when it is
// set, and prints them otherwise, so it is testable without CI. Exits 1 when a
// release was explicitly asked for (a tag, a workflow_dispatch) and nothing
// shipped changed: that is a refusal, not a silent stand-down.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * ★ The rule. A changed path that matches NONE of these ships, and a commit
 * ships when ANY of its paths does.
 *
 * Each entry is here because the change it covers cannot alter a byte of either
 * client's build output. Anything not listed is treated as shipped, so this list
 * is the thing to extend when a new docs or tooling tree appears, and never a
 * gate to widen for convenience.
 */
export const NON_RELEASE_PATHS = [
  { pattern: /^docs\//, describes: 'docs/', why: 'documentation, not compiled into anything' },
  { pattern: /\.md$/, describes: '*.md', why: 'prose at any depth, including a client README' },
  { pattern: /^\.github\//, describes: '.github/', why: 'CI itself: workflows, the PR template, these conventions' },
  { pattern: /^\.githooks\//, describes: '.githooks/', why: 'local git hooks, which never run in CI' },
  { pattern: /^scripts\//, describes: 'scripts/', why: 'developer tooling reached from the root scripts' },
  // Carried over from the paths-ignore filter this replaces, and not in the
  // brief's list: neither file is compiled, packaged or read by a client.
  { pattern: /^LICENSE$/, describes: 'LICENSE', why: 'not compiled or packaged' },
  { pattern: /^\.gitignore$/, describes: '.gitignore', why: 'not compiled or packaged' },
];

/**
 * The shipped trees, named so the rule is readable rather than only derivable,
 * and so a test can assert each one still classifies as shipping. This list is
 * NOT the implementation: the implementation is NON_RELEASE_PATHS above, and
 * everything outside that list ships whether or not it is named here.
 */
export const RELEASE_PATHS = [
  'core/', // compiled into BOTH clients, spec and ui included
  'desktop/', // the Electron app
  'mobile/', // the iOS app
  'package.json', // the version both clients are named from
  'pnpm-lock.yaml', // what the desktop build installs
  'pnpm-workspace.yaml', // the workspace shape both JS halves build in
];

/** True when this one path can change what a client compiles, packages or runs. */
export function ships(file) {
  return !NON_RELEASE_PATHS.some((entry) => entry.pattern.test(file));
}

/**
 * Classify a changed-path list.
 *
 * @returns {{release: boolean, shipped: string[], ignored: string[], byReason: Record<string, string[]>}}
 */
export function classify(files) {
  const shipped = [];
  const ignored = [];
  const byReason = {};
  for (const file of files) {
    if (ships(file)) {
      shipped.push(file);
      continue;
    }
    ignored.push(file);
    const entry = NON_RELEASE_PATHS.find((candidate) => candidate.pattern.test(file));
    const bucket = byReason[entry.describes] || (byReason[entry.describes] = []);
    bucket.push(file);
  }
  return { release: shipped.length > 0, shipped, ignored, byReason };
}

/** `git diff --name-only <base> <sha>`, or null when there is no base to compare against. */
function changedFiles({ base, sha }) {
  if (!base) return null;
  const out = execFileSync('git', ['diff', '--name-only', base, sha], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** The release before this commit: the range a tag or a dispatch would ship. */
export function previousReleaseTag(sha) {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', sha + '^'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const ZERO = /^0{40}$/;

/**
 * Which files a run is about, and what that means for publication.
 *
 * @returns {{release: boolean, reason: string, files: string[]|null, explicit: boolean, base: string}}
 */
export function decide({ eventName, refType = 'branch', before = '', sha = 'HEAD', base = '' }) {
  // A tag and an on-demand dispatch are both an explicit request to release
  // something, so they are the two events where "nothing shipped" is an answer to
  // refuse rather than a reason to stand down quietly.
  const explicit = refType === 'tag' || eventName === 'workflow_dispatch';

  let rangeBase = '';
  let files = null;
  let reason = '';

  if (eventName === 'pull_request') {
    // A pull request ships nothing on any ref, so this answer only reports.
    rangeBase = base;
    files = changedFiles({ base: rangeBase, sha });
    reason = 'the pull request own changes, ' + rangeBase.slice(0, 9) + '..' + sha.slice(0, 9);
  } else if (explicit) {
    // What this release would ship: everything since the last release, rather
    // than only the tip commit. A tag on a merge commit releases the whole range.
    rangeBase = previousReleaseTag(sha);
    files = changedFiles({ base: rangeBase, sha });
    reason = rangeBase
      ? 'everything since ' + rangeBase + ', which is what this release would ship'
      : 'no previous release tag to compare against, so the whole history is treated as shipping';
  } else if (before && !ZERO.test(before)) {
    rangeBase = before;
    files = changedFiles({ base: rangeBase, sha });
    reason = 'the push itself, ' + rangeBase.slice(0, 9) + '..' + sha.slice(0, 9);
  } else {
    // A ref with no previous commit to compare against: a new branch, or the
    // first push of main. There is no honest range, and guessing "nothing
    // changed" would silently refuse to release a repository's first commit.
    files = null;
    reason = 'a ref with no previous commit to compare against, so this is treated as shipping';
  }

  if (files === null) return { release: true, reason, files, explicit, base: rangeBase };

  const verdict = classify(files);
  if (verdict.release) {
    return {
      release: true,
      reason: reason + ': ' + verdict.shipped.length + ' shipped path(s), starting with ' + verdict.shipped[0],
      files,
      explicit,
      base: rangeBase,
    };
  }

  const kinds = Object.keys(verdict.byReason)
    .map((describes) => describes + ' (' + verdict.byReason[describes].length + ')')
    .join(', ');
  return {
    release: false,
    reason: reason + ': ' + files.length + ' changed path(s), all of them non-release: ' + (kinds || 'none'),
    files,
    explicit,
    base: rangeBase,
  };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

export function run(argv, env = process.env) {
  const filesArg = argv.indexOf('--files');
  const explicitFiles = filesArg >= 0 ? argv.slice(filesArg + 1).filter((a) => !a.startsWith('--')) : null;

  const eventName = arg(argv, 'event', env.GITHUB_EVENT_NAME || 'push');
  const refType = arg(argv, 'ref-type', env.GITHUB_REF_TYPE || 'branch');
  const sha = arg(argv, 'sha', env.GITHUB_SHA || 'HEAD');

  let result;
  if (explicitFiles) {
    const verdict = classify(explicitFiles);
    result = {
      release: verdict.release,
      reason: verdict.release
        ? verdict.shipped.length + ' shipped path(s), starting with ' + verdict.shipped[0]
        : explicitFiles.length + ' changed path(s), all of them non-release',
      files: explicitFiles,
      explicit: refType === 'tag' || eventName === 'workflow_dispatch',
      base: '',
    };
  } else {
    result = decide({
      eventName,
      refType,
      before: arg(argv, 'before', env.GITHUB_EVENT_BEFORE || ''),
      base: arg(argv, 'base', env.GITHUB_BASE_SHA || ''),
      sha,
    });
  }

  console.log('release=' + result.release);
  console.log(result.release
    ? 'this commit ships something, so it is releasable once every platform is green'
    : 'this commit ships nothing: no version is bumped and nothing is published');
  console.log('  why: ' + result.reason);

  if (env.GITHUB_OUTPUT) {
    // One line per output, and the reason is collapsed to a single line: a
    // newline inside it would end the output early and silently.
    const line = result.reason.replace(/[\r\n]+/g, ' ');
    fs.appendFileSync(env.GITHUB_OUTPUT, 'release=' + result.release + '\nreason=' + line + '\n');
  }

  if (result.explicit && !result.release) {
    console.error('');
    console.error('::error::a release was asked for and this commit ships nothing.');
    console.error('  ' + result.reason);
    console.error('A tag and a workflow_dispatch both mean "release this", so publishing nothing quietly would');
    console.error('leave a release that was asked for and never happened. Put the tag on a commit that ships');
    console.error('something, or dispatch a ref that does.');
    process.exitCode = 1;
  }

  return result;
}

// Run when invoked as a script. The check compares two filesystem paths: the
// module's own path and the resolved entry path. The earlier form compared
// import.meta.url (a file:// URL) with fileURLToPath(import.meta.url) (a path),
// which is always false, so run() never fired and every release silently stood
// down. Guarded now by a subprocess test, not just a direct run() import.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2));
}
