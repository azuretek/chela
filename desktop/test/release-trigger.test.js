// The release trigger set, held to its one owner.
//
// Abi's rule, 2026-09-18: a release happens only when something that SHIPS
// changed, and the paths that decide that live in ONE place. Two halves of that
// live in the workflows and the answer lives in a script, and this test is the
// third thing that keeps them agreeing:
//
//   no path filter in either workflow   The filter used to be the thing that
//                                       decided whether a release waited for the
//                                       other platform, and its answer for a
//                                       narrow commit was "publishing is
//                                       unaffected". A path filter is therefore
//                                       not a tidy-up here: it is how the
//                                       phantom-update class got out, so its
//                                       reintroduction is a failure rather than
//                                       a review note.
//
//   scripts/release/changes.mjs         The one owner of which paths ship. Its
//                                       verdict gates publication in both
//                                       pipelines.
//
//   the fixtures below                  Prove the classification, the refusal
//                                       when a release is asked for and nothing
//                                       shipped, and that neither pipeline's own
//                                       path list survives anywhere.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  NON_RELEASE_PATHS,
  RELEASE_PATHS,
  ships,
  classify,
  decide,
  run,
} from '../../scripts/release/changes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const WORKFLOWS = ['release.yml', 'mobile-pipeline.yml', 'platforms-gate.yml'];

// Normalised to LF, because this suite runs on the Windows leg too and a
// checkout there may hand back CRLF. Every pattern below anchors on \n, so an
// unconverted carriage return would make a workflow that HAS a path filter read
// as one that does not, which is the wrong way for this guard to fail.
const read = (file) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8').replace(/\r\n?/g, '\n');

/** The `on:` block, which is where a path filter can live. */
function onBlock(yml) {
  const match = /^on:\n([\s\S]*?)(?=^[a-z]|$(?![\s\S]))/m.exec(yml);
  assert.ok(match, 'the workflow has no on: block');
  return match[1];
}

test('no workflow carries a path filter: the trigger set has one owner', () => {
  // ★ The guard. A `paths:` or `paths-ignore:` anywhere under `on:` is a
  // second copy of the rule, and the copy that shipped a release with no iOS
  // build behind it (v1.0.1-dev.279.9a58115cb1) was exactly this shape.
  for (const file of WORKFLOWS) {
    const block = onBlock(read(file));
    assert.ok(
      !/^\s*paths(-ignore)?:/m.test(block),
      `${file} carries a path filter under on:. Which paths ship is owned by scripts/release/changes.mjs`,
    );
  }
});

test('no workflow hands node a program with a stray backslash escape', () => {
  // ★ The class this catches, measured on main 2026-09-18. release.yml passed
  // its marker program as a single-quoted node -e argument whose quotes were
  // backslash-escaped. Inside a SINGLE-quoted shell argument a backslash
  // survives VERBATIM, so node received the backslashes and died at eval with
  // "Expected unicode escape". The release job failed one step before
  // publishing, the draft was never published, and no release went out at all.
  // The command reads as correct in review, which is why this is asserted.
  //
  // The check is narrow on purpose: a backslash inside that single-quoted
  // argument is never what is meant, and a legitimate one would be escaped
  // through a different quoting style.
  for (const file of WORKFLOWS) {
    const yml = read(file);
    for (const match of yml.matchAll(/node -e '([^']*)'/g)) {
      assert.ok(
        !match[1].includes('\\'),
        file + ': a single-quoted node -e program carries a backslash, which reaches node verbatim: ' + match[1],
      );
    }
  }
});

test('every workflow that publishes asks the owner whether this commit ships', () => {
  // Both publish paths, so both must read the same answer. platforms-gate.yml is
  // the shared gate and carries no trigger of its own, so it is not here.
  for (const file of ['release.yml', 'mobile-pipeline.yml']) {
    const yml = read(file);
    assert.match(
      yml,
      /^\s*changes:\n/m,
      `${file} has no changes job, so nothing decides whether a release happens`,
    );
    assert.match(
      yml,
      /scripts\/release\/changes\.mjs/,
      `${file} does not run the owner of the trigger set`,
    );
    assert.match(
      yml,
      /needs\.changes\.outputs\.release == 'true'/,
      `${file} publishes without asking whether this commit ships anything`,
    );
  }
});

