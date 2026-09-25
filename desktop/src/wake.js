// The desktop half of the wake and reconnect rule: it REPORTS events and carries
// out the actions, and core/wake.js decides which. Kept apart from main.js so the
// event orders can be driven from node --test without Electron.
//
// The actions:
//   close      forget the document on screen, so the next connect is a fresh
//              page load rather than a resume of a socket the sleep killed. The
//              document itself goes when that load replaces it, which closes its
//              socket with a clean 1001 instead of leaving it half-open.
//   cover      put the loading cover up and wait (no network yet).
//   reconnect  cover, then load the page fresh.
//   uncover    nothing to do here: the cover comes down on the load that
//              finished, in main.js, and this only records that it did.

import { INITIAL, eventFor, step } from '../../core/wake.js';

/**
 * @param {{close: Function, cover: Function, reconnect: Function, uncover?: Function, log?: Function}} actions
 */
export function createWake(actions) {
  let state = INITIAL;
  const log = actions.log || (() => {});
  function report(event, why = event) {
    const next = step(state, event);
    if (next.state !== state || next.action !== 'none') {
      log(`[chela-desktop] wake: ${why}: ${state} -> ${next.state} (${next.action})`);
    }
    state = next.state;
    const fn = actions[next.action];
    if (typeof fn === 'function') fn();
    return next.action;
  }
  return {
    report,
    /** A raw platform event name, e.g. 'powerMonitor:resume'. Unknown names do nothing. */
    reportRaw(raw) {
      const event = eventFor('desktop', raw);
      return event ? report(event, raw) : 'none';
    },
    get state() { return state; },
  };
}
