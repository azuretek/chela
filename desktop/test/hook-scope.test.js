// The guard for the hook scoping in scripts/hook-scope.mjs.
//
// The two .githooks are GUI-bound and ran on every commit and push regardless of
// what changed, which is minutes each on a small host. This pins the decision
// that lets them skip work a change cannot possibly need, so a later edit cannot
// quietly make them unconditional again (that is the regression this exists for:
// the cost is invisible and the hooks still pass, so nothing else would notice).
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsDesktopWork, decisionFor } from '../../scripts/hook-scope.mjs';

test('a mobile-only change needs no desktop hook work', () => {
  assert.equal(needsDesktopWork(['mobile/Chela/App.swift', 'mobile/project.yml']), false);
  assert.equal(decisionFor(['mobile/Chela/App.swift']), 'skip');
});

test('docs, CI and a JSON-only change need no desktop hook work', () => {
  assert.equal(needsDesktopWork(['docs/readme.md']), false);
  assert.equal(needsDesktopWork(['.github/workflows/release.yml']), false);
  assert.equal(needsDesktopWork(['core/spec/feed.json'.replace('core/', 'mobile/')]), false);
});

test('a desktop or core change runs the desktop hooks', () => {
  assert.equal(needsDesktopWork(['desktop/src/main.js']), true);
  assert.equal(needsDesktopWork(['core/notices.js']), true);
  assert.equal(decisionFor(['desktop/src/main.js']), 'run');
});

test('a root manifest or a root script runs the desktop hooks', () => {
  assert.equal(needsDesktopWork(['package.json']), true);
  assert.equal(needsDesktopWork(['pnpm-lock.yaml']), true);
  assert.equal(needsDesktopWork(['scripts/mobile.mjs']), true);
});

test('a hook change is exercised by the hook it changed', () => {
  assert.equal(needsDesktopWork(['.githooks/pre-push']), true);
});

test('an unknown or empty change is not read as a narrow one', () => {
  // Nothing staged, or a push range that could not be computed, must not skip.
  assert.equal(decisionFor([]), 'run');
});
