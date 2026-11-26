// The iOS UI tests run on their own leg, on the lightest simulator the app
// supports, booted and waited for before anything is tested (#190).
//
// A booted simulator runs about 300 processes, and on the 3-core, 7.5 GB runners
// that kept the CPU at 100% and memory full through the test step: the first UI
// launch took up to 220 s and failed the leg. This holds the fix in place,
// because each part is a line someone can drop for looking redundant:
//
//   the UI tests have their own leg   the version legs skip them, the UI leg
//                                     runs only them, on the oldest runtime of
//                                     its major and the smallest iPhone named
//   the resolver honours that         the oldest minor and the preferred device
//                                     are what it picks, and the version legs
//                                     still get the newest minor
//   the boot is waited for            sim-boot.sh boots, then waits for the boot
//                                     to finish, after the compile and before
//                                     the tests, on the device the tests run on
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
const BOOT_STEP = 'Boot the simulator and wait for the boot to finish';

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

test('sim-boot.sh boots the device and then waits for the boot to finish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-boot-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'xcrun'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
  const run = spawnSync('bash', [BOOT, 'DEVICE'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, CALLS: calls } });
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(seen, ['simctl boot DEVICE', 'simctl bootstatus DEVICE -b'],
    'the boot must be followed by bootstatus -b, which is what waits for the boot to finish rather than to start');
  assert.match(run.stdout, /reported Booted after \d+ s and finished booting after \d+ s/, run.stdout);
});

test('a boot that fails stops the leg rather than testing on a half-booted device', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-boot-'));
  fs.writeFileSync(path.join(dir, 'xcrun'), '#!/bin/sh\n[ "$2" = boot ] && exit 164\nexit 0\n', { mode: 0o755 });
  const run = spawnSync('bash', [BOOT, 'DEVICE'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(run.status, 0, 'a failed boot was reported as a finished one');
});

// The matrix entries, each as a map of its keys.
function legs() {
  const start = pipeline.indexOf('\n        include:\n');
  assert.ok(start > 0, 'the iOS test job no longer lists its legs under matrix.include');
  const block = pipeline.slice(start).split(/\n    \S/)[0];
  return block.split('\n          - ').slice(1).map((entry) => {
    const leg = {};
    for (const line of entry.split('\n')) {
      const m = /^\s*([a-z]+): (.+)$/.exec(line);
      if (m) leg[m[1]] = m[2].trim();
    }
    return leg;
  });
}

test('the UI tests run alone on their own leg, on the oldest runtime and a small iPhone', () => {
  const all = legs();
  const ui = all.filter((leg) => leg.suite === 'ui');
  const versions = all.filter((leg) => leg.suite === 'unit');
  assert.equal(ui.length, 1, 'there must be exactly one UI test leg; there are ' + ui.length);
  assert.equal(versions.length + ui.length, all.length, 'every leg must name its suite, unit or ui');
  assert.deepEqual(versions.map((leg) => leg.ios).sort(), ['26', '27'], 'both versions keep a leg of their own, which is what the matrix is for');
  assert.equal(ui[0].runtime, 'oldest', 'the UI leg must ask for the oldest runtime of its major, the lightest one the app supports');
  assert.match(ui[0].devices || '', /^iPhone \S+e(,|$)/, 'the UI leg must name the small iPhone it prefers first');
  const steps = testJobSteps();
  const tests = steps[stepIndex(steps, 'Test on the resolved simulator')].block;
  assert.match(tests, /SUITE: \$\{\{ matrix\.suite \}\}/, 'the test step no longer reads the leg\'s suite');
  assert.match(tests, /ui\) only=\(-only-testing:ChelaUITests\)/, 'the UI leg no longer runs only the UI tests');
  assert.match(tests, /unit\) only=\(-skip-testing:ChelaUITests\)/, 'the version legs no longer skip the UI tests');
  assert.match(tests, /"\$\{only\[@\]\}"/, 'the suite selection is no longer passed to xcodebuild');
  assert.match(pipeline, /name: iOS \$\{\{ matrix\.ios \}\}\$\{\{ matrix\.suite == 'ui' && ' UI tests' \|\| '' \}\}/, 'the UI leg must be named apart from the version legs in the run list');
});

test('the resolver picks the oldest minor and the preferred device for the UI leg, the newest for the others', () => {
  const steps = testJobSteps();
  const block = steps[stepIndex(steps, 'Resolve an available iPhone simulator')].block;
  assert.match(block, /RUNTIME: \$\{\{ matrix\.runtime \|\| 'newest' \}\}/, 'the resolver no longer reads the leg\'s runtime choice');
  assert.match(block, /DEVICES: \$\{\{ matrix\.devices \|\| '' \}\}/, 'the resolver no longer reads the leg\'s device preference');
  const source = /python3 -c '\n([\s\S]*?)\n\s*' \|\| true\)"/.exec(block);
  assert.ok(source, 'the resolver is no longer an inline python3 -c script');
  const script = source[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const runtime = (v) => 'com.apple.CoreSimulator.SimRuntime.iOS-' + v;
  const listing = JSON.stringify({ devices: {
    [runtime('26-2')]: [{ name: 'iPhone 17', udid: 'OLD-17', isAvailable: true }, { name: 'iPhone 16e', udid: 'OLD-16E', isAvailable: true }],
    [runtime('26-5')]: [{ name: 'iPhone 17 Pro', udid: 'NEW-17P', isAvailable: true }, { name: 'iPhone 17e', udid: 'NEW-17E', isAvailable: true }],
    [runtime('27-2')]: [{ name: 'iPhone 18 Pro', udid: 'NEXT', isAvailable: true }],
  } });
  const pick = (env) => {
    const run = spawnSync('python3', ['-c', script], { input: listing, encoding: 'utf8', env: { ...process.env, RUNTIME: 'newest', DEVICES: '', ...env } });
    return { status: run.status, udid: run.stdout.trim(), stderr: run.stderr };
  };
  assert.equal(pick({ IOS_MAJOR: '26' }).udid, 'NEW-17P', 'a version leg must get the newest minor, as before');
  assert.equal(pick({ IOS_MAJOR: '27' }).udid, 'NEXT');
  assert.equal(pick({ IOS_MAJOR: '26', RUNTIME: 'oldest', DEVICES: 'iPhone 16e,iPhone 17e' }).udid, 'OLD-16E', 'the UI leg must get the oldest minor and its preferred device');
  const fallback = pick({ IOS_MAJOR: '26', RUNTIME: 'oldest', DEVICES: 'iPhone 15e' });
  assert.equal(fallback.udid, 'OLD-17', 'a preferred device the image lacks falls back to the first iPhone');
  assert.match(fallback.stderr, /::warning::none of iPhone 15e/, 'and says so on the run');
  assert.notEqual(pick({ IOS_MAJOR: '25' }).status, 0, 'a major the image does not carry must fail rather than test another');
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