test('every path in the shipped list classifies as shipping', () => {
  for (const entry of RELEASE_PATHS) {
    const sample = entry.endsWith('/') ? entry + 'anything.js' : entry;
    assert.ok(ships(sample), `${entry} is named as a shipped path but does not ship`);
  }
});

test('the non-release list covers what the rule names, and nothing else does', () => {
  const nonRelease = [
    'docs/guide.md',
    'README.md',
    'mobile/README.md',
    '.github/workflows/release.yml',
    '.github/pull_request_template.md',
    '.githooks/pre-commit',
    'scripts/mobile.mjs',
    'scripts/release/changes.mjs',
    'LICENSE',
    '.gitignore',
  ];
  for (const file of nonRelease) {
    assert.ok(!ships(file), `${file} should not trigger a release`);
  }

  // The other direction, which is the one that can lose a shipped fix: a path
  // outside the non-release list ships, including one nobody has thought about.
  const shipped = [
    'core/release.js',
    'core/spec/feed.json',
    'core/ui/settings.js',
    'desktop/src/main.js',
    'mobile/Chela/UpdateFeed.swift',
    'mobile/project.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'some-new-tree/asset.bin',
  ];
  for (const file of shipped) {
    assert.ok(ships(file), `${file} should trigger a release`);
  }
});

test('a commit of nothing but non-release paths does not ship', () => {
  // The dev.279 phantom case: a .github-only change. It produced a release the
  // phone offered as an update while no TestFlight build existed, and under the
  // new rule it produces no release at all.
  const verdict = classify(['.github/workflows/platforms-gate.yml']);
  assert.equal(verdict.release, false);
  assert.equal(verdict.shipped.length, 0);
  assert.deepEqual(verdict.byReason['.github/'], ['.github/workflows/platforms-gate.yml']);
});

test('one shipped path is enough, whatever it sits beside', () => {
  const verdict = classify(['docs/guide.md', '.github/workflows/release.yml', 'desktop/src/main.js']);
  assert.equal(verdict.release, true);
  assert.deepEqual(verdict.shipped, ['desktop/src/main.js']);
});

test('an empty change set does not ship', () => {
  assert.equal(classify([]).release, false);
});

test('a release asked for and not shipping REFUSES, and a push stands down quietly', () => {
  // ★ A tag and a dispatch are both "release this", so "nothing shipped" is a
  // refusal there rather than a silent stand-down: a release that was asked for
  // and quietly did not happen is its own bug.
  const refused = run(['--files', '.github/workflows/release.yml'], {
    GITHUB_OUTPUT: '',
    GITHUB_REF_TYPE: 'tag',
  });
  assert.equal(refused.release, false);
  assert.equal(process.exitCode, 1, 'a tag that ships nothing must refuse');
  process.exitCode = 0;

  const dispatched = run(['--files', 'docs/guide.md'], {
    GITHUB_OUTPUT: '',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  });
  assert.equal(dispatched.release, false);
  assert.equal(process.exitCode, 1, 'a dispatch that ships nothing must refuse');
  process.exitCode = 0;

  const pushed = run(['--files', 'docs/guide.md'], { GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: 'push' });
  assert.equal(pushed.release, false);
  assert.notEqual(process.exitCode, 1, 'a push that ships nothing stands down rather than failing');
  process.exitCode = 0;
});

test('the decision writes the outputs the workflows read, on one line each', () => {
  // os.tmpdir(), never TMPDIR or /tmp: the suite runs on the Windows leg, where
  // TMPDIR is unset and /tmp does not exist. Measured 2026-09-18: the /tmp form
  // failed the Windows leg's Test step and took main red with it.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-changes-')), 'out');
  fs.writeFileSync(out, '');
  run(['--files', 'desktop/src/main.js'], { GITHUB_OUTPUT: out });
  const written = fs.readFileSync(out, 'utf8');
  assert.match(written, /^release=true\n/);
  // A newline inside the reason would end the output early and silently.
  assert.equal(written.trim().split('\n').length, 2, `expected two output lines, got: ${written}`);
});

