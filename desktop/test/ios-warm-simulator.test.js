// The iOS legs test on a simulator that has booted before (#190).
//
// Every device on the runner image is one that has never booted. When the test
// step booted it, the UI tests launched the app minutes into iOS's first-boot
// setup, on runners whose three cores that setup keeps busy, and the first launch
// of the UI tests took up to 220 s and failed the leg. The fix warms the device
// once per image, carries it in the cache and boots it a second time before the
// tests. This holds that in place, because every part of it is a line someone can
// delete for looking redundant:
//
//   the boot happens before the tests      the test step must find the warmed
//                                          device already booted, or xcodebuild
//                                          boots a cold one again
//   a miss warms and saves                 the first run on a new image is the
//                                          only one that pays the first boot
//   the warmed device is the tested one    the boot and the test name the same
//                                          resolved device
//   the launch report runs                 a launch drifting back toward the
//                                          timeout is visible while still green

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
const WARM = path.join(ROOT, 'mobile', 'scripts', 'sim-warm.sh');

// The test job's steps, by name, in order, each with the text of its block.
function testJobSteps() {
  const start = pipeline.indexOf('\n  test:\n');
  const end = pipeline.indexOf('\n  release:\n', start);
  assert.ok(start > 0 && end > start, 'mobile-pipeline.yml no longer has its test job ahead of the release job');
  const job = pipeline.slice(start, end);
  return job.split('\n      - ').slice(1).map((block) => {
    const name = (/^name: (.+)$/m.exec(block) || /^\s*name: (.+)$/m.exec(block) || [])[1] || block.split('\n')[0];
    return { name: name.trim(), block };
  });
}

function stepIndex(steps, name) {
  const i = steps.findIndex((s) => s.name === name);
  assert.ok(i >= 0, 'the iOS test job has no step named "' + name + '"');
  return i;
}

test('the warmed simulator is restored and booted before the tests run', () => {
  const steps = testJobSteps();
  const restore = stepIndex(steps, 'Restore the warmed simulator');
  const boot = stepIndex(steps, 'Boot the warmed simulator');
  const tests = stepIndex(steps, 'Test on the resolved simulator');
  const build = stepIndex(steps, 'Build for the simulator');
  assert.ok(build < restore && restore < boot && boot < tests,
    'the order must be build, restore the warmed device, boot it, then test: a boot under the compile slows the compile, and a test step that boots the device itself boots a cold one');
  assert.match(steps[boot].block, /scripts\/sim-warm\.sh boot "\$SIMULATOR_UDID"/, 'the boot step no longer boots the resolved device through sim-warm.sh');
  assert.match(steps[tests].block, /-destination "platform=iOS Simulator,id=\$SIMULATOR_UDID"/, 'the tests no longer run on the device that was warmed');
});

test('only a cache miss pays the first boot, and it saves what it paid for', () => {
  const steps = testJobSteps();
  const restore = steps[stepIndex(steps, 'Restore the warmed simulator')];
  const warm = steps[stepIndex(steps, 'Warm the simulator, on the first run on this image only')];
  const save = steps[stepIndex(steps, 'Save the warmed simulator')];
  assert.match(restore.block, /uses: actions\/cache\/restore@/, 'the warmed device is no longer restored from the cache');
  assert.match(save.block, /uses: actions\/cache\/save@/, 'a warmed device is no longer saved to the cache');
  for (const step of [warm, save]) {
    assert.match(step.block, /if: steps\.warm\.outputs\.cache-hit != 'true'/, step.name + ' must run on a cache miss only');
  }
  assert.match(warm.block, /scripts\/sim-warm\.sh warm "\$SIMULATOR_UDID"/, 'the warm step no longer warms the resolved device');
  const key = steps[stepIndex(steps, 'Name the warmed simulator')].block;
  for (const part of ['matrix.ios', 'ImageVersion', 'build', 'SIMULATOR_TYPE', 'SIMULATOR_UDID']) {
    assert.ok(key.includes(part), 'the warmed simulator key no longer names ' + part + ', so a roll of it would restore a device warmed for something else');
  }
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

test('sim-warm.sh is an executable shell program bash can parse', () => {
  assert.ok(fs.statSync(WARM).mode & 0o111, 'mobile/scripts/sim-warm.sh is not executable');
  const parsed = spawnSync('bash', ['-n', WARM], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, 'bash cannot parse sim-warm.sh: ' + parsed.stderr);
  const usage = spawnSync('bash', [WARM, 'nonsense', 'udid', 'archive'], { encoding: 'utf8' });
  assert.equal(usage.status, 2, 'an unknown subcommand must be a usage error, not a silent success');
});

// sim_cpu reads ps, so a stand-in ps on PATH drives the wait: a simulator that
// has gone quiet must end it, and one that never does must stop at the limit with
// a warning rather than hold the leg until the job is killed.
function settleWith(step, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-warm-'));
  fs.writeFileSync(path.join(dir, 'ps'), [
    '#!/bin/sh',
    'n=$(cat "$STUB_COUNTER" 2>/dev/null || echo 0)',
    'n=$((n + STUB_STEP)); echo "$n" > "$STUB_COUNTER"',
    'printf "%d:%02d.00 /Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/stubd\\n" $((n / 60)) $((n % 60))',
    'printf "0:01.00 /usr/libexec/unrelated\\n"',
    '',
  ].join('\n'), { mode: 0o755 });
  const run = spawnSync('bash', [WARM, 'settle'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir + ':' + process.env.PATH, STUB_COUNTER: path.join(dir, 'n'), STUB_STEP: String(step), ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

test('the wait ends once the simulator has gone quiet', () => {
  const run = settleWith(0, { WINDOW: '0', QUIET_WINDOWS: '3', SETTLE_LIMIT: '30' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /settled after/, 'a simulator using no CPU was not called settled: ' + run.stdout);
  assert.equal((run.stdout.match(/^settling:/gm) || []).length, 3, 'it should take exactly QUIET_WINDOWS quiet samples');
});

test('a simulator that never goes quiet stops the wait at the limit, with a warning', () => {
  const run = settleWith(100, { WINDOW: '0.5', QUIET_WINDOWS: '3', SETTLE_LIMIT: '2' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::warning::the simulator was still busy after 2 s/, 'the limit did not end the wait: ' + run.stdout);
  assert.doesNotMatch(run.stdout, /settled after/, 'a busy simulator was called settled');
});
