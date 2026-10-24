import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the proof's actual predicate, rather than asserting its source shape.
const source = fs.readFileSync(new URL('../scripts/test-about-surface.js', import.meta.url), 'utf8');
const start = source.indexOf('function rowFeetUsePadding(sections) {');
assert.notEqual(start, -1);
const end = source.indexOf('\n}', start);
assert.notEqual(end, -1);
const rowFeetUsePadding = vm.runInNewContext('(' + source.slice(start, end + 2) + ')');
const updates = { title: 'Updates', contentBottomGap: 17, rowBottomPad: '16px' };

test('the remaining Updates card is measured against its own row padding', () => {
  assert.equal(rowFeetUsePadding([updates]), true);
  assert.equal(rowFeetUsePadding([{ ...updates, contentBottomGap: 37 }]), false);
  assert.equal(rowFeetUsePadding([{ ...updates, contentBottomGap: 0 }]), false);
  assert.equal(rowFeetUsePadding([{ ...updates, rowBottomPad: 'invalid' }]), false);
});

test('missing measurements and a returned cache card cannot pass vacuously', () => {
  assert.equal(rowFeetUsePadding([]), false);
  assert.equal(rowFeetUsePadding(null), false);
  assert.equal(rowFeetUsePadding([{ ...updates, contentBottomGap: null }]), false);
  assert.equal(rowFeetUsePadding([{ ...updates, title: 'Cache' }]), false);
  assert.equal(rowFeetUsePadding([updates, { ...updates, title: 'Cache' }]), false);
});
