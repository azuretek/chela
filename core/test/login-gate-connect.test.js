import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import spec from '../spec/login-gate-connect.json' with { type: 'json' };
import pairingSpec from '../spec/pairing.json' with { type: 'json' };
import {
  LOGIN_GATE_CONNECT_SCRIPT, GATE_REPORTS, CONNECT_DEADLINE_MS, GATE_HOLD_MS, readGateReport, createLoginGateCover,
} from '../login-gate-connect.js';

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => { timers.delete(t); },
    fire: () => { for (const [t, { fn }] of [...timers]) { timers.delete(t); fn(); } },
    delays: () => [...timers.values()].map((t) => t.ms),
    get size() { return timers.size; },
  };
}

function host(timers) {
  const log = [];
  const press = createLoginGateCover({
    cover: () => log.push('cover'),
    lift: (why) => log.push('lift:' + why),
    fail: (why, title) => log.push('fail:' + why + (title ? ':' + title : '')),
    ...timers,
  });
  return { press, log };
}

/* ------------------------------------------------------- the host's half */

test('pressing Connect raises the cover, and it lifts only when the interface has rendered', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'pressed', title: '' });
  assert.deepEqual(log, ['cover'], 'the press must put the loading screen up at once');
  assert.deepEqual(timers.delays(), [spec.deadlineMs], 'and arm the spec deadline');
  press.report({ event: 'rendered', title: '' });
  assert.deepEqual(log, ['cover', 'lift:rendered']);
  assert.equal(timers.size, 0, 'the deadline is cleared once the interface rendered');
  timers.fire();
  assert.deepEqual(log, ['cover', 'lift:rendered'], 'nothing fires after the answer');
});

test('a press nobody answers lands on the failed state at the deadline, and never lifts', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'pressed', title: '' });
  timers.fire();
  assert.deepEqual(log, ['cover', 'fail:deadline']);
  press.report({ event: 'rendered', title: '' });
  assert.deepEqual(log, ['cover', 'fail:deadline'], 'a render after the deadline must not lift a cover that has failed');
});

test('the deadline is bounded', () => {
  assert.equal(CONNECT_DEADLINE_MS, spec.deadlineMs);
  assert.ok(CONNECT_DEADLINE_MS > 0 && CONNECT_DEADLINE_MS <= 30000, 'bounded, and short enough to be a deadline');
});

test('a failure the page reports lands on the failed state with the page title', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'pressed', title: '' });
  press.report({ event: 'failed', title: 'Gateway unreachable' });
  assert.deepEqual(log, ['cover', 'fail:refused:Gateway unreachable']);
  assert.equal(timers.size, 0);
});

test('a report with no press in flight is not ours to act on, and a second press is the same attempt', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'rendered', title: '' });
  press.report({ event: 'failed', title: 'x' });
  assert.deepEqual(log, []);
  press.report({ event: 'pressed', title: '' });
  press.report({ event: 'pressed', title: '' });
  assert.deepEqual(log, ['cover']);
  assert.equal(timers.size, 1);
});

test('cancel drops a press without ending it either way', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'pressed', title: '' });
  press.cancel();
  timers.fire();
  press.report({ event: 'rendered', title: '' });
  assert.deepEqual(log, ['cover']);
  assert.equal(press.active, false);
});

test('reports are narrowed to the kinds the spec names', () => {
  assert.deepEqual(readGateReport({ kind: GATE_REPORTS.pressed }), { event: 'pressed', title: '' });
  assert.deepEqual(readGateReport({ kind: GATE_REPORTS.failed, title: '  Gateway\n unreachable ' }), { event: 'failed', title: 'Gateway unreachable' });
  assert.deepEqual(readGateReport({ kind: GATE_REPORTS.gateShown, title: 'Gateway unreachable' }), { event: 'gateShown', title: 'Gateway unreachable' });
  assert.deepEqual(readGateReport({ kind: GATE_REPORTS.gateGone }), { event: 'gateGone', title: '' });
  assert.deepEqual(readGateReport({ kind: GATE_REPORTS.pageReady }), { event: 'pageReady', title: '' });
  assert.equal(readGateReport({ kind: 'authenticated' }), null);
  assert.equal(readGateReport(null), null);
  assert.equal(readGateReport({ kind: GATE_REPORTS.failed, title: 'x'.repeat(500) }).title.length, 160);
});

