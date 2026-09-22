// The keyed notice store, as core owns it.
//
// The three properties worth pinning at the source: raising the same id twice
// replaces rather than stacks, the list is sorted worst-first then oldest-first,
// and reading a notice takes it out of unread() while leaving it in the store.

import test from 'node:test';
import assert from 'node:assert';

import { create, sentence, ERROR, WARN, INFO, OK } from '../notices.js';

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

test('the sweep quiets EVERY notice on the bar, including one whose X clears', () => {
  // The fault this rule was written for (Abi, 2026-09-18): the sweep skipped the
  // notices that refuse to be dismissed and the ones whose own X clears, so a bar
  // swept to nothing could still be left carrying exactly one card. A card that
  // comes back after being read is the report, and this was the likeliest one.
  const store = create();
  store.set('update', { tone: OK, message: 'Downloading', progress: 0.4, dismissible: false });
  store.set('download', { tone: OK, message: 'Downloading another', progress: 0.2, dismissClears: true });
  store.set('conn', { tone: ERROR, message: 'down' });

  assert.equal(store.markAllRead(), true);
  assert.deepEqual(store.unread(), [], 'nothing is left on the bar for the run');
  assert.equal(store.size(), 3, 'and nothing was CLEARED: quieting is not clearing');
  assert.equal(store.get('download').dismissClears, true);
  // The X still ends that condition and nothing else does: the sweep reached the
  // card's READ state, not the transfer behind it.
  assert.equal(store.dismiss('download'), true, 'its own X still ends it');
  assert.equal(store.get('download'), null);
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

test('a detail that moved on a notice about something arriving is not news', () => {
  // The download's own case: the number under the sentence moves every tick and
  // the sentence does not, so a reader who acknowledged the card has not been told
  // anything since and must not see it again.
  const store = create();
  const downloading = {
    tone: OK, message: 'Downloading Chela 1.0.1.', detail: '25 MB of 130 MB, 2 MB/s.', progress: 0.2,
  };
  store.set('update-available', downloading);
  store.markRead('update-available');

  assert.equal(
    store.set('update-available', { ...downloading, detail: '60 MB of 130 MB, 3 MB/s.', progress: 0.46 }),
    true,
    'the bar genuinely moved',
  );
  assert.deepEqual(store.unread(), [], 'and that is the same news, so the reader is not told twice');
});

test('a detail that moved on an ordinary notice IS news', () => {
  // The other half of the rule, and the one that must not be lost with it: a
  // connection that was refused and is now failing to resolve says something
  // different, and staying read would hide that under a card already waved away.
  const store = create();
  store.set('connection', { tone: ERROR, message: 'Cannot connect', detail: 'Refused.' });
  store.markRead('connection');
  store.set('connection', { tone: ERROR, message: 'Cannot connect', detail: 'The name did not resolve.' });
  assert.deepEqual(store.unread().map((n) => n.id), ['connection']);
});

test('a raise the reader asked for is unread even when nothing changed', () => {
  // The explicit "Check for updates": the reader pressed the button, so the card
  // belongs on screen whether or not that same card was read before. The passive
  // check is the other half and leaves it where it was.
  const store = create();
  const card = { tone: INFO, message: 'Chela 1.0.1 is available.', detail: 'You are on 1.0.0.' };
  store.set('update-available', card);
  store.markRead('update-available');

  assert.deepEqual(store.unread(), [], 'read, so quiet');
  assert.equal(store.set('update-available', card), false, 'a re-raise that says the same thing is not even a change');
  assert.deepEqual(store.unread(), [], 'and the card stays quiet');
  assert.equal(store.set('update-available', card, { announce: true }), true, 'the ask is a change');
  assert.deepEqual(store.unread().map((n) => n.id), ['update-available'], 'so the asker sees it');
});

test('sentence capitalises the front and closes the back, once', () => {
  assert.equal(sentence('running from source'), 'Running from source.');
  assert.equal(sentence('Already done.'), 'Already done.');
  assert.equal(sentence('ERR_CODE'), 'ERR_CODE.');
  assert.equal(sentence(''), '');
  assert.equal(sentence('ends with colon:'), 'Ends with colon:');
});