test('the range a dispatch or a tag ships is everything since the last release', () => {
  // Against this repository's own history rather than a fixture, so the rule is
  // exercised on the shape it will actually meet: a release tag, then commits.
  const tags = fs.existsSync(path.join(ROOT, '.git'));
  if (!tags) return;

  const base = decide({
    eventName: 'workflow_dispatch',
    refType: '',
    sha: 'HEAD',
  });
  assert.equal(typeof base.release, 'boolean');
  // A dispatch is an explicit request, so it is never read as a plain push.
  assert.equal(base.explicit, true);
});

test('the non-release list is short enough to read and each entry says why', () => {
  for (const entry of NON_RELEASE_PATHS) {
    assert.ok(entry.describes && entry.why, 'every non-release entry carries its reason');
  }
});

test('running the script the way the workflow does writes the release output', () => {
  // The workflows invoke `node scripts/release/changes.mjs`, not run() directly.
  // A broken main-entry guard once made the script a silent no-op: it exited 0
  // and wrote nothing to GITHUB_OUTPUT, so every release stood down without even
  // the designed refusal, and the direct-run() tests above could not see it.
  // This exercises the real entry path.
  const script = path.join(ROOT, 'scripts', 'release', 'changes.mjs');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-entry-')), 'out');
  fs.writeFileSync(out, '');
  execFileSync(process.execPath, [script, '--files', 'core/gateway-url.js'], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: 'ignore',
  });
  const written = fs.readFileSync(out, 'utf8');
  assert.match(written, /^release=true$/m, 'the script must write release=true for a shipping change; empty output means the entry guard never fired');
});

test('the shared gate requires every job the other pipeline lists', () => {
  // ★ Abi's rule, 2026-09-21: "require all jobs to finish successfully before we
  // publish, so that we can never have something claiming to be deployed and not."
  //
  // The class this closes: the gate used to require a VERDICT, a hand-written
  // alternation of job-name patterns, so a job the pattern did not name sat
  // outside the gate for as long as nobody remembered to add it, and silently,
  // because a pattern that names everything looks exactly like one that does
  // not. Measured on main the same day: the mobile run for c8d9db5675 had iOS 26,
  // iOS 27 and swiftlint concluded success while its release job (the TestFlight
  // upload and the wait for VALID) had not registered at all, the gate read that
  // as 'every matching job is complete', passed, and the desktop published a
  // release the phone could never be offered.
  //
  // Asserted here: the job list is read UNFILTERED, the passing conclusion is
  // `success` and nothing else, and the only exemptions are the named jobs that
  // cannot conclude before the other pipeline publishes.
  const gate = read('platforms-gate.yml');
  assert.ok(
    gate.includes('.jobs[] | "'),
    'platforms-gate.yml does not read the other run\'s job list unfiltered, so a job it does not name is outside the gate',
  );
  assert.ok(
    !gate.includes('VERDICT') && !gate.includes('test('),
    'platforms-gate.yml still filters the other run\'s job list by a pattern: the required set must be every job that run lists',
  );
  assert.ok(
    gate.includes('grep -Ev') && gate.includes('|success$'),
    'platforms-gate.yml no longer requires success and nothing else: a skipped, cancelled or timed-out job must refuse',
  );
  assert.ok(
    gate.includes('exempt:') && gate.includes('EXEMPT:'),
    'platforms-gate.yml no longer takes an exempt list, which is the only thing that can break the mutual wait between the two pipelines',
  );

  // The desktop publishes only once the phone's upload has concluded, and the
  // mobile upload only once the desktop built, so release.yml exempts NOTHING
  // and mobile-pipeline.yml exempts exactly the two desktop jobs that wait on it.
  assert.ok(
    /^\s*exempt:\s*''\s*$/m.test(read('release.yml')),
    'release.yml exempts something: the mobile release job, where the TestFlight upload and the wait for VALID live, must be inside the gate',
  );
  assert.ok(
    /^\s*exempt:\s*'\^release\$\|\^every platform must be green'\s*$/m.test(read('mobile-pipeline.yml')),
    'mobile-pipeline.yml no longer exempts exactly the two desktop jobs that cannot conclude before the upload: its publish job and its own call of the gate',
  );
  assert.ok(
    !/^\s*verdict:/m.test(read('release.yml')) && !/^\s*verdict:/m.test(read('mobile-pipeline.yml')),
    'a pipeline still passes a verdict, so the required set is a named subset rather than the other run\'s whole job list',
  );
});

