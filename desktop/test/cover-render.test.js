// The loading cover stays up until the gateway page has RENDERED, not merely
// loaded. core/render-ready.js owns the rule and its tests; this holds main.js to
// using it on the one path that lifts the cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function body(start, end) {
  const from = src.indexOf(start);
  assert.ok(from >= 0, `main.js has no ${start}`);
  const to = src.indexOf(end, from + start.length);
  assert.ok(to > from, `main.js has no ${end} after ${start}`);
  return src.slice(from, to);
}

test('a finished gateway load hands the cover to the render gate rather than taking it down', () => {
  const finished = body("wc.on('did-finish-load'", "wc.on('did-fail-load'");
  assert.doesNotMatch(finished, /hideLoadingCover\(\)/, 'the load event must not lift the cover: the page has not painted yet');
  assert.match(finished, /coverGate\.loaded\(wc\)/);
});

test('the gate probes the page for a paint and lifts through hideLoadingCover', () => {
  const gate = body('const coverGate = createCoverGate(', '\n});');
  assert.match(gate, /executeJavaScript\(RENDERED_PROBE\)/);
  // Through liftCover, which is the one place the cover comes down for a paint:
  // the gate calls it at once, or a restart's floor calls it once the floor ends.
  assert.match(gate, /liftCover\(why\)/);
  assert.match(body('function liftCover(why) {', '\n}\n'), /hideLoadingCover\(\)/);
  assert.match(gate, /connectionState\.FAILED/, 'a connection that failed while waiting keeps its cover');
});

test('raising the cover again voids a lift still waiting on the page before', () => {
  assert.match(body('function showLoadingCover() {', '\n}\n'), /coverGate\.hold\(\)/);
});

test('nothing else lifts the cover early', () => {
  const calls = src.match(/\bhideLoadingCover\(\);/g) || [];
  assert.equal(calls.length, 1, 'only the render gate (through liftCover) calls hideLoadingCover');
});
