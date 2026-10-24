// Native lifecycle signals preserve a surviving document. The Control UI owns
// transport health, reconnect, history resync and outbox reconciliation.
// Sleep and offline transitions never discard or cover the conversation.

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
