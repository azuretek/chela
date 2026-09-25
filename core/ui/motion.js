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

/* ------------------------------------------------------------ view motion */

// The sheet, screen and spring values below are the ones core/ui/ui.css restates
// as custom properties (a page cannot import this module), and core/test/
// motion.test.js holds the two to each other. mobile/Chela/Motion.swift reads the
// same spec on iOS. The rules that use them are ui/CONVENTIONS.md.

/** How Settings and About arrive and leave: an iOS sheet's slide and its curve. */
export const SHEET = Object.freeze({
  enterMs: spec.motion.sheet.enterMs,
  leaveMs: spec.motion.sheet.leaveMs,
  curve: Object.freeze([...spec.motion.sheet.curve]),
});

/** The sheet's curve as the CSS the stylesheet writes it in. */
export function sheetEase(curve = SHEET.curve) {
  return `cubic-bezier(${curve.join(', ')})`;
}

/** How long a screen inside a surface takes to move. */
export const SCREEN_MS = spec.motion.screenMs;

/** The pairing screen's spring, in SwiftUI's own terms. */
export const SPRING = Object.freeze({ ...spec.motion.spring });

/**
 * A spring, sampled into a CSS `linear()` easing and the duration it runs for.
 *
 * CSS has no spring, and SwiftUI's `.spring(response:dampingFraction:)` is what
 * the phone runs, so the desktop runs the SAME spring by sampling its position over
 * time: a damped harmonic oscillator released from 0 towards 1, with the natural
 * frequency SwiftUI derives from `response` (2π / response) and the damping ratio
 * as given. The duration is how long the spring takes to settle within `settle`
 * of its rest, so the animation ends where the motion does rather than on a
 * number chosen beside it.
 *
 * Deterministic and clock-free, so the stylesheet's restated string can be
 * recomputed and compared in a test rather than trusted.
 *
 * @param {{ responseMs: number, dampingFraction: number }} [spring]
 * @param {{ samples?: number, settle?: number }} [options]
 * @returns {{ durationMs: number, linear: string }}
 */
export function springCurve(spring = SPRING, { samples = 24, settle = 0.001 } = {}) {
  const omega = (2 * Math.PI) / (spring.responseMs / 1000);
  const zeta = spring.dampingFraction;
  const position = (t) => {
    if (zeta < 1) {
      const damped = omega * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
    }
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  };
  const settleS = Math.log(1 / settle) / (Math.min(zeta, 1) * omega);
  const durationMs = Math.round((settleS * 1000) / 10) * 10;
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const value = i === samples ? 1 : position((i / samples) * (durationMs / 1000));
    points.push(Number(value.toFixed(3)));
  }
  return { durationMs, linear: `linear(${points.join(', ')})` };
}
