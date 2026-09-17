// Gate the release on every platform being in it, before anything is published.
//
// The release job cannot run when a build leg fails: its `needs` covers the build
// job, so a red leg skips publishing, which is exactly what happened on
// 2026-09-16 while the Windows leg was failing. That is only half of the claim
// Abi asked for ("no release before everything is working for all platforms"),
// because a leg can also SUCCEED without producing the file it exists for: an
// installer the packager silently skipped, an upload path that stopped matching,
// a platform dropped from one side of the comparison. `fail_on_unmatched_files`
// on the release action catches "nothing at all", which is a different claim from
// "every platform, every target electron-builder declares for it, and the update
// metadata an updater reads".
//
// The last one is not decoration. A release whose `dev-mac.yml` is missing is one
// every client's updater walks past in silence, so the release looks published
// and reaches nobody.
//
// Neither list is restated here. The platforms come from the build matrix in the
// workflow, and the installer types come from electron-builder's own targets, so
// a platform or a target added there is gated on the day it is added.
// desktop/test/release-artifacts.test.js holds both readings to their sources and
// proves this names what is missing.
//
//   node scripts/check-release-artifacts.js <artifacts-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
export const WORKFLOW = path.join(REPO, '.github', 'workflows', 'release.yml');
export const BUILDER = path.join(DESKTOP, 'electron-builder.yml');

/**
 * The target name electron-builder writes in electron-builder.yml, and the file
 * extension it produces. The audit requires every target a platform declares, so
 * a new target type in the builder config is a gap here until it is named.
 */
export const EXTENSIONS = new Map([
  ['dmg', '.dmg'],
  ['zip', '.zip'],
  ['nsis', '.exe'],
  ['AppImage', '.AppImage'],
]);

/** Every platform the release must carry, read from the build matrix. */
export function platformsFromWorkflow(file = WORKFLOW) {
  const yml = fs.readFileSync(file, 'utf8');
  const matrix = /matrix:\s*\n\s*include:\s*\n([\s\S]*?)\n\s*runs-on:/.exec(yml);
  if (!matrix) throw new Error('the build matrix was not found in release.yml');
  const entries = [...matrix[1].matchAll(
    /-\s*os:\s*(\S+)\s*\n\s*script:\s*build:(\w+)\s*\n\s*artifact:\s*(\S+)/g,
  )].map(([, os, platform, artifact]) => ({ os, platform, artifact }));
  if (!entries.length) throw new Error('the build matrix listed no platforms');
  return entries;
}

/** Every installer target each platform declares, read from electron-builder.yml. */
export function targetsFromBuilder(file = BUILDER) {
  const yml = fs.readFileSync(file, 'utf8');
  const out = new Map();
  for (const platform of ['mac', 'win', 'linux']) {
    // From the platform's own key to the next key at column 0, or the end of the
    // file: `linux` is the last block, and a lookahead that only accepts a
    // following key never matches it. `$(?![\s\S])` is "end of input" under the
    // `m` flag, where a bare `$` would match at every line end.
    const block = new RegExp(`^${platform}:[\\s\\S]*?^  target:\\s*\\n([\\s\\S]*?)(?=\\n\\S|$(?![\\s\\S]))`, 'm').exec(yml);
    if (!block) throw new Error(`no targets for ${platform} in electron-builder.yml`);
    const target = [...block[1].matchAll(/-\s*target:\s*(\S+)/g)].map(([, name]) => name);
    if (!target.length) throw new Error(`no target names for ${platform}`);
    out.set(platform, target);
  }
  return out;
}

/** Every file under a directory, relative names only, for a shape-agnostic read. */
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(entry.name);
  }
  return out;
}

/**
 * What this release would be missing. Empty means every platform is in it, with
 * each installer its builder config declares and the metadata an updater reads.
 */
export function audit(artifactsDir, entries = platformsFromWorkflow(), targets = targetsFromBuilder()) {
  const problems = [];
  if (!fs.existsSync(artifactsDir)) return [`no artifacts directory at ${artifactsDir}`];

  for (const { artifact, platform } of entries) {
    const wanted = targets.get(platform);
    if (!wanted) {
      problems.push(`${platform}: the build matrix names it but electron-builder.yml declares no targets`);
      continue;
    }
    const dirs = fs.readdirSync(artifactsDir)
      .filter((name) => name.startsWith(`claw-${artifact}-`))
      .map((name) => path.join(artifactsDir, name))
      .filter((full) => fs.statSync(full).isDirectory());
    if (!dirs.length) {
      problems.push(`${artifact}: no claw-${artifact}-* artifact, so this release is missing a platform`);
      continue;
    }
    const files = dirs.flatMap(filesUnder);
    for (const target of wanted) {
      const ext = EXTENSIONS.get(target);
      if (!ext) problems.push(`${artifact}: electron-builder declares ${target} and this check does not know its extension`);
      else if (!files.some((name) => name.endsWith(ext))) problems.push(`${artifact}: no ${target} installer (${ext}) in the artifact`);
    }
    if (!files.some((name) => name.endsWith('.yml'))) {
      problems.push(`${artifact}: no update metadata (*.yml), so no client's updater can resolve this release`);
    }
  }
  return problems;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/check-release-artifacts.js <artifacts-dir>');
    process.exit(2);
  }
  const entries = platformsFromWorkflow();
  const problems = audit(dir, entries, targetsFromBuilder());
  // Readable per-platform lines, but only when there is a directory to read: a
  // missing one is reported once rather than as three platforms "present".
  if (fs.existsSync(dir)) {
    for (const { artifact, platform } of entries) {
      const bad = problems.some((problem) => problem.startsWith(`${artifact}:`));
      console.log(`${bad ? 'MISSING' : 'present'}  ${artifact} (${platform})`);
    }
  }
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) {
    console.error(`refusing to publish: ${problems.length} problem(s), listed above`);
    process.exit(1);
  }
  console.log('every platform is in the release, with its installers and its update metadata');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
