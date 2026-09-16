// What the app says about a connection: each gateway's row in Settings, and the
// banner when the active one fails.
//
// A failure changes nothing about where you are. It used to replace the window
// with a dead-end error page, and then with Settings, both of which take the
// screen away from someone who did not ask to leave it. Now it slides a notice
// down from the top with a link to Settings, and the window shows the loading
// screen it was already showing while it tried. Going to Settings is a click,
// and it is the reader's click.
//
// Pure, and platform-free, so every phase and every error code can be exercised
// from one `node --test` run. On desktop, Settings is sandboxed and cannot
// import this, so main.js formats with it and sends the result, the same split
// as build-info and updates. The phase names and the error-code hints are data,
// read from spec/connection.json so a Swift port shares the exact same source of
// truth.

import spec from './spec/connection.json' with { type: 'json' };

export const IDLE = spec.phases.idle; // never attempted this run
export const CONNECTING = spec.phases.connecting;
export const CONNECTED = spec.phases.connected;
export const FAILED = spec.phases.failed;
// Answered, but not accepted: the page loaded and the gateway is holding the
// session until an operator approves this device. Distinct from CONNECTING
// (nothing is known yet) and from CONNECTED (the socket was accepted), because
// the row has to say which of the three is true and a retry must not move it.
export const PENDING = spec.phases.pending;

// -3 is ERR_ABORTED, which fires on ordinary in-app navigation and means
// nothing went wrong.
export const ERR_ABORTED = spec.errAborted;

// Named for the failures that actually happen with a tailnet-only gateway,
// rather than echoing Chromium's error string and leaving the reader to guess.
// The string from Chromium is kept alongside, never instead: it is what someone
// searches for when the hint does not fit their case.
export const HINTS = Object.freeze({ ...spec.hints });

/**
 * What a row says while the gateway is holding this client's approval.
 *
 * Read from the spec rather than written into the branch below, so the two
 * clients word an unapproved device identically, the same reason the phases and
 * the hints live there.
 */
export const PENDING_COPY = Object.freeze({
  label: spec.pendingLabel,
  detail: spec.pendingDetail,
});

/** The sentence to show for a failure, in the reader's terms where possible. */
export function hint({ code, description } = {}) {
  return HINTS[String(code)] || description || 'The gateway did not respond.';
}

/**
 * Both halves of a failure: the sentence for the reader, the code for the
 * search box. Shared by the gateway row and the banner so the two cannot end up
 * describing the same failure differently.
 *
 * The code is appended only when there is a *hint* to append it to. Chromium
 * has far more error strings than the list above, and for one that is not in it
 * `hint()` already falls back to the description, so appending it as well
 * produced "ERR_EMPTY_RESPONSE (ERR_EMPTY_RESPONSE)", which reads as a bug in
 * the app at the moment the reader is trying to diagnose their network.
 */
export function reason(error) {
  if (!error) return hint();
  const sentence = hint(error);
  if (!error.description || sentence === error.description) return sentence;
  return `${sentence} (${error.description})`;
}

/**
 * What the banner says when a connection fails.
 *
 * A failure is a condition rather than an event, it stays true until the gateway
 * comes back or someone changes something, which is the banner's whole shape, so
 * it belongs there rather than in a dialog or a replaced screen.
 *
 * The action is a command name rather than a handler because this crosses IPC
 * to a sandboxed page and back. Naming a command main already knows how to run
 * keeps the renderer unable to ask for anything that was not offered.
 */
export function failureNotice({ label, error = null } = {}) {
  return {
    tone: 'error',
    message: `Cannot connect to ${label || 'the gateway'}`,
    detail: reason(error),
    action: { label: 'Open Settings', command: 'settings' },
  };
}

/**
 * The status line for one gateway row.
 *
 * A certificate waiting for a decision outranks the connection phase, because
 * it is both the cause of the failure and the only one of the two the reader
 * can act on. Saying "cannot connect" over the top of it would be true and
 * useless.
 *
 * @param {object} opts
 * @param {boolean} opts.isActive        the gateway this app is pointed at
 * @param {string} [opts.phase]          IDLE | CONNECTING | CONNECTED | FAILED | PENDING
 * @param {{code: (number|string), description: string}} [opts.error]
 * @param {{changed: boolean}} [opts.certOffer]  refused certificate for this host
 * @returns {{tone: string, label: string, detail: string|null}}
 */