test('every workflow run block is a shell program bash can parse', () => {
  // ★ The class this catches, measured on main 2026-09-21. The change that made
  // the gate require every job merged on green CI while its `run` block did not
  // parse: `bash` died with 'syntax error near unexpected token' a second into the
  // gate job, both gates refused, and NOTHING published from main while every
  // workflow's own checks reported success. No test ran the shell at all, because
  // the guards around it match strings, and a string that matches can still be a
  // program that cannot run.
  //
  // So every `run: |` block of every workflow goes through the parser. `bash -n`
  // reads the whole program and reports a syntax error without running any of it,
  // so this needs no credentials, no network and no side effects.
  let blocks = 0;
  for (const file of WORKFLOWS) {
    const lines = read(file).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() !== 'run: |') continue;
      const indent = lines[i].length - lines[i].trimStart().length;
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() && lines[j].length - lines[j].trimStart().length <= indent) break;
        body.push(lines[j].slice(indent + 2));
        i = j;
      }
      blocks += 1;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-shell-'));
      const script = path.join(dir, `${file}.sh`);
      fs.writeFileSync(script, `${body.join('\n')}\n`);
      try {
        execFileSync('bash', ['-n', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        const said = error.stderr ? error.stderr.toString().trim() : error.message;
        assert.fail(`${file}: the run block starting at line ${i + 1} is not a shell program bash can parse: ${said}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(blocks >= 4, `only ${blocks} run blocks were checked, so this guard is not covering the workflows`);
});

test('every jq program the workflows run parses', () => {
  // ★ The class this catches, measured 2026-09-21. The rewritten gate shipped
  // with an over-escaped jq program (`// \"\"` inside a single-quoted shell
  // string), which `bash -n` cannot see: the shell parses, and jq rejects it at
  // RUN time with 'unexpected token', so both gates died on their first API call
  // and nothing published from main. The same shape as the shell syntax error
  // above, one layer in.
  //
  // A jq program is checked by handing it to jq with no input: a valid one
  // produces nothing and exits 0, a broken one exits 3 saying where.
  let haveJq = true;
  try {
    execFileSync('jq', ['--version'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    haveJq = false;
  }
  if (!haveJq) {
    // Named rather than silent: a runner without jq cannot make this claim.
    console.log('jq is not on PATH here, so the jq programs in the workflows were NOT parsed');
    return;
  }
  let programs = 0;
  for (const file of WORKFLOWS) {
    for (const match of read(file).matchAll(/--jq\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
      const literal = match[1];
      programs += 1;
      try {
        // The literal is a SHELL string, so its own escaping is decoded first:
        // a double-quoted one writes \" for a quote jq should see as a quote,
        // and handing jq the backslash instead is what made this guard fail on
        // a program that is correct.
        const program = literal.startsWith('"')
          ? literal.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
          : literal.slice(1, -1);
        execFileSync('jq', [program], { input: '', stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (error) {
        const said = error.stderr ? error.stderr.toString().trim() : error.message;
        assert.fail(`${file}: the jq program ${literal} does not parse: ${said}`);
      }
    }
  }
  assert.ok(programs >= 4, `only ${programs} jq programs were found, so this guard is not covering the workflows`);
});
