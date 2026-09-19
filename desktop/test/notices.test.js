// The banner's store.
//
// The property that makes "stays until it resolves" true rather than decorative
// is that a notice is keyed by *condition* and not by occurrence: raising the
// same one twice replaces it, and the raiser clears it when the condition
// passes. Without that it is a log with a slide animation, three copies of the
// same warning stacking up while the thing they describe is still broken.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as notices from '../src/notices.js';
import updates from '../src/updates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('the same condition raised twice is one banner, not two', () => {
  const n = notices.create();
  n.set('shortcut', { message: 'The global shortcut is not active.' });
  n.set('shortcut', { message: 'The global shortcut is not active.' });
  assert.equal(n.size(), 1);
});

test('an identical re-raise reports no change, so the slide is not replayed', () => {
  const n = notices.create();
  assert.equal(n.set('a', { message: 'x' }), true, 'first raise is a change');
  assert.equal(n.set('a', { message: 'x' }), false, 'the same thing again is not');
  assert.equal(n.set('a', { message: 'y' }), true, 'different text is');
});

test('clearing reports whether there was anything to clear', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  assert.equal(n.clear('a'), true);
  assert.equal(n.clear('a'), false, 'clearing a condition that already passed is a no-op');
  assert.equal(n.size(), 0);
});

test('errors sort above warnings, and older above newer within a severity', () => {
  const n = notices.create();
  n.set('w1', { tone: notices.WARN, message: 'first warning' });
  n.set('e1', { tone: notices.ERROR, message: 'the error' });
  n.set('w2', { tone: notices.WARN, message: 'second warning' });
  assert.deepEqual(n.list().map((x) => x.id), ['e1', 'w1', 'w2']);
});

test('updating a notice does not move it to the bottom', () => {
  // Otherwise a banner someone is mid-sentence through jumps under a newer one
  // because its detail text was refreshed.
  const n = notices.create();
  n.set('a', { tone: notices.WARN, message: 'a' });
  n.set('b', { tone: notices.WARN, message: 'b' });
  n.set('a', { tone: notices.WARN, message: 'a, revised' });
  assert.deepEqual(n.list().map((x) => x.id), ['a', 'b']);
});

test('a notice defaults to an error and to being dismissible', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  const [notice] = n.list();
  assert.equal(notice.tone, notices.ERROR);
  assert.equal(notice.dismissible, true);
  assert.equal(notice.detail, null);
});

test('two stores do not share state', () => {
  // The module exports a factory rather than a singleton so a test cannot leak
  // into the next one, and so main owns exactly one instance on purpose.
  const a = notices.create();
  const b = notices.create();
  a.set('x', { message: 'x' });
  assert.equal(b.size(), 0);
});

test('a detail line reads as a sentence even when the OS string does not', () => {
  // Every detail is one of our sentences with a string from the OS dropped in,
  // and those start and end however they start and end.
  assert.equal(notices.sentence('conversion failure from Frobnicate+Zz'), 'Conversion failure from Frobnicate+Zz.');
  assert.equal(notices.sentence('Already ends.'), 'Already ends.');
  assert.equal(notices.sentence('So does this!'), 'So does this!');
  assert.equal(notices.sentence('  padded  '), 'Padded.');
  assert.equal(notices.sentence(''), '', 'nothing in, nothing out, not a lone full stop');
  assert.equal(notices.sentence(null), '');
});

test('a reason written to be appended still reads standing alone', () => {
  // update.policy() phrases its reason for the middle of a sentence ("...because
  // it is running from source"). In the banner it is the whole line, and an
  // uncapitalised one looks like the start of it went missing.
  assert.equal(notices.sentence('running from source'), 'Running from source.');
});

test('an error code keeps its own capitals', () => {
  // Only the first character is touched, so a Chromium code arrives unharmed.
  assert.equal(notices.sentence('ERR_EMPTY_RESPONSE'), 'ERR_EMPTY_RESPONSE.');
});

test('good news sorts below a failure, so an alarm is never pushed down', () => {
  const store = notices.create();
  store.set('good', { tone: notices.OK, message: 'Connected' });
  store.set('bad', { tone: notices.ERROR, message: 'Cannot connect' });
  assert.deepEqual(store.list().map((n) => n.id), ['bad', 'good']);
});

