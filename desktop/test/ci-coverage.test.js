// Every desktop proof harness reaches CI, or says why it cannot.
//
// Abi, 2026-09-25: "we should see if we can validate everything in CI, CI should
// help us catch regressions and issues with our changes". Until then the boot
// smoke, the page measurements and every proof harness under desktop/scripts ran
// only in the local git hooks, which are advisory and skippable, and the merge
// gate passed PR #88 while its iOS suites were still running.
//
// What this holds in place:
//
//   every harness is accounted for   a test-*, prove-*, capture-* or measure-*
//                                    script is run by CI (scripts/desktop-proofs.mjs
//                                    or npm run measure) or named in NOT_IN_CI with
//                                    its reason. A new harness nobody wired up
//                                    fails here instead of sitting outside CI.
//   the desktop job runs them        ci.yml runs the smoke, measure, the packed
//                                    audit and every group the runner defines.
//   the merge gate waits for all     the gate needs the desktop job and the iOS
//                                    suites, and the iOS suites are read from the
//                                    pull request's head commit.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEASURE, NOT_IN_CI, PROOFS } from '../../scripts/desktop-proofs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SCRIPTS = path.join(ROOT, 'desktop', 'scripts');
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n?/g, '\n');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));

const HARNESS = /^(test|prove|capture|measure)-.+\.(js|mjs|cjs|sh)$/;

test('every desktop harness is run by CI or named with the reason it is not', () => {
  const harnesses = fs.readdirSync(SCRIPTS).filter((f) => HARNESS.test(f));
  assert.ok(harnesses.length > 20, 'found only ' + harnesses.length + ' harnesses under desktop/scripts; the pattern no longer matches them');
  const run = new Set([...PROOFS.map((p) => p.script), ...MEASURE]);
  const missing = harnesses.filter((f) => !run.has(f) && !(f in NOT_IN_CI));
  assert.deepEqual(missing, [], 'these harnesses are neither run by CI nor named in NOT_IN_CI (scripts/desktop-proofs.mjs): ' + missing.join(', '));
});

test('a harness is either run or excused, never both, and every one named exists', () => {
  const run = new Set([...PROOFS.map((p) => p.script), ...MEASURE]);
  for (const script of Object.keys(NOT_IN_CI)) {
    assert.ok(!run.has(script), script + ' is both run by CI and excused from it');
    assert.ok(NOT_IN_CI[script].length > 30, script + ' is excused without a reason anyone could check');
  }
  for (const script of [...run, ...Object.keys(NOT_IN_CI)]) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, script)), script + ' is named but does not exist under desktop/scripts');
  }
  const names = PROOFS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'two harness runs share a name, so a red one could not be told apart');
});

test('npm run measure runs exactly the harnesses the runner calls MEASURE', () => {
  const inScript = [...pkg.scripts.measure.matchAll(/scripts\/([\w.-]+)/g)].map((m) => m[1]);
  assert.deepEqual(inScript, MEASURE);
});

test('the desktop job runs the smoke, measure, the packed audit and every group', () => {
  const job = ci.slice(ci.indexOf('\n  desktop:\n'), ci.indexOf('\n  ios:\n'));
  assert.ok(job.length > 100, 'ci.yml has no desktop job before the ios job');
  assert.match(job, /xvfb-run[^\n]*pnpm run smoke\n/, 'the desktop job no longer runs the boot smoke');
  assert.match(job, /xvfb-run[^\n]*pnpm run measure/, 'the desktop job no longer runs npm run measure');
  assert.match(job, /pnpm run check:package/, 'the desktop job no longer audits the packaged artifact');
  assert.match(job, /pnpm run smoke:packed/, 'the desktop job no longer boots the packed app');
  for (const group of new Set(PROOFS.map((p) => p.group))) {
    assert.ok(job.includes('desktop-proofs.mjs --group ' + group + ' '), 'the desktop job does not run the ' + group + ' group');
  }
  // Every step after the first runs even when an earlier one failed, so one red
  // harness never hides the next.
  const steps = job.split('\n      - ').slice(1).filter((s) => /xvfb-run|check:package|build:desktop/.test(s));
  const unguarded = steps.filter((s) => !s.includes('!cancelled()'));
  assert.deepEqual(unguarded.map((s) => s.split('\n')[0]), [], 'these steps are skipped whenever an earlier one fails');
});

test('the merge gate needs the desktop job and the iOS suites, read at the head commit', () => {
  assert.match(ci, /\n {4}needs: \[changes, js, ios, desktop, mobile\]\n/, 'the merge gate does not need every job');
  const mobile = ci.slice(ci.indexOf('\n  mobile:\n'), ci.indexOf('\n  gate:\n'));
  assert.match(mobile, /uses: \.\/\.github\/workflows\/platforms-gate\.yml/);
  assert.match(mobile, /platform: chela-mobile pipeline/);
  assert.match(mobile, /sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, 'the iOS suites must be read at the head commit: github.sha on a pull request is the merge commit, which no mobile run carries');
  // Only the publish half, which a pull request skips by design, is exempt.
  assert.match(mobile, /exempt: '\^version\$\|\^release\$\|\^every platform must be green'/);
  const gate = ci.slice(ci.indexOf('\n  gate:\n'));
  assert.match(gate, /check "desktop \(Linux, xvfb\)" "\$JS_NEEDED" "\$DESKTOP"/);
  assert.match(gate, /check "iOS suites \(chela-mobile pipeline\)" "\$MOBILE_NEEDED" "\$MOBILE"/);
  assert.match(gate, /MOBILE_NEEDED: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('the runner lists what it runs and refuses a group it does not know', () => {
  const runner = path.join(ROOT, 'scripts', 'desktop-proofs.mjs');
  const list = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  for (const p of PROOFS) assert.ok(list.stdout.includes(p.name), p.name + ' missing from --list');
  const bad = spawnSync(process.execPath, [runner, '--group', 'no-such-group'], { encoding: 'utf8' });
  assert.equal(bad.status, 2, 'an unknown group must refuse rather than pass having run nothing');
});
