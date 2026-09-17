// The release gate, held to its sources.
//
// Abi's rule, 2026-09-16: no release before everything is working for all
// platforms. Two halves of that live in the workflow and one lives in a script,
// and this test is the third thing that keeps them agreeing:
//
//   `release.needs` + its `if`   a FAILED build leg skips the release job. The
//                                `if` must never carry a status function
//                                (`always()`, `!cancelled()`), because that is
//                                what would publish a release with a platform
//                                missing. The workflow comment says so; this
//                                asserts it, because the line that breaks it is
//                                one word long and looks helpful.
//
//   check-release-artifacts.js   a build leg that SUCCEEDS without producing its
//                                installer, or without the update metadata an
//                                updater reads, still must not publish.
//
//   the fixtures below           prove the script names what is missing, and
//                                derive every name from the workflow matrix and
//                                electron-builder.yml rather than restating them,
//                                so a platform or a target added to either one is
//                                gated the day it is added.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  WORKFLOW,
  EXTENSIONS,
  platformsFromWorkflow,
  targetsFromBuilder,
  audit,
} from '../scripts/check-release-artifacts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const SCRIPT = path.join(DESKTOP, 'scripts', 'check-release-artifacts.js');

const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * One job's own text. The job ends at the next key at two spaces, or at the end
 * of the file: `release` is the last job in the workflow, so a lookahead that
 * only accepts a following key never matches it.
 */
function jobOf(yml, name) {
  return new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=\\n  \\S|$(?![\\s\\S]))`, 'm').exec(yml);
}

/** A release where every platform the matrix names is present and complete. */
function completeRelease(root) {
  const entries = platformsFromWorkflow();
  const targets = targetsFromBuilder();
  for (const { artifact, platform } of entries) {
    const dir = path.join(root, `claw-${artifact}-1.2.3`);
    fs.mkdirSync(dir, { recursive: true });
    for (const target of targets.get(platform)) {
      fs.writeFileSync(path.join(dir, `installer${EXTENSIONS.get(target)}`), 'x');
    }
    fs.writeFileSync(path.join(dir, 'dev.yml'), 'version: 1.2.3\n');
  }
  return entries;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-release-'));
  const entries = completeRelease(root);
  return { root, entries };
}

test('a complete release passes, and the script exits zero on it', () => {
  const { root } = fixture();
  assert.deepEqual(audit(root), [], 'a release with every platform in it was reported as incomplete');
  const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /every platform is in the release/);
});

test('a platform missing from the artifacts refuses the release, by name', () => {
  const { root, entries } = fixture();
  // Whichever platform the matrix lists last, so this cannot go stale.
  const gone = entries[entries.length - 1];
  fs.rmSync(path.join(root, `claw-${gone.artifact}-1.2.3`), { recursive: true });
  const problems = audit(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`^${gone.artifact}:`), 'the platform that is missing must be named');
  const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(run.status, 1, 'a release missing a platform must not be published');
  assert.match(run.stderr, new RegExp(`MISSING|${gone.artifact}`));
});

test('a platform present without one of its installers refuses the release', () => {
  // The leg succeeded, so `needs` does not save us: this is the half the script
  // exists for. electron-builder declares more than one target for at least one
  // platform, and every one of them is in the release or the release is wrong.
  const { root, entries } = fixture();
  const targets = targetsFromBuilder();
  const multi = entries.find(({ platform }) => targets.get(platform).length > 1);
  assert.ok(multi, 'this check needs a platform with more than one target to test against');
  const dir = path.join(root, `claw-${multi.artifact}-1.2.3`);
  const dropped = targets.get(multi.platform)[targets.get(multi.platform).length - 1];
  fs.rmSync(path.join(dir, `installer${EXTENSIONS.get(dropped)}`));
  const problems = audit(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`^${multi.artifact}:`));
  assert.match(problems[0], new RegExp(dropped), 'the missing target must be named');
});

test('a platform present without update metadata refuses the release', () => {
  // A release nobody can update from, which looks published and reaches no
  // client: its updater walks past a release with no metadata for it.
  const { root } = fixture();
  const first = platformsFromWorkflow()[0];
  fs.rmSync(path.join(root, `claw-${first.artifact}-1.2.3`, 'dev.yml'));
  const problems = audit(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /update metadata/);
});

test('nothing at all is refused too, in one line rather than three', () => {
  const run = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'claw-absent-release')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no artifacts directory/);
  assert.doesNotMatch(run.stdout, /present/, 'three platforms must not be reported present when there is no directory');
});

test('the release job is skipped when any build leg fails', () => {
  const yml = read(WORKFLOW);
  const job = jobOf(yml, 'release');
  assert.ok(job, 'the release job was not found in release.yml');
  const needs = /needs:\s*\[([^\]]*)\]/.exec(job[1]);
  assert.ok(needs, 'the release job has no needs list');
  const wanted = needs[1].split(',').map((s) => s.trim());
  assert.ok(wanted.includes('build'), 'the release must need the build job, or a failed platform leg cannot stop it');
  const condition = /if:\s*(.+)/.exec(job[1]);
  assert.ok(condition, 'the release job has no if, so it would publish on any successful build');
  for (const status of ['always(', 'cancelled(', 'failure(']) {
    assert.ok(
      !condition[1].includes(status),
      `the release job's condition uses ${status}, which would publish a release even when a platform leg failed`,
    );
  }
});

test('the workflow runs the gate, and it runs before anything is published', () => {
  const yml = read(WORKFLOW);
  const job = jobOf(yml, 'release');
  const gate = job[1].indexOf('check-release-artifacts.js');
  assert.ok(gate !== -1, 'the release job does not run the artifact gate');
  const publish = job[1].indexOf('action-gh-release');
  assert.ok(publish !== -1, 'the release job no longer publishes');
  assert.ok(gate < publish, 'the gate must run before the release is published, not after');
});

test('every target and platform we build is one the gate knows', () => {
  // The two readers are the only place this check gets its list, and this is the
  // assertion that keeps that true: a new target type in electron-builder.yml, or
  // a new platform in the matrix, fails here until the gate covers it.
  for (const [platform, targets] of targetsFromBuilder()) {
    for (const target of targets) {
      assert.ok(EXTENSIONS.has(target), `${platform} declares ${target}, which the gate has no extension for`);
    }
  }
  const artifacts = platformsFromWorkflow().map(({ artifact }) => artifact);
  assert.deepEqual(artifacts.slice().sort(), ['linux', 'macos', 'windows'],
    'the matrix platforms changed, so review what the gate is now gating on');
});