/* ----------------------------------------------------------------- actions */

test('an action survives the round trip and is offered to the banner', () => {
  const n = notices.create();
  n.set('connection', { message: 'Cannot connect', action: { label: 'Open Settings', command: 'settings' } });
  assert.deepEqual(n.list()[0].action, { label: 'Open Settings', command: 'settings' });
});

test('a notice with no action says so explicitly rather than omitting the key', () => {
  // The banner reads `notice.action` directly; undefined and null behave the
  // same there, but the shape crossing IPC should not depend on that.
  const n = notices.create();
  n.set('shortcut', { message: 'The shortcut was refused' });
  assert.equal(n.list()[0].action, null);
});

test('a changed action counts as a change, even when the words do not move', () => {
  const n = notices.create();
  const base = { message: 'Cannot connect', detail: 'The gateway did not respond.' };
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'settings' } }), true);
  // Identical in every field: no re-render, so a banner that has been sitting
  // there does not replay its slide.
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'settings' } }), false);
  // Same words, different offer. A button that silently starts doing something
  // else is worse than a re-render.
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'reconnect' } }), true);
  // And dropping the offer entirely.
  assert.equal(n.set('connection', base), true);
});

test('every notice id is a literal, so the banner has a ceiling', () => {
  // The bound is one notice per condition, and the store enforces it by id. What
  // nothing enforces is that the ids are countable: an id built from a variable,
  // `cert-${host}` say, would raise a fresh banner per host and stack without
  // limit. Nothing would fail, the banner would just grow. So this reads the
  // call sites rather than the store, because the store cannot see the
  // difference.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  // The floored transients go through raiseFloored, which forwards a bounded id to
  // setNotice internally: its own `setNotice(id, ...)` is the one call site whose
  // id is a variable BY DESIGN, because the id it forwards was already checked at
  // raiseFloored's call sites. So the ceiling is read at both surfaces: every
  // setNotice id must be a literal, EXCEPT the single forward inside raiseFloored,
  // and every raiseFloored id must be a literal too, which is what keeps the
  // forwarded id countable.
  const setNoticeIds = [...main.matchAll(/(?<!function )setNotice\(\s*([^,]+),/g)]
    .map((m) => m[1].trim())
    .filter((id) => id !== 'id'); // the one forward inside raiseFloored, checked below
  const flooredIds = [...main.matchAll(/(?<!function )raiseFloored\(\s*([^,]+),/g)]
    .map((m) => m[1].trim())
    .filter((id) => id !== 'id'); // raiseFloored's own recursive re-raise forwards the checked id
  const ids = [...setNoticeIds, ...flooredIds];

  assert.ok(ids.length >= 7, `expected every call site, found ${ids.length}`);
  for (const id of ids) {
    assert.ok(
      /^'[a-z][a-z-]*'$/.test(id) || /^[A-Z][A-Z_]*$/.test(id),
      `notice id is not a literal, so the banner is unbounded: ${id}`,
    );
  }
  // And the one forward is genuinely the helper's, so the filter above cannot be
  // used to smuggle an unbounded id in: raiseFloored's own body is where `id` may
  // be a variable, and nowhere else calls setNotice with a bare `id`.
  // The `(?<!function )` guard drops the two function DEFINITIONS (setNotice and
  // raiseFloored both open `function name(id, ...`), leaving only real forwards.
  const setForwards = [...main.matchAll(/(?<!function )setNotice\(\s*id,/g)];
  assert.equal(setForwards.length, 1, 'setNotice(id, ...) may appear only once, inside raiseFloored');
  // raiseFloored's own recursive re-raise forwards the same checked id, so it too
  // may appear only inside the helper: the recursive call and no other.
  const flooredForwards = [...main.matchAll(/(?<!function )raiseFloored\(\s*id,/g)];
  assert.equal(flooredForwards.length, 1, 'raiseFloored(id, ...) may appear only once, its own re-raise');
  assert.match(
    /function raiseFloored\(id, notice[\s\S]*?setNotice\(id, notice,/.exec(main)?.[0] ?? '',
    /setNotice\(id, notice,/,
    'the one setNotice(id, ...) forward is not the one inside raiseFloored',
  );
});

/* -------------------------------------------------------------------- read */

test('reading a notice takes it off the banner and leaves the condition', () => {
  // The two are different questions. Clearing says the shortcut works now;
  // reading says you have been told it does not.
  const n = notices.create();
  n.set('shortcut', { message: 'The shortcut was refused' });
  assert.equal(n.markRead('shortcut'), true);
  assert.equal(n.unread().length, 0, 'off the banner');
  assert.equal(n.size(), 1, 'still true');
  assert.equal(n.list()[0].read, true);
});

test('reading twice reports no change, so the banner is not re-rendered', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  assert.equal(n.markRead('a'), true);
  assert.equal(n.markRead('a'), false);
  assert.equal(n.markRead('never-existed'), false);
});

test('a notice arrives unread', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  assert.equal(n.list()[0].read, false);
  assert.deepEqual(n.unread().map((x) => x.id), ['a']);
});

test('a condition that changes after being read comes back unread', () => {
  // The failure that matters most: read "cannot connect: refused", then the
  // reason becomes something else entirely. Staying read would hide the new
  // reason under a banner that was already waved away.
  const n = notices.create();
  n.set('connection', { message: 'Cannot connect', detail: 'Refused.' });
  n.markRead('connection');
  assert.equal(n.unread().length, 0);

  n.set('connection', { message: 'Cannot connect', detail: 'The name did not resolve.' });
  assert.deepEqual(n.unread().map((x) => x.id), ['connection'], 'a different reason is news again');
});

test('an unchanged re-raise does not un-read a notice', () => {
  // A gateway retrying every few seconds re-raises the identical notice. If
  // that reopened the banner, reading it would be impossible.
  const n = notices.create();
  const same = { message: 'Cannot connect', detail: 'Refused.' };
  n.set('connection', same);
  n.markRead('connection');
  assert.equal(n.set('connection', same), false);
  assert.equal(n.unread().length, 0, 'still read, because nothing changed');
});

test('marking all read empties the banner in one go', () => {
  const n = notices.create();
  n.set('a', { message: 'a' });
  n.set('b', { tone: notices.WARN, message: 'b' });
  assert.equal(n.markAllRead(), true);
  assert.equal(n.unread().length, 0);
  assert.equal(n.size(), 2, 'nothing was cleared');
  assert.equal(n.markAllRead(), false, 'and again is a no-op');
});

test('the sweep leaves NOTHING on the bar for the run, a dismissClears card included', () => {
  // The report (Abi, 2026-09-18): mark everything read, and one card is still
  // there. It was the download, which the sweep skipped because its X ENDS its
  // condition rather than reading it. Quieting is not clearing, so the sweep must
  // read that card too and leave the transfer behind it alone.
  const n = notices.create();
  n.set('conn', { tone: notices.ERROR, message: 'Cannot connect' });
  n.set('update-available', {
    tone: notices.INFO,
    message: 'Downloading Claw Control UI 1.0.1.',
    detail: '25 MB of 130 MB.',
    progress: 0.2,
    dismissible: true,
    dismissClears: true,
  });

  assert.equal(n.markAllRead(), true);
  assert.deepEqual(n.unread(), [], 'the bar is empty for the run');
  assert.equal(n.size(), 2, 'and nothing was cleared');
  // Its own X still ends it, which is the half a sweep must not take over.
  assert.equal(n.dismiss('update-available'), true);
  assert.equal(n.get('update-available'), null);
});

test('a notice that cannot be dismissed can still be read one at a time', () => {
  // The bulk action used to be the only one that skipped it; an explicit
  // instruction about that one notice never did.
  const n = notices.create();
  n.set('update-available', { tone: notices.INFO, message: 'Downloading', dismissible: false });
  assert.equal(n.markRead('update-available'), true);
  assert.equal(n.unread().length, 0);
});

test('unread keeps the banner ordering, worst first', () => {
  const n = notices.create();
  n.set('ok', { tone: notices.OK, message: 'fine' });
  n.set('err', { tone: notices.ERROR, message: 'broken' });
  n.set('warn', { tone: notices.WARN, message: 'iffy' });
  assert.deepEqual(n.unread().map((x) => x.id), ['err', 'warn', 'ok']);
});

test('a progress tick does not re-unread a read notice, a changed message does', () => {
  // The download says the same sentence for the whole transfer while the number
  // under it moves. That is not new news, so it must not re-open a card the reader
  // acknowledged; a sentence that CHANGES is news and must.
  const n = notices.create();
  const downloading = {
    tone: notices.INFO, message: 'Downloading Claw Control UI 1.0.1.', detail: '25 MB of 130 MB.', progress: 0.2,
  };
  n.set('update-available', downloading);
  assert.equal(n.markRead('update-available'), true);
  assert.deepEqual(n.unread(), [], 'read, so off the bar');

  n.set('update-available', { ...downloading, detail: '60 MB of 130 MB.', progress: 0.46 });
  assert.deepEqual(n.unread(), [], 'the bar moved and the reader was not told again');

  n.set('update-available', {
    tone: notices.WARN,
    message: 'Downloading Claw Control UI 1.0.1. has stopped making progress.',
    detail: 'Nothing has arrived for 45 seconds.',
  });
  assert.deepEqual(n.unread().map((x) => x.id), ['update-available'], 'a changed message is news');
});

test('a user-initiated check re-raises the update card, a passive check does not', () => {
  // Abi, 2026-09-18: "if I click check for updates it should bring up the banner."
  // The asker is owed the answer on screen; a background check that finds the same
  // release again says nothing new and leaves a read card read.
  const n = notices.create();
  const card = { tone: notices.INFO, message: 'Claw Control UI 1.0.1 is available.', detail: 'You are on 1.0.0.' };
  n.set('update-available', card);
  n.markRead('update-available');

  for (const trigger of ['startup', 'scheduled']) {
    n.set('update-available', card, { announce: updates.announcesFound(trigger) });
    assert.deepEqual(n.unread(), [], `the ${trigger} check must stay quiet`);
  }

  n.set('update-available', card, { announce: updates.announcesFound('manual') });
  assert.deepEqual(n.unread().map((x) => x.id), ['update-available'], 'the reader asked, so it is back');
});

test('the desktop asks the store that question from the check trigger', () => {
  // The store half is proved above; this is the half that says the desktop asks it
  // the right question, because a rule no caller consults is not running.
  //
  // Sliced to onUpdateAvailable rather than grepped over the whole file, so the
  // guard fails for the reason it names: that function is where a check that found
  // a release becomes a card, and it is the one a manual press goes through.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const start = main.indexOf('function onUpdateAvailable(');
  assert.ok(start > 0, 'onUpdateAvailable is gone, and it is where the wiring lives');
  const body = main.slice(start, main.indexOf('\n/**', start));
  assert.match(body, /updates\.announcesFound\(lastTrigger\)/, 'the check trigger must reach the update card');
  assert.match(body, /\{ announce \}/, 'and the raise must carry what the trigger decided');
});

test('a NEW version raises again while the same version stays quiet once read', () => {
  // The update notice is keyed by the VERSION, which rides in its headline. The
  // same release found again is the same card and stays quiet; a new release is
  // news and comes back. Written against the real composition, so it fails if the
  // version ever stops being what tells two offers apart.
  const offer = (version) => updates.checkAnswer({
    outcome: updates.AVAILABLE,
    version,
    current: '1.0.0',
    action: updates.NOTIFY,
    trigger: 'scheduled',
  });
  const withAction = (answer) => ({
    ...answer, action: { label: 'Open release page', command: 'update-release-page' },
  });

  const n = notices.create();
  n.set('update-available', withAction(offer('1.0.1')));
  assert.equal(n.markRead('update-available'), true);
  assert.deepEqual(n.unread(), [], 'read, so quiet for the run');

  n.set('update-available', withAction(offer('1.0.1')));
  assert.deepEqual(n.unread(), [], 'the SAME version found again is the same card');

  n.set('update-available', withAction(offer('1.0.2')));
  assert.deepEqual(n.unread().map((x) => x.id), ['update-available'], 'a NEW version is news');
  assert.match(n.unread()[0].message, /1\.0\.2/, 'and its headline names the version');
});