export function status({ isActive, phase = IDLE, error = null, certOffer = null }) {
  if (certOffer) {
    return {
      tone: certOffer.changed ? 'err' : 'warn',
      label: certOffer.changed ? 'Certificate changed' : 'Certificate not trusted',
      detail: certOffer.changed
        ? 'This host is presenting a different certificate than the one that was trusted. Review it above.'
        : 'Review the certificate above to connect to this gateway.',
    };
  }

  if (!isActive) return { tone: 'muted', label: 'Not connected', detail: null };

  // Before CONNECTED, and that ordering is the point: a pending gateway HAS
  // answered (the page loaded), so nothing above this line would catch it, and
  // saying "Connected" here was the bug. The device is unapproved, which is a
  // thing the reader can act on, so this is a warning tone rather than a muted
  // one, and it carries the one line that says what to do about it.
  if (phase === PENDING) {
    return { tone: 'warn', label: PENDING_COPY.label, detail: PENDING_COPY.detail };
  }

  if (phase === CONNECTED) return { tone: 'ok', label: 'Connected', detail: null };
  if (phase === CONNECTING) return { tone: 'muted', label: 'Connecting...', detail: null };
  if (phase === FAILED) {
    // The row says the state and nothing else. Why it failed is one sentence,
    // and it belongs in the banner, which is up whenever this row is red and is
    // the one place carrying the action that answers it. Printed in both, it
    // read as two problems, and the copy in the row was the one with no way out
    // of it: a row cannot be dismissed and cannot offer Open Settings.
    return { tone: 'err', label: 'Cannot connect', detail: null };
  }
  return { tone: 'muted', label: 'Not connected', detail: null };
}

/**
 * Whether a finished load means the gateway actually answered.
 *
 * It is not enough that a load finished, and the reason is nasty: after a main
 * frame fails, Chromium commits an error document *for the same URL* and that
 * commit fires `did-finish-load` too. Taken at face value, every failed connect
 * marked itself connected a few milliseconds after it failed, the row went
 * green, the heading went back to "Settings", and the only trace of the failure
 * was the certificate warning that happened to survive on its own.
 *
 * So the phase is the guard. `loadActiveGateway` sets CONNECTING before every
 * attempt and `did-fail-load` sets FAILED, so an error-page commit arrives with
 * the phase already off CONNECTING and is ignored. A `file:` URL is one of the
 * app's own pages and never means a gateway answered.
 */
export function shouldMarkConnected({ phase, url }) {
  if (typeof url === 'string' && url.startsWith('file:')) return false;
  return phase === CONNECTING;
}

/**
 * Whether a `did-fail-load` is worth reacting to at all.
 *
 * A subframe that fails leaves the app perfectly usable, and ERR_ABORTED fires
 * on ordinary navigation, reacting to either would throw the user back to
 * Settings from a working session, which is far worse than the failure.
 */
export function isRealFailure({ code, isMainFrame }) {
  return Boolean(isMainFrame) && code !== ERR_ABORTED;
}

/**
 * The next phase, given the phase now and what just happened.
 *
 * A tiny reducer rather than a scatter of assignments at each call site, so the
 * five states and the moves between them are one thing a client reads and a test
 * drives, exactly as core/pairing.js's is. A client without a port of this
 * (nothing needs to re-derive the rules, only the answer) reads the phase it is
 * told, so a spread of `phase = FAILED` in a client is how the two ends drift.
 *
 * Events:
 *  - `connect`    an attempt was started: a load, a reload, a retry.
 *  - `connected`  the page loaded and answered. NOT the same as accepted: an
 *                 unapproved device is served the page and then has its socket
 *                 closed, which is why this holds `pending` rather than clearing
 *                 it. See core/pairing.js.
 *  - `confirm`    the socket survived the pairing settle window, so the device
 *                 IS approved and this is a genuine connect.
 *  - `failed`     the load itself failed, or the gateway closed the session for
 *                 a reason that is not pairing.
 *  - `pending`    the client learned the gateway is holding its approval.
 *
 * `connect` and `connected` from `pending` HOLD it, and both are anti-flicker
 * rules of the same shape as the ones core/pairing.js carries. While a device is
 * awaiting approval the client reissues the connect every few seconds to pick up
 * the approval, and each attempt moves this state twice: a `connect` when it
 * starts and a `connected` when the page loads. Surfacing either one pulled the
 * visible phase off `pending` and put it back a moment later, so the settings
 * row flickered once per retry. The device is still unapproved until the socket
 * proves otherwise, so the honest answer through a retry is the state it was
 * already showing, and the attempt happens underneath it.
 *
 * @param {string} phase   current phase
 * @param {{type: string}} event
 * @returns {string} the next phase
 */
export function nextPhase(phase, event) {
  switch (event?.type) {
    case 'pending':
      return PENDING;
    case 'connect':
      return phase === PENDING ? PENDING : CONNECTING;
    case 'connected':
      return phase === PENDING ? PENDING : CONNECTED;
    case 'confirm':
      return phase === PENDING ? CONNECTED : phase;
    case 'failed':
      return FAILED;
    default:
      return phase;
  }
}
