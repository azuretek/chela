// Connect pressed on the Control UI's OWN login gate: the desktop's wiring.
//
// core/test/login-gate-connect.test.js owns the behaviour (the press raises the
// cover, it lifts only on render, a refusal or the deadline lands on the failed
// state) and the injected script. This holds the desktop to using them: the
// script goes into the page beside the pairing observer, its reports are read on
// the observer's channel, and each ending goes through the app's own paths
// rather than a second cover. scripts/test-login-gate-connect.js measures the
// frames against a real gateway.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectedSources, parseReport } from '../src/pairing.js';
import { LOGIN_GATE_CONNECT_SCRIPT, CONNECT_REPORTS } from '../../core/login-gate-connect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');

function body(start, end) {
  const from = src.indexOf(start);
  assert.ok(from !== -1, 'expected ' + start + ' in main.js');
  const to = src.indexOf(end, from + start.length);
  assert.ok(to !== -1, 'expected the end of ' + start);
  return src.slice(from, to);
}

test('the watcher goes into the gateway page after the transport it posts through', () => {
  const sources = injectedSources();
  assert.equal(sources.length, 3);
  assert.equal(sources[2], LOGIN_GATE_CONNECT_SCRIPT);
});

test('its reports are read on the pairing channel, and nothing else is taken for one', () => {
  assert.deepEqual(parseReport(JSON.stringify({ kind: CONNECT_REPORTS.pressed })), { kind: 'connect', event: 'pressed', title: '' });
  assert.deepEqual(parseReport({ kind: CONNECT_REPORTS.rendered }), { kind: 'connect', event: 'rendered', title: '' });
  assert.deepEqual(parseReport({ kind: CONNECT_REPORTS.failed, title: 'Gateway unreachable' }), { kind: 'connect', event: 'failed', title: 'Gateway unreachable' });
  assert.equal(parseReport({ kind: 'connect-somewhere' }), null);
});

test('a report from the page drives the press, after the sender check', () => {
  const handler = body('function handlePairingReport(event, payload) {', '\n}\n');
  const sender = handler.indexOf('event.sender !== wc');
  const routed = handler.indexOf('connectPress.report(report)');
  assert.ok(sender !== -1 && routed > sender, 'only the gateway page itself may raise the cover');
});

test('the press raises the launch cover, lifts through the render path, and fails through the launch failure', () => {
  const press = body('const connectPress = createConnectPress({', '\n});');
  const cover = press.slice(press.indexOf('cover:'), press.indexOf('lift:'));
  const lift = press.slice(press.indexOf('lift:'), press.indexOf('fail:'));
  const fail = press.slice(press.indexOf('fail:'));
  assert.match(cover, /showLoadingCover\(\)/, 'the same loading screen a launch shows');
  assert.match(cover, /floorCover\(Date\.now\(\) \+ MIN_VISIBLE_MS\)/, 'held the minimum-visible floor from the press');
  assert.match(lift, /liftWhenAllowed\(why\)/, 'down through the same gate a load lifts through');
  assert.doesNotMatch(lift, /hideLoadingCover/);
  assert.match(fail, /showConnectionFailure\(/, 'the failed state with Try again, as a failed launch lands on');
});

test('a load of our own, or a failure, ends a press rather than leaving its deadline armed', () => {
  assert.match(body('function beginGatewayConnect(gw) {', '\n}\n'), /connectPress\.cancel\(\)/);
  assert.match(body('function showConnectionFailure(detail) {', '\n}\n'), /connectPress\.cancel\(\)/);
});
