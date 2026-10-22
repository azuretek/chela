// Native lifecycle signals preserve a surviving document. The Control UI owns
// transport health, reconnect, history resync and outbox reconciliation.
// Sleep and offline transitions never discard or cover the conversation.

import { INITIAL, eventFor, step } from '../../core/wake.js';

/**
 * @param {{reconnect: Function, uncover?: Function, log?: Function}} actions
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
