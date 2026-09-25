import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RENDERED_PROBE, createCoverGate } from '../render-ready.js';

const tick = () => new Promise((r) => setImmediate(r));

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn) => { timers.set(++id, fn); return id; },
    clearTimer: (t) => { timers.delete(t); },
    fire: () => { for (const [t, fn] of [...timers]) { timers.delete(t); fn(); } },
    get size() { return timers.size; },
  };
}

test('the cover stays up after the load until the page reports it rendered', async () => {
  const timers = fakeTimers();
  let rendered;
  const lifts = [];
  const gate = createCoverGate({ probe: () => new Promise((r) => { rendered = r; }), lift: (why) => lifts.push(why), ...timers });
  gate.loaded('page');
  await tick();
  assert.deepEqual(lifts, [], 'a finished load alone must not lift the cover');
  rendered(true);
  await tick();
  assert.deepEqual(lifts, ['rendered']);
  assert.equal(timers.size, 0, 'the backstop is cleared once the page rendered');
});

test('a cover raised again (Try again) is not lifted by the load before it', async () => {
  const timers = fakeTimers();
  let rendered;
  const lifts = [];
  const gate = createCoverGate({ probe: () => new Promise((r) => { rendered = r; }), lift: (why) => lifts.push(why), ...timers });
  gate.loaded('first');
  gate.hold();
  rendered(true);
  await tick();
  timers.fire();
  assert.deepEqual(lifts, []);
});

test('a page that never paints is uncovered by the backstop, once', async () => {
  const timers = fakeTimers();
  const lifts = [];
  const gate = createCoverGate({ probe: () => new Promise(() => {}), lift: (why) => lifts.push(why), ...timers });
  gate.loaded('page');
  await tick();
  assert.deepEqual(lifts, []);
  timers.fire();
  await tick();
  assert.deepEqual(lifts, ['backstop']);
});

test('a probe that fails still lifts, rather than stranding the cover', async () => {
  const timers = fakeTimers();
  const lifts = [];
  const gate = createCoverGate({ probe: () => { throw new Error('view destroyed'); }, lift: (why) => lifts.push(why), ...timers });
  gate.loaded('page');
  await tick();
  assert.deepEqual(lifts, ['probe-failed']);
});

function page({ painted = false } = {}) {
  const entries = painted ? [{ name: 'first-contentful-paint' }] : [];
  const frames = [];
  let observer = null;
  const ctx = {
    performance: { getEntriesByType: (t) => (t === 'paint' ? entries : []) },
    requestAnimationFrame: (fn) => frames.push(fn),
    PerformanceObserver: class {
      constructor(cb) { this.cb = cb; observer = this; }
      observe() {}
      disconnect() { observer = null; }
    },
  };
  return {
    run: () => vm.runInNewContext(RENDERED_PROBE, ctx),
    paint: () => observer && observer.cb({ getEntries: () => [{ name: 'first-contentful-paint' }] }, observer),
    frame: () => { const due = frames.splice(0); due.forEach((f) => f()); },
  };
}

test('the probe waits for the first contentful paint and two presented frames', async () => {
  const p = page();
  let done = false;
  p.run().then(() => { done = true; });
  p.frame(); p.frame();
  await tick();
  assert.equal(done, false, 'no paint yet, so not rendered');
  p.paint();
  p.frame();
  await tick();
  assert.equal(done, false, 'one frame after the paint is not yet presented');
  p.frame();
  await tick();
  assert.equal(done, true);
});

test('the probe answers at once for a page that has already painted', async () => {
  const p = page({ painted: true });
  let done = false;
  p.run().then(() => { done = true; });
  p.frame(); p.frame();
  await tick();
  assert.equal(done, true);
});
