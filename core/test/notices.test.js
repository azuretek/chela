// The keyed notice store, as core owns it.
//
// The three properties worth pinning at the source: raising the same id twice
// replaces rather than stacks, the list is sorted worst-first then oldest-first,
// and reading a notice takes it out of unread() while leaving it in the store.

import test from 'node:test';
import assert from 'node:assert';

import { create, sentence, ERROR, WARN, OK } from '../notices.js';

test('the same id replaces rather than stacks', () => {
  const store = create();
  store.set('conn', { tone: ERROR, message: 'down' });
  store.set('conn', { tone: ERROR, message: 'still down' });
  assert.equal(store.size(), 1);
  assert.equal(store.get('conn').message, 'still down');
});

test('an identical set reports no change', () => {
  const store = create();
  assert.equal(store.set('x', { tone: WARN, message: 'm' }), true);
  assert.equal(store.set('x', { tone: WARN, message: 'm' }), false);
});

test('list is sorted worst-first, then oldest-first within a tone', () => {
  const store = create();
  store.set('ok', { tone: OK, message: 'good' });
  store.set('err1', { tone: ERROR, message: 'bad1' });
  store.set('warn', { tone: WARN, message: 'meh' });
  store.set('err2', { tone: ERROR, message: 'bad2' });
  assert.deepEqual(store.list().map((n) => n.id), ['err1', 'err2', 'warn', 'ok']);
});

test('reading a notice takes it out of unread but leaves it in the store', () => {
  const store = create();
  store.set('c', { tone: ERROR, message: 'refused' });
  assert.equal(store.unread().length, 1);
  assert.equal(store.markRead('c'), true);
  assert.equal(store.unread().length, 0);
  assert.equal(store.get('c').read, true);
  assert.equal(store.size(), 1);
});

test('a change re-raises a read notice as unread', () => {
  const store = create();
  store.set('c', { tone: ERROR, message: 'refused' });
  store.markRead('c');
  store.set('c', { tone: ERROR, message: 'refused differently' });
  assert.equal(store.get('c').read, false);
});

test('markAllRead skips a non-dismissible notice', () => {
  const store = create();
  store.set('update', { tone: OK, message: 'Downloading', progress: 0.4, dismissible: false });
  store.set('conn', { tone: ERROR, message: 'down' });
  store.markAllRead();
  assert.equal(store.get('update').read, false, 'the download in flight stays unread');
  assert.equal(store.get('conn').read, true);
});

test('progress is part of the notice, and a move in it is a change', () => {
  // The bar and the sentence above it describe one condition, so they travel
  // together. Two channels to the banner could disagree about which phase a
  // download is in, and it would draw a bar over a notice saying it had
  // finished.
  const store = create();
  store.set('update-available', { tone: OK, message: 'Downloading', progress: 0.25 });
  assert.equal(store.get('update-available').progress, 0.25);
  assert.equal(
    store.set('update-available', { tone: OK, message: 'Downloading', progress: 0.25 }), false,
    'the same percent twice is not news',
  );
  assert.equal(store.set('update-available', { tone: OK, message: 'Downloading', progress: 0.5 }), true);
  // And it defaults to null, so a notice that is not about something arriving
  // draws no bar rather than one sitting at zero.
  store.set('conn', { tone: ERROR, message: 'down' });
  assert.equal(store.get('conn').progress, null);
});

test('sentence capitalises the front and closes the back, once', () => {
  assert.equal(sentence('running from source'), 'Running from source.');
  assert.equal(sentence('Already done.'), 'Already done.');
  assert.equal(sentence('ERR_CODE'), 'ERR_CODE.');
  assert.equal(sentence(''), '');
  assert.equal(sentence('ends with colon:'), 'Ends with colon:');
});
