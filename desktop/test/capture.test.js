// The harnesses' screenshot helper (scripts/lib/capture.js).
//
// Plain `node --test`, no Electron: a stand-in for webContents that fails the
// way Electron 44 does. The shape that took CI's `npm run measure` down was a
// first capture rejecting with "UnknownVizError" while every later one worked.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';

import { capturePage, isCopyError, COPY_ERRORS } from '../scripts/lib/capture.js';

const IMAGE = { isEmpty: () => false };

/** A webContents whose first `failures` captures reject with `message`. */
function flaky(failures, message = 'UnknownVizError') {
  const wc = { calls: 0, invalidated: 0, rects: [] };
  wc.capturePage = (rect) => {
    wc.calls += 1;
    wc.rects.push(rect);
    return wc.calls <= failures ? Promise.reject(new Error(message)) : Promise.resolve(IMAGE);
  };
  wc.invalidate = () => { wc.invalidated += 1; };
  return wc;
}

const quiet = { settleMs: 1, log: () => {} };

test('a first copy that fails with UnknownVizError is taken again, and the shot comes back', async () => {
  const wc = flaky(1);
  const logged = [];
  const image = await capturePage(wc, { ...quiet, label: 'settings light', log: (line) => logged.push(line) });
  assert.strictEqual(image, IMAGE);
  assert.strictEqual(wc.calls, 2);
  assert.strictEqual(wc.invalidated, 1, 'a fresh frame is asked for before the second copy');
  assert.match(logged.join('\n'), /settings light: capture attempt 1 failed \(UnknownVizError\), retrying/);
});

test('every copy error Electron names is retried', async () => {
  for (const message of COPY_ERRORS) {
    const wc = flaky(1, message);
    assert.strictEqual(await capturePage(wc, quiet), IMAGE, message);
  }
});

test('the retries are bounded: a copy that keeps failing still fails, with its own error', async () => {
  const wc = flaky(10);
  await assert.rejects(capturePage(wc, { ...quiet, attempts: 3 }), /UnknownVizError/);
  assert.strictEqual(wc.calls, 3);
});

test('an error that is not a failed copy is not retried', async () => {
  const wc = flaky(1, 'Current display surface not available for capture');
  await assert.rejects(capturePage(wc, quiet), /display surface/);
  assert.strictEqual(wc.calls, 1);
  assert.strictEqual(isCopyError(new Error('Frame Gone')), true);
  assert.strictEqual(isCopyError(new Error('boom')), false);
  assert.strictEqual(isCopyError(null), false);
});

test('a copy that never answers is cut off by the clock, once', async () => {
  const wc = { calls: 0, capturePage() { this.calls += 1; return new Promise(() => {}); } };
  await assert.rejects(capturePage(wc, { ...quiet, timeoutMs: 20 }), /no shot within 20ms/);
  assert.strictEqual(wc.calls, 1);
});

test('a rect is passed through to every attempt', async () => {
  const wc = flaky(1);
  const rect = { x: 0, y: 0, width: 40, height: 40 };
  await capturePage(wc, { ...quiet, rect });
  assert.deepStrictEqual(wc.rects, [rect, rect]);
});
