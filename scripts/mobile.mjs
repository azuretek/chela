#!/usr/bin/env node
// The mobile platform's entrypoint from the ROOT scripts.
//
// Why this exists. mobile/ is a first-class peer of core and desktop, but it is
// Swift, not JavaScript, so it is not a pnpm workspace member. The root scripts
// (lint, test, build) fan out to every platform in parallel; this is how the
// mobile leg is reached from them, running mobile's OWN tooling rather than
// pretending it is a JS package:
//
//   node scripts/mobile.mjs lint     SwiftLint over the sources (added in the
//                                    mobile-tooling step; a no-op with a named
//                                    skip until then)
//   node scripts/mobile.mjs test     xcodegen generate + xcodebuild
//                                    build-for-testing for the simulator
//   node scripts/mobile.mjs build    xcodegen generate + xcodebuild build
//
// It is deliberately thin and forgiving on a host that cannot build for iOS: a
// machine with no Xcode SKIPS with a named reason rather than failing, the same
// rule the .githooks follow, because a Linux CI runner or a Windows checkout has
// no business failing the whole root lint on a platform it cannot touch. The
// real mobile gate is the mobile-pipeline workflow on macOS runners.

import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MOBILE = path.join(ROOT, 'mobile');

const task = process.argv[2];

function have(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

function skip(reason) {
  // A SKIP is not a pass. It is named so a green root script cannot hide a
  // platform that was never exercised.
  console.log(`mobile:${task}: SKIPPED, ${reason}`);
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  console.log(`mobile:${task}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function generateProject() {
  if (!have('xcodegen')) skip('xcodegen is not installed (brew install xcodegen)');
  run('xcodegen', ['generate']);
}

switch (task) {
  case 'lint': {
    // SwiftLint is wired in the mobile-tooling step. Until then this is a named
    // skip rather than a failure, so the root lint runs green on the JS side.
    if (!have('swiftlint')) skip('SwiftLint is not installed (brew install swiftlint)');
    run('swiftlint', ['lint', '--strict']);
    break;
  }
  case 'test': {
    if (process.platform !== 'darwin') skip('iOS is built only on macOS');
    if (!have('xcodebuild')) skip('xcodebuild is not available (no Xcode)');
    generateProject();
    run('xcodebuild', [
      '-project', 'Chela.xcodeproj',
      '-scheme', 'Chela',
      '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator',
      'build-for-testing',
    ]);
    break;
  }
  case 'build': {
    if (process.platform !== 'darwin') skip('iOS is built only on macOS');
    if (!have('xcodebuild')) skip('xcodebuild is not available (no Xcode)');
    generateProject();
    run('xcodebuild', [
      '-project', 'Chela.xcodeproj',
      '-scheme', 'Chela',
      '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator',
      'build',
    ]);
    break;
  }
  default:
    console.error(`mobile.mjs: unknown task '${task}'. Use lint, test, or build.`);
    process.exit(2);
}
