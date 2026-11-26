// The iOS legs boot their simulator without the services the tests never use (#190).
//
// A fresh simulator starts about 300 processes, and on the 3-core, 7.5 GB runners
// that filled memory and starved the processes an app launch waits on, so the
// first UI launch took up to 220 s and failed the leg. The leg now boots the
// device itself with the jobs in mobile/scripts/sim-disabled-jobs.txt turned off.
// This holds that in place, because each part is a line someone can drop for
// looking redundant:
//
//   the boot happens before the tests     the test step must find the device
//                                         already booted, or xcodebuild boots
//                                         it again with every service running
//   the flags reach simctl                one --disabledJob per listed job
//   the list stays a list of jobs         launchd labels, no duplicates, and
//                                         none of the services a launch needs
//   the launch report runs                a launch drifting back toward the
//                                         timeout is visible while still green

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const pipeline = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'mobile-pipeline.yml'), 'utf8').replace(/\r\n?/g, '\n');
const BOOT = path.join(ROOT, 'mobile', 'scripts', 'sim-boot.sh');
const LIST = path.join(ROOT, 'mobile', 'scripts', 'sim-disabled-jobs.txt');

// The services an app launch, a terminate or XCTest's automation goes through,
// and the ones the app itself uses. Turning any of these off would not save the
// leg, it would break it.
const NEEDED = [
  'com.apple.SpringBoard', 'com.apple.backboardd', 'com.apple.runningboardd', 'com.apple.lsd',
  'com.apple.installd', 'com.apple.testmanagerd', 'com.apple.nsurlsessiond', 'com.apple.securityd',
  'com.apple.cfprefsd.xpc.daemon', 'com.apple.accessibility.AccessibilityUIServer', 'com.apple.mobile.installd',
  'com.apple.CoreSimulator.bridge', 'com.apple.containermanagerd', 'com.apple.coreservices.useractivityd',
];

function jobs() {
  return fs.readFileSync(LIST, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

// The test job's steps, by name, in order, each with the text of its block.
function testJobSteps() {
  const start = pipeline.indexOf('\n  test:\n');
  const end = pipeline.indexOf('\n  release:\n', start);
  assert.ok(start > 0 && end > start, 'mobile-pipeline.yml no longer has its test job ahead of the release job');
  return pipeline.slice(start, end).split('\n      - ').slice(1).map((block) => {
    const name = (/^\s*name: (.+)$/m.exec(block) || [])[1] || block.split('\n')[0];
    return { name: name.trim(), block };
  });
}

function stepIndex(steps, name) {
  const i = steps.findIndex((s) => s.name === name);
  assert.ok(i >= 0, 'the iOS test job has no step named "' + name + '"');
  return i;
}

test('the simulator is booted lean, after the compile and before the tests', () => {
  const steps = testJobSteps();
  const build = stepIndex(steps, 'Build for the simulator');
  const boot = stepIndex(steps, 'Boot the simulator without the services the tests never use');
  const tests = stepIndex(steps, 'Test on the resolved simulator');
  assert.ok(build < boot && boot < tests,
    'the order must be build, boot, then test: a boot under the compile slows the compile, and a test step that boots the device itself boots it with every service running');
  assert.match(steps[boot].block, /scripts\/sim-boot\.sh "\$SIMULATOR_UDID"/, 'the boot step no longer boots the resolved device through sim-boot.sh');
  assert.match(steps[tests].block, /-destination "platform=iOS Simulator,id=\$SIMULATOR_UDID"/, 'the tests no longer run on the device that was booted');
});

test('every launch the UI tests wait for is reported', () => {
  const steps = testJobSteps();
  const tests = steps[stepIndex(steps, 'Test on the resolved simulator')];
  const report = steps[stepIndex(steps, 'Report how long the UI tests waited for the app')];
  assert.match(tests.block, /tee "\$RUNNER_TEMP\/test\.log"/, 'the test step no longer keeps the log the launch report reads');
  assert.match(report.block, /if: always\(\)/, 'the launch report must run when the tests fail too, since a failed launch is the case it exists for');
  assert.match(report.block, /ui_launch_times\.py "\$RUNNER_TEMP\/test\.log"/, 'the launch report no longer reads the test log');
  stepIndex(steps, 'Test the UI launch report');
});

test('the disabled jobs are launchd labels, listed once, and none a launch needs', () => {
  const list = jobs();
  assert.ok(list.length >= 10, 'sim-disabled-jobs.txt lists only ' + list.length + ' jobs; the widget host and the services named in #190 are the point of it');
  assert.ok(list.includes('com.apple.chronod'), 'the widget host is the largest of them and is no longer disabled');
  for (const job of list) assert.match(job, /^com\.apple\.[A-Za-z0-9.-]+$/, job + ' is not a launchd label');
  assert.equal(new Set(list).size, list.length, 'a job is listed twice');
  const needed = list.filter((job) => NEEDED.includes(job));
  assert.deepEqual(needed, [], 'these are services an app launch or the tests go through: ' + needed.join(', '));
});

test('sim-boot.sh hands simctl one --disabledJob per listed job, then waits for the boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-boot-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'xcrun'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
  const run = spawnSync('bash', [BOOT, 'DEVICE'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, CALLS: calls } });
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(seen.length, 2, 'expected a boot and a bootstatus, got: ' + seen.join(' | '));
  assert.equal(seen[0], ['simctl boot DEVICE', ...jobs().map((j) => '--disabledJob=' + j)].join(' '), 'the boot did not carry every listed job');
  assert.equal(seen[1], 'simctl bootstatus DEVICE -b', 'the boot is not waited for');
  assert.match(run.stdout, new RegExp('with ' + jobs().length + ' jobs disabled'), run.stdout);
});
