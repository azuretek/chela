// The iOS legs test on a simulator that has finished booting and has had the
// services the tests never use stopped (#190).
//
// A booted simulator runs about 300 processes, and on the 3-core, 7.5 GB runners
// that kept the CPU at 100% and memory full through the test step: the first UI
// launch took up to 220 s and failed the leg. This holds the fix in place,
// because each part is a line someone can drop for looking redundant:
//
//   the boot is waited for            sim-boot.sh boots, then waits for the boot
//                                     to finish, then stops the listed services
//   it happens before the tests       after the compile, before the test step,
//                                     on the device the tests run on
//   the list stays a list of jobs     launchd labels, once each, and none of the
//                                     services an app launch needs
//   the launch report runs            a launch drifting back toward the timeout
//                                     is visible while the leg is still green

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
const BOOT_STEP = 'Boot the simulator and stop what the tests never use';

// The services an app launch, a terminate or XCTest's automation goes through,
// and the ones the app itself uses. Stopping any of these would not save the leg,
// it would break it.
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

test('the simulator is booted and waited for after the compile and before the tests', () => {
  const steps = testJobSteps();
  const build = stepIndex(steps, 'Build for the simulator');
  const boot = stepIndex(steps, BOOT_STEP);
  const tests = stepIndex(steps, 'Test on the resolved simulator');
  assert.ok(build < boot && boot < tests,
    'the order must be build, boot, then test: a boot under the compile slows the compile, and a test step that boots the device itself starts testing before the boot has finished');
  assert.match(steps[boot].block, /scripts\/sim-boot\.sh "\$SIMULATOR_UDID"/, 'the boot step no longer boots the resolved device through sim-boot.sh');
  assert.match(steps[tests].block, /-destination "platform=iOS Simulator,id=\$SIMULATOR_UDID"/, 'the tests no longer run on the device that was booted');
});

test('sim-boot.sh boots, waits for the boot to finish, then stops every listed service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-boot-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'xcrun'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
  const run = spawnSync('bash', [BOOT, 'DEVICE'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, CALLS: calls } });
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(seen.slice(0, 2), ['simctl boot DEVICE', 'simctl bootstatus DEVICE -b'],
    'the boot must be followed by bootstatus -b, which is what waits for the boot to finish rather than to start');
  for (const job of jobs()) {
    for (const domain of ['user/foreground', 'system']) {
      assert.ok(seen.includes('simctl spawn DEVICE launchctl disable ' + domain + '/' + job), job + ' is not disabled in ' + domain);
      assert.ok(seen.includes('simctl spawn DEVICE launchctl bootout ' + domain + '/' + job), job + ' is not stopped in ' + domain);
    }
  }
  assert.equal(seen.length, 2 + jobs().length * 4, 'sim-boot.sh ran something the list does not name: ' + seen.slice(2).join(' | '));
  assert.match(run.stdout, /reported Booted after \d+ s and finished booting after \d+ s/, run.stdout);
  assert.match(run.stdout, new RegExp('stopped ' + jobs().length * 2 + ' services'), run.stdout);
});

test('a boot that fails stops the leg rather than testing on a half-booted device', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-boot-'));
  fs.writeFileSync(path.join(dir, 'xcrun'), '#!/bin/sh\n[ "$2" = boot ] && exit 164\nexit 0\n', { mode: 0o755 });
  const run = spawnSync('bash', [BOOT, 'DEVICE'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(run.status, 0, 'a failed boot was reported as a finished one');
});

test('the stopped services are launchd labels, listed once, and none a launch needs', () => {
  const list = jobs();
  assert.ok(list.length >= 10, 'sim-disabled-jobs.txt lists only ' + list.length + ' services; the widget host and the services named in #190 are the point of it');
  assert.ok(list.includes('com.apple.chronod'), 'the widget host is the largest of them and is no longer stopped');
  for (const job of list) assert.match(job, /^com\.apple\.[A-Za-z0-9.-]+$/, job + ' is not a launchd label');
  assert.equal(new Set(list).size, list.length, 'a service is listed twice');
  const needed = list.filter((job) => NEEDED.includes(job));
  assert.deepEqual(needed, [], 'these are services an app launch or the tests go through: ' + needed.join(', '));
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
