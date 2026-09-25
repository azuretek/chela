// The wake and reconnect rule: what a client does when the machine sleeps,
// wakes, locks, loses or changes its network, or the page's socket misses its
// heartbeat.
//
// A queued message that hangs after idle or backgrounding is cleared by a client
// restart, and a restart is a fresh page load. So on every transition that can
// leave the page holding a dead socket and a stale outbox, the client shows the
// loading cover, loads the page fresh, and keeps the cover up until the page has
// rendered. On sleep it closes cleanly instead, so nothing is left half-open for
// the wake to inherit.
//
// One rule, one owner. The table lives in spec/wake.json and each platform only
// REPORTS its events into it: desktop from powerMonitor and the network, iOS from
// scenePhase and NWPathMonitor, both from the page's socket reports. The Swift
// client bundles the same file and walks the same table, so there is no port.

import spec from './spec/wake.json' with { type: 'json' };

export const STATES = Object.freeze([...spec.states]);
export const EVENTS = Object.freeze([...spec.events]);
export const ACTIONS = Object.freeze([...spec.actions]);
export const INITIAL = spec.initial;

/**
 * One step of the rule.
 *
 * An unknown state or event changes nothing and does nothing, so a platform
 * reporting an event this version does not know cannot strand the client.
 *
 * @param {string} state  current state
 * @param {string} event  one of EVENTS
 * @returns {{state: string, action: string}}
 */
export function step(state, event) {
  const row = spec.transitions[state];
  const cell = row && row[event];
  if (!cell) return { state, action: 'none' };
  return { state: cell[0], action: cell[1] };
}

/**
 * Walk a sequence of events from a state, collecting every action taken.
 * What the tests use to name an event order and its outcome in one line.
 *
 * @param {string[]} events
 * @param {string} [from]
 * @returns {{state: string, actions: string[]}}
 */
export function run(events, from = INITIAL) {
  let state = from;
  const actions = [];
  for (const event of events) {
    const next = step(state, event);
    state = next.state;
    actions.push(next.action);
  }
  return { state, actions };
}

/**
 * Map a platform's raw event name onto the rule's event, or null.
 *
 * @param {'desktop'|'ios'} platform
 * @param {string} raw  e.g. 'powerMonitor:resume'
 * @returns {string|null}
 */
export function eventFor(platform, raw) {
  const table = spec.platformEvents[platform];
  if (!table) return null;
  for (const [event, names] of Object.entries(table)) {
    if (names.includes(raw)) return event;
  }
  return null;
}
