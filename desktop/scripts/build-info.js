
// Stamp the commit a build was made from into the app bundle.
//
// The version in package.json is hand-maintained and in practice does not move,
// every build so far is `1.0.0`, so it cannot answer the one question that
// actually comes up: is the thing installed on that machine the thing I just
// built? Working that out has meant stat-ing `app.asar` and comparing its
// mtime against a commit timestamp, which is guesswork dressed up as evidence.
//
// This runs as electron-builder's `beforePack` hook, so it covers `npm run
// pack`, every `build:*` script and CI from one place. It is also runnable on
// its own (`node scripts/build-info.js`) when regenerating by hand.
//
// The output is generated, never committed: a commit cannot contain its own
// hash, so a checked-in copy would be wrong by construction. `npm start` and
// the tests run with no file at all, which src/build-info.js reports as a
// source build rather than inventing an identity.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from './version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const OUT = path.join(ROOT, 'src', 'build-info.json');

/** A git command, or null if git has nothing to say. Never throws. */
function git(...args) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The commit count a CI build carries, and the commit it names.
 *
 * "0.0.1-dev.401.869926a290" -> { count: 401, sha: "869926a290" }. Anything
 * else is null: the shape belongs to devVersion in scripts/version.js, and a
 * second reading of it here would be a second owner of it.
 */
export function countFromVersion(version) {
  const parsed = parse(version);
  if (!parsed || !parsed.prerelease) return null;
  const parts = String(parsed.prerelease).split('.');
  if (parts[0] !== 'dev' || parts.length < 3) return null;
  const count = Number(parts[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(parts[2])) return null;
  return { count, sha: parts[2].toLowerCase() };
}

/**
 * Collect the identity of the tree being packaged.
 *
 * Git is asked first and the environment second, because git describes the
 * source that is actually being compiled while `GITHUB_SHA` describes what the
 * workflow was triggered for. In CI they cannot disagree, the workflow pins
 * both checkouts to `github.sha` for exactly this reason, so the fallback is
 * for a checkout with no git at all. Where they could differ, the compiled tree
 * is the honest answer.
 */
export function collect(env = process.env) {
  const commit = git('rev-parse', 'HEAD') || env.GITHUB_SHA || null;

  // `--porcelain` prints one line per modified path and nothing at all for a
  // clean tree, so emptiness is the test. Untracked files count: they are
  // inside `src/**` for packaging purposes and can change what ships.
  const status = git('status', '--porcelain');
  const dirty = status !== null && status !== '';

  // Detached HEAD, which is how actions/checkout leaves every CI build, since
  // the workflow pins `ref` to a sha, reports the branch as the literal
  // "HEAD", which names nothing. GITHUB_REF_NAME still carries the branch.
  const head = git('rev-parse', '--abbrev-ref', 'HEAD');
  const branch = (head && head !== 'HEAD' ? head : null) || env.GITHUB_REF_NAME || null;

  // The build number: reachable commits, the same count the dev version leads
  // with and the number build-version.js publishes to CI because Apple accepts
  // it as a bundle build number. Stamped here too so About can show it in a
  // field of its own rather than the version string carrying it.
  //
  // ★ The version CI hands over wins when it names this commit. The packaging
  // job checks out at depth 1 on purpose, so rev-list --count answers 1 there,
  // and About then read "Build 1" for a build whose own version said 401: one
  // question with two answers, the wrong one inside the app. The version job
  // has the full history and is the owner of the number, and the sha inside it
  // says the number belongs to this commit.
  const handed = countFromVersion(env.CLAW_BUILD_VERSION);
  const counted = Number(git('rev-list', '--count', 'HEAD'));
  const fromGit = Number.isInteger(counted) && counted > 0 ? counted : null;
  const count = handed && commit && commit.startsWith(handed.sha) ? handed.count : fromGit;

  return {
    commit,
    branch,
    dirty,
    count,
    // Second precision: this is read by a human, and a fingerprint that carried
    // millisecond noise would differ between two builds of the same commit.
    builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function write(info = collect(), file = OUT) {
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

// electron-builder awaits the default export before packing. Logging the stamp
// is deliberate: a CI log that does not say which commit it built is the same
// hole this file exists to close.
export default async function beforePack() {
  const info = write();
  const label = info.commit ? info.commit.slice(0, 10) : 'unknown';
  console.log(`  \u2022 stamping build  commit=${label}${info.dirty ? ' (dirty)' : ''} branch=${info.branch || '-'}`);
}

// `--clear` runs as `prestart`. A local `npm run pack` leaves a stamp on disk,
// and without this the next `npm start` would report that commit as though it
// had been packaged, quietly stale the moment anything else is committed.
// Removing it restores the documented behaviour: a source run claims no commit.
// True when this file is the entry point, on every platform. See scripts/build.js
// for why the naive `file://${process.argv[1]}` comparison is POSIX-only.
function isEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isEntry()) {
  if (process.argv.includes('--clear')) {
    fs.rmSync(OUT, { force: true });
    process.exit(0);
  }
  const info = write();
  console.log(`${OUT}\n${JSON.stringify(info, null, 2)}`);
}
