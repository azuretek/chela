// The minimum-visible-duration primitive, as the thing that makes the rule hold.
//
// ui/CONVENTIONS.md states the design-language rule ("a transient state is held
// long enough to be understood, never a flash"). This is the half that fails when
// the code stops following it, and it is clock-free on purpose: it takes `now` and
// a `shownAt` and answers a duration, so it can be exercised for every timing from
// one test run and it can be shared by the desktop's main process, a page, and the
// phone without any of them owning a clock.
//
// THE FAULT THIS ANSWERS. A state that changes faster than a reader can read it is
// a flash: it appears and is gone before the eye settles on it, which is worse than
// not showing it, because the reader knows something happened and never learned
// what. It was reported on the "Check for updates" button (Abi, 2026-09-18): a
// second press "just flashes and returns quickly" because the answer settles in the
// time a cached network reply takes, which is no time at all. The answer is not to
// slow the WORK down; it is to floor how long the state it produces STAYS on
// screen, so the transfer, the check or the fetch finishes when it finishes and the
// card it raised is held until it has been up long enough to read.

import spec from '../spec/tokens.json' with { type: 'json' };

/**
 * ★ How long a transient state must stay on screen before it may be replaced, in
 * milliseconds.
 *
 * A named value in the token spec rather than a number at a timer, because it is a
 * design-language constant every transient state floors itself against, and a
 * second copy of it is the drift this primitive exists to remove. It sits beside
 * the animation durations because it is the same kind of thing: a duration the
 * reader experiences, owned in one place.
 *
 * 900ms, and the reasoning is about reading rather than taste. A transient state
 * carries a short sentence a reader has to find, fixate and read: fixation alone is
 * ~200-250ms, and a glance that lands, reads a few words and confirms them runs to
 * most of a second. Below that a state that changes is a flash; much above it and a
 * reader who has already read the state is kept waiting on a control that is done.
 * It is deliberately far longer than the animation tokens (--duration-normal is
 * 180ms): those govern how a thing MOVES, this governs how long it STAYS, and the
 * two are different questions. It is deliberately shorter than the answer TTL
 * (9s): a floor on the minimum is not a ceiling on the whole life.
 */
export const MIN_VISIBLE_MS = spec.motion.minVisibleMs;

/**
 * How much longer a transient state must remain before it may be replaced.
 *
 * The whole of the primitive: given when a state was shown and how long the floor
 * is, it answers how many milliseconds are still owed. Zero once the floor is met,
 * which is the caller's signal that a replacement may proceed now, and a positive
 * number is how long to hold before it does. A caller with something newer to show
 * waits this long and then shows it; a caller with nothing newer ignores it.
 *
 * ★ Measured from when the state was SHOWN, never from when the work started: a
 * check that took two seconds has already shown nothing for two seconds, so its
 * answer, once drawn, is still owed the full floor. That is why `shownAt` is the
 * argument and not `startedAt`.
 *
 * Defensive about its inputs because it is called from event handlers where a
 * missing timestamp must not throw: an unusable `shownAt` is treated as "shown
 * now", which owes the full floor rather than none, so the failure mode is a state
 * held too long rather than one that flashes.
 *
 * @param {number} shownAt   Date.now() when the transient state went on screen
 * @param {number} [minMs]   the floor; MIN_VISIBLE_MS by default
 * @param {number} [now]     Date.now(), injectable so the rule is testable
 * @returns {number} milliseconds still owed, 0 once the floor is met
 */
export function remainingVisibleMs(shownAt, minMs = MIN_VISIBLE_MS, now = Date.now()) {
  const floor = Number.isFinite(minMs) && minMs > 0 ? minMs : 0;
  if (floor === 0) return 0;
  const shown = Number.isFinite(shownAt) ? shownAt : now;
  const elapsed = now - shown;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return floor;
  return Math.max(0, floor - elapsed);
}

/**
 * Whether a transient state shown at `shownAt` has been up long enough to replace.
 *
 * The boolean form of the function above, for a caller that only wants the yes/no
 * and not the wait. `held` reads as the question it answers: has this been held
 * long enough?
 *
 * @param {number} shownAt
 * @param {number} [minMs]
 * @param {number} [now]
 * @returns {boolean}
 */
export function heldLongEnough(shownAt, minMs = MIN_VISIBLE_MS, now = Date.now()) {
  return remainingVisibleMs(shownAt, minMs, now) === 0;
}
