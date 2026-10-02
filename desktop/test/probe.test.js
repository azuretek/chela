// The harnesses' in-page probe helper (scripts/lib/probe.js).
//
// Plain `node --test`, no Electron: a stand-in for webContents that hangs the way a
// frame that never reaches did-stop-loading does. The shape that took
// login-gate-cover-gate down on main's 58f314a was executeJavaScript never resolving,
// because Electron 44's executeJavaScript first awaits waitTillCanExecuteJavaScript,
// which waits for the main frame to stop loading with no clock of its own.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';

import { evaluate, loadingState, PageStillLoading, PROBE_TIMEOUT_MS } from '../scripts/lib/probe.js';

/** A page whose every executeJavaScript settles with `value`. */
function page(value) {
  return { executeJavaScript: () => Promise.resolve(value) };
}

const quiet = { timeoutMs: 20, log: () => {} };

test('a probe that answers comes back with its value', async () => {
  assert.strictEqual(await evaluate(page(42), 'x', quiet), 42);
});

test('a page that is still loading is cut off by the clock, and the line names the page and its state', async () => {
  // The shape on 58f314a: the frame is still loading, so executeJavaScript never
  // returns. The probe must not wait on it, and must say what it was waiting for.
  const wc = {
    getURL: () => 'http://127.0.0.1:18996/',
    isLoadingMainFrame: () => true,
    executeJavaScript: () => new Promise(() => {}),
  };
  const logged = [];
  await assert.rejects(
    evaluate(wc, 'x', { timeoutMs: 20, label: 'the Control UI page', log: (line) => logged.push(line) }),
    (err) => err instanceof PageStillLoading && err.isLoadingMainFrame === true && err.url === 'http://127.0.0.1:18996/',
  );
  assert.deepStrictEqual(logged, [
    'FAIL the Control UI page: no answer within 20ms (isLoadingMainFrame=true, url=http://127.0.0.1:18996/)',
  ]);
});

test('a probe that throws for its own reason is passed through, not read as a stall', async () => {
  const wc = { executeJavaScript: () => Promise.reject(new Error('boom')) };
  await assert.rejects(evaluate(wc, 'x', quiet), /boom/);
});

test('an already-stopped page keeps its clock, and default timeout is the helper\'s', () => {
  assert.strictEqual(PROBE_TIMEOUT_MS, 2000);
});

test('loading state is read defensively: a missing or destroyed view answers instead of throwing', () => {
  assert.deepStrictEqual(loadingState(null), { url: '(no view)', isLoadingMainFrame: null });
  const gone = { getURL() { throw new Error('gone'); } };
  assert.deepStrictEqual(loadingState(gone), { url: '(destroyed)', isLoadingMainFrame: null });
  const plain = { getURL: () => 'http://x/', isLoadingMainFrame: () => false };
  assert.deepStrictEqual(loadingState(plain), { url: 'http://x/', isLoadingMainFrame: false });
});