test('the gate hold is bounded, and short: the gate says the page has given up', () => {
  assert.equal(GATE_HOLD_MS, spec.gateMs);
  assert.ok(GATE_HOLD_MS > 0 && GATE_HOLD_MS <= 5000, 'bounded, so the cover cannot sit there');
  assert.ok(GATE_HOLD_MS < CONNECT_DEADLINE_MS, 'and shorter than a press, which is an attempt still in flight');
});

/* ------------------------------------------------ the gate the reader never sees */

test('a gate nobody presses puts the cover up and lands on the failed state, never a lift', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'pageReady', title: '' });
  press.report({ event: 'gateShown', title: 'Gateway unreachable' });
  assert.deepEqual(log, ['cover'], 'the page\'s own connection screen is never revealed');
  assert.deepEqual(timers.delays(), [spec.gateMs], 'and the hold is bounded');
  assert.equal(press.onGate, true);
  timers.fire();
  assert.deepEqual(log, ['cover', 'fail:gate:Gateway unreachable'], 'the page\'s own words, where it had them');
  assert.equal(press.onGate, false);
});

test('a gate that answers says the gateway is not answering when the page said nothing', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'gateShown', title: '' });
  timers.fire();
  assert.deepEqual(log, ['cover', 'fail:gate']);
});

test('a gate that goes away again lifts the cover, and lifts nothing after a failure', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'gateShown', title: '' });
  press.report({ event: 'gateGone', title: '' });
  assert.deepEqual(log, ['cover', 'lift:gate-gone'], 'the gate left because the interface replaced it');
  assert.equal(timers.size, 0, 'and nothing is left armed');

  const after = fakeTimers();
  const gone = host(after);
  gone.press.report({ event: 'gateShown', title: '' });
  after.fire();
  gone.press.report({ event: 'gateGone', title: '' });
  assert.deepEqual(gone.log, ['cover', 'fail:gate'], 'a cover that has failed is not lifted by a later gate-gone');
});

test('page-ready forgets a gate from the document before it', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'gateShown', title: '' });
  press.report({ event: 'pageReady', title: '' });
  assert.equal(press.onGate, false, 'a gate reported by one document says nothing about the next');
  press.report({ event: 'gateGone', title: '' });
  assert.deepEqual(log, ['cover'], 'so a new page\'s own report cannot be read as that gate ending');
  timers.fire();
  assert.deepEqual(log, ['cover'], 'and its hold is gone with it');
});

test('a press takes the cover over from the gate, and its deadline replaces the hold', () => {
  const timers = fakeTimers();
  const { press, log } = host(timers);
  press.report({ event: 'gateShown', title: '' });
  press.report({ event: 'pressed', title: '' });
  assert.deepEqual(log, ['cover', 'cover'], 'the same cover, raised for the press');
  assert.deepEqual(timers.delays(), [spec.deadlineMs], 'the hold is replaced, not kept beside it');
  timers.fire();
  assert.deepEqual(log, ['cover', 'cover', 'fail:deadline']);
});

/* ------------------------------------------------------- the page's half */

/**
 * A page with a login gate, reduced to what the script reads: whether the gate
 * and its failure callout are in the document, capture listeners, a mutation
 * observer, and animation frames and timeouts the test steps by hand.
 *
 * The page starts with NO gate, as a document at document-start does: the gate is
 * drawn later, by the page booting and giving up, which is what mountGate does.
 * That is also the only honest way to test the gate's arrival, which is a report
 * the script posts.
 */
