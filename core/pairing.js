// Device pairing: the second gate the gateway holds after the token check.
//
// A client can pass gateway auth and still be refused, because the gateway does
// not pair a new device on sight: an operator has to approve it. The refusal is
// a WebSocket close with the policy code 1008 and a reason of the shape
// `pairing required: <requirement> (requestId: <id>)`. This module is the shared
// contract for reading that close, keeping it apart from an auth failure and a
// network drop, and describing what a client should show and how it recovers.
//
// Pure and platform-free, so every phase and every close reason is exercised
// from one `node --test` run. The phase names, the policy code, the reason
// substrings, the requestId shape and the copy are data, read from
// spec/pairing.json so a Swift port and a later Android one share the exact same
// source of truth. The injected observer script is data there too, one copy for
// both engines, for the same reason prompt-metadata's hook is: a page cannot
// import a module, and two copies of a script fork the moment one is edited.
//
// Consumers: mobile/Claw/PairingState.swift ports these rules and proves itself
// against core/fixtures/pairing.json; the mobile web view installs the observer
// through a WKUserScript. The desktop can read this module directly if it grows
// a native socket, but today its web contents host the same page, which reports
// through the same observer.

import spec from './spec/pairing.json' with { type: 'json' };

/** The connection phases every client names the same way. */
export const CONNECTING = spec.phases.connecting;
export const PAIRING_REQUIRED = spec.phases.pairingRequired;
export const AUTHENTICATED = spec.phases.authenticated;
export const FAILED = spec.phases.failed;

/** The WebSocket close code the gateway uses for a policy refusal. */
export const POLICY_CLOSE_CODE = spec.policyCloseCode;

/** The pairing reasons, in the order the parser tries them. */
export const PAIRING_REASONS = Object.freeze(Object.keys(spec.reasonSubstrings));

const REQUEST_ID_PATTERN = new RegExp(spec.requestIdPattern);
const REQUEST_ID_IN_REASON = new RegExp(spec.requestIdInReason, 'i');

/** The plain-language copy a pairing screen shows, read from the spec. */
export const COPY = Object.freeze({ ...spec.copy });

/** The one-line requirement for each pairing reason. */
export const REQUIREMENTS = Object.freeze({ ...spec.requirements });

/**
 * Pull a requestId out of a close reason, or null.
 *
 * Held to the spec's id pattern, so a malformed reason cannot inject arbitrary
 * text into a screen the way an unchecked capture would. The pattern and the
 * `(requestId: <id>)` shape mirror the gateway's own contract, so the two agree
 * by construction.
 */
export function readRequestId(reason) {
  if (typeof reason !== 'string') return null;
  const match = reason.match(REQUEST_ID_IN_REASON);
  const candidate = match?.[1];
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Read a WebSocket close into a pairing state, or null when it is not pairing.
 *
 * The two guards are both load-bearing and both are why this is not "any 1008 is
 * pairing": 1008 is a general policy code, so a close is pairing only when the
 * code is 1008 AND the reason carries one of the pairing substrings. A 1008 with
 * some other reason, and a close on any other code, are left for the caller to
 * treat as an ordinary failure, which is a different state with different copy.
 *
 * The reason match is case-insensitive and substring-based, the same way the
 * gateway's reader matches, so the exact requirement text after the prefix does
 * not have to be reproduced here.
 *
 * @param {{code: (number|null|undefined), reason: (string|null|undefined)}} close
 * @returns {{reason: string, requestId: (string|null)}|null}
 */
export function readPairingClose({ code, reason } = {}) {
  if (code !== POLICY_CLOSE_CODE) return null;
  const text = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (!text) return null;
  // Tried in spec order: the upgrade phrasings first, then the general
  // `pairing required`, so a "role upgrade pending approval" is not swallowed by
  // a broader match. The spec's key order is the tried order.
  let matched = null;
  for (const key of PAIRING_REASONS) {
    if (text.includes(spec.reasonSubstrings[key])) {
      matched = key;
      break;
    }
  }
  if (!matched) return null;
  return { reason: matched, requestId: readRequestId(reason) };
}

/**
 * The next phase, given the phase now and what just happened.
 *
 * A tiny reducer rather than a scatter of flags, so the four states and the
 * moves between them are one thing a client reads and a test drives. Both
 * clients (and a later Android one) share it, so "pairing clears the moment the
 * socket opens" is one rule rather than one per platform.
 *
 * Events:
 *  - `connect`  a load/connect was started; nothing is known yet.
 *  - `open`     the gateway socket opened; the device is approved and connected.
 *  - `close`    the socket closed; `pairing` is the result of readPairingClose.
 *  - `fail`     the load itself failed (host unreachable, page did not load).
 *
 * `open` always wins: an approval that lands while the pairing screen is up must
 * move straight to authenticated, which is the whole point of auto-recovery. A
 * `close` that is not pairing is an ordinary failure, kept distinct so its copy
 * (raised elsewhere) is the network/auth one and never the pairing one.
 *
 * @param {string} phase   current phase
 * @param {{type: string, pairing?: ({reason: string, requestId: (string|null)}|null)}} event
 * @returns {string} the next phase
 */
export function nextPhase(phase, event) {
  switch (event?.type) {
    case 'connect':
      return CONNECTING;
    case 'open':
      return AUTHENTICATED;
    case 'close':
      return event.pairing ? PAIRING_REQUIRED : FAILED;
    case 'fail':
      return FAILED;
    default:
      return phase;
  }
}

/**
 * The approve command to show, built from the requestId.
 *
 * With an id, the exact command the operator runs; without one, the `--latest`
 * form that previews the newest pending request and prints the exact command.
 * This is the real instruction the gateway and the Control UI give, reflected
 * rather than invented, and the client shows it for the operator to run on the
 * gateway host, not to run itself.
 */
export function approveCommand(requestId) {
  const id = typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
  return id ? spec.copy.commandWithId.replace('{requestId}', id) : spec.copy.commandNoId;
}

/**
 * The requirement sentence for a pairing reason, with a safe default.
 */
export function requirement(reason) {
  return REQUIREMENTS[reason] || REQUIREMENTS['not-paired'];
}

/** The injected observer script, exactly as the spec holds it. One copy, two engines. */
export function observerScript() {
  return spec.hook.join('\n');
}

/** The global the observer falls back to, and the message-handler name it prefers. */
export const OBSERVER_GLOBAL = spec.global;
export const OBSERVER_MESSAGE_NAME = spec.messageName;