function gatePage({ gate = false, failure = true } = {}) {
  const posts = [];
  const listeners = { click: [], keydown: [] };
  const frames = [];
  const timeouts = [];
  const observers = new Set();
  const state = { gate, failure, title: 'Gateway unreachable' };
  const element = (selector) => ({ nodeType: 1, matches: (s) => s === selector });
  const document = {
    documentElement: {},
    addEventListener: (type, fn, capture) => {
      if (type === 'click' || type === 'keydown') assert.equal(capture, true,
        'the press listeners are capture phase, ahead of the page');
      (listeners[type] = listeners[type] || []).push(fn);
    },
    querySelector: (selector) => {
      if (selector === spec.selectors.gate) return state.gate ? {} : null;
      if (selector === spec.selectors.failure) return state.gate && state.failure ? {} : null;
      if (selector === spec.selectors.failureTitle) return state.gate && state.failure ? { textContent: state.title } : null;
      return null;
    },
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(target) { this.target = target; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const window = { webkit: { messageHandlers: { clawPairing: { postMessage: (p) => posts.push(JSON.parse(JSON.stringify(p))) } } } };
  vm.runInNewContext(LOGIN_GATE_CONNECT_SCRIPT, {
    window,
    document,
    MutationObserver,
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {},
  });
  const changed = () => [...observers].forEach((o) => o.cb([]));
  return {
    posts,
    state,
    mountGate: () => { state.gate = true; changed(); },
    dropGate: () => { state.gate = false; changed(); },
    click: (selector) => listeners.click.forEach((fn) => fn({ composedPath: () => [element(selector), {}] })),
    enter: (selector) => listeners.keydown.forEach((fn) => fn({ key: 'Enter', isComposing: false, composedPath: () => [element(selector)] })),
    mutate: changed,
    runTimeouts: () => { const due = timeouts.splice(0); due.forEach((fn) => fn()); },
    frame: () => { const due = frames.splice(0); due.forEach((fn) => fn()); },
    // The gate watcher observes the DOCUMENT and stays for the page's life; the
    // press watcher observes documentElement and is disconnected when its watch
    // ends. So "watching" is the press's, which is what these tests mean by it.
    get watching() { return [...observers].some((o) => o.target !== document); },
  };
}

test('the script reports the gate as it arrives, the press, and rendered only once the gate has gone and two frames have passed', () => {
  const page = gatePage();
  assert.deepEqual(page.posts, [{ kind: 'page-ready' }], 'a document beginning is what forgets the last one\'s gate');
  page.mountGate();
  assert.deepEqual(page.posts[1], { kind: 'gate-shown', title: 'Gateway unreachable' });
  page.click(spec.selectors.connect);
  assert.deepEqual(page.posts[2], { kind: 'connect-pressed' });
  page.state.failure = false;
  page.mutate();
  assert.equal(page.posts.length, 3, 'the gate is still up, so nothing has rendered');
  page.dropGate();
  assert.deepEqual(page.posts[3], { kind: 'gate-gone' }, 'the gate leaving is reported too');
  assert.equal(page.posts.length, 4, 'not yet: the frame carrying the interface has not been presented');
  page.frame();
  page.frame();
  assert.deepEqual(page.posts.slice(2), [{ kind: 'connect-pressed' }, { kind: 'gate-gone' }, { kind: 'connect-rendered' }]);
  assert.equal(page.watching, false);
});

test('rendered is still reported when the page is given no frames, after a short bound', () => {
  const page = gatePage();
  page.mountGate();
  page.click(spec.selectors.connect);
  page.dropGate();
  assert.equal(page.posts.length, 4);
  page.runTimeouts();
  assert.deepEqual(page.posts.slice(2), [{ kind: 'connect-pressed' }, { kind: 'gate-gone' }, { kind: 'connect-rendered' }], 'a covered web view on iOS may never be given a frame');
  page.frame();
  page.frame();
  assert.equal(page.posts.length, 5, 'and once only, when the frames do come');
});

test('the old failure still on screen at the press is not this attempt failing', () => {
  const page = gatePage({ failure: true });
  page.mountGate();
  page.click(spec.selectors.connect);
  page.mutate();
  assert.deepEqual(page.posts.slice(2), [{ kind: 'connect-pressed' }], 'the stale callout must not read as an answer');
  page.state.failure = false;
  page.mutate();
  page.state.failure = true;
  page.mutate();
  assert.deepEqual(page.posts[3], { kind: 'connect-failed', title: 'Gateway unreachable' });
  assert.equal(page.watching, false);
});

test('Enter in the gate fields is the same press, and a click anywhere else is not', () => {
  const page = gatePage();
  page.mountGate();
  const base = page.posts.length;
  page.click('.somewhere-else');
  assert.equal(page.posts.length, base);
  page.enter(spec.selectors.fields);
  assert.deepEqual(page.posts.slice(base), [{ kind: 'connect-pressed' }]);
  page.enter(spec.selectors.fields);
  assert.equal(page.posts.length, base + 1, 'one press at a time');
});

test('a press with no gate on screen is not this', () => {
  const page = gatePage();
  page.click(spec.selectors.connect);
  assert.deepEqual(page.posts, [{ kind: 'page-ready' }], 'nothing but the document beginning');
});

test('the script stops watching at the deadline, so a late answer cannot follow a failed cover', () => {
  const page = gatePage();
  page.mountGate();
  page.click(spec.selectors.connect);
  assert.equal(page.watching, true);
  page.runTimeouts();
  assert.equal(page.watching, false);
  page.dropGate();
  page.frame();
  page.frame();
  assert.ok(!page.posts.some((p) => p.kind === 'connect-rendered'), 'a late answer must not follow a failed cover');
  assert.deepEqual(page.posts.slice(-1), [{ kind: 'gate-gone' }]);
});

test('the script posts on the pairing observer channel, and carries the spec values', () => {
  assert.ok(LOGIN_GATE_CONNECT_SCRIPT.includes('messageHandlers.' + pairingSpec.messageName));
  assert.ok(LOGIN_GATE_CONNECT_SCRIPT.includes('window.' + pairingSpec.global + ' = payload'));
  assert.ok(LOGIN_GATE_CONNECT_SCRIPT.includes('var WATCH_MS = ' + spec.deadlineMs + ';'));
  for (const [key, selector] of Object.entries(spec.selectors)) {
    assert.ok(LOGIN_GATE_CONNECT_SCRIPT.includes("'" + selector + "'"), key + ' is the selector the script uses');
  }
  for (const kind of Object.values(spec.reports)) assert.ok(LOGIN_GATE_CONNECT_SCRIPT.includes("'" + kind + "'"));
});

/* ------------------------------------------------------------ upstream pin */

const CHECKOUT = process.env.CLAW_OPENCLAW_UI || path.join(os.homedir(), 'src', 'openclaw', 'ui');
const COMPONENT = path.join(CHECKOUT, spec.upstreamComponent);

test('the selectors are the ones the upstream login gate still draws', { skip: !fs.existsSync(COMPONENT) && 'no OpenClaw checkout to compare against' }, () => {
  const source = fs.readFileSync(COMPONENT, 'utf8');
  assert.ok(source.includes('"' + spec.selectors.gate + '"'), 'the gate element is still ' + spec.selectors.gate);
  for (const key of ['connect', 'failure', 'failureTitle']) {
    const name = spec.selectors[key].slice(1);
    assert.match(source, new RegExp('class="[^"]*\\b' + name + '(?=["\\s])'), key + ' (' + name + ') is still a class the gate draws');
  }
  assert.match(source, /class="login-gate__form"/);
  assert.match(source, /e\.key === "Enter"[\s\S]{0,80}props\.onConnect\(\)/, 'Enter in a field is still a submission');
});
