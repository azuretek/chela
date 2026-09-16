// Device pairing on the desktop: the half the shared contract does not own.
//
// The gateway holds a second gate after the token check. A client can pass auth
// and still be refused, because the gateway does not pair a new device on sight:
// an operator has to approve it. The refusal is a WebSocket close with the policy
// code 1008 and a reason of the shape `pairing required: <requirement>
// (requestId: <id>)`.
//
// The page opens that socket, not this process, so the refusal is an event
// INSIDE the gateway page rather than a navigation failure: the HTML loaded
// fine, so `did-finish-load` fires and this app believes it connected. The one
// way to see the refusal is to watch the page's own WebSocket, which is what the
// observer in core/spec/pairing.json does; the iOS client installs those same
// bytes through a WKUserScript and reads the report in a message handler.
//
// **This module exists because the desktop never did that, and the gap has a
// specific shape.** The desktop's only reactions to trouble were a navigation
// failure (`did-fail-load`) and a renderer death, so a pairing refusal reached no
// native surface at all and the app sat on a dead page with no explanation. The
// screen was visible on a FIRST connect only because the Control UI renders its
// own gate when it boots into a refused handshake; a device that was working and
// then had its approval revoked server-side (the gateway closes the established
// socket `4001 device removed`, and the next connects are refused 1008) got
// nothing, which is the failure this fixes.
//
// Three parts, and none of them is a second copy of the contract:
//
//   - `injectedSources()` is what goes into the page at document start: a small
//     transport, then the observer bytes read from the shared spec. The transport
//     exists because the observer's two reporting routes are a host message
//     handler (which Electron does not have) and a global it falls back to
//     (`OBSERVER_GLOBAL`). Defining that global as a live channel is the desktop's
//     half, the same way `PairingBridge.swift` is the phone's, and it keeps the
//     observer itself unported, one copy in the tree.
//   - `parseReport()` narrows an untrusted payload to the contract: a kind the
//     spec names, a reason the spec knows, an id that passes the spec's pattern.
//     A payload that is not one of those is dropped rather than guessed at.
//   - `createState()` is the desktop's state machine, mirroring the phone's
//     `PairingState`: the phase, the settle window, and the reload cadence while
//     pairing. The phase moves come from the shared reducer in core/pairing.js,
//     and the two durations come from the shared spec, so tuning either does not
//     need a second edit here or there.

import {
  AUTHENTICATED,
  CONNECTING,
  CONFIRM_SECONDS,
  FAILED,
  OBSERVER_GLOBAL,
  PAIRING_REASONS,
  PAIRING_REQUIRED,
  RETRY_SECONDS,
  approveCommand,
  nextPhase,
  pairingRoute,
  observerScript,
  readRequestId,
  requirement,
} from '../../core/pairing.js';

/** The reason key a payload naming something unknown is narrowed to. */
const FALLBACK_REASON = 'not-paired';

/**
 * The transport the observer's report crosses on, as one script.
 *
 * The observer posts to a host message handler when the engine has one and
 * otherwise assigns its payload to `OBSERVER_GLOBAL`. Electron has no
 * `window.webkit.messageHandlers`, so this defines that global as a pair of
 * accessors: the assignment the observer already makes becomes a call into the
 * preload's bridge (`__clawPairingReport`, see src/preload.cjs), which carries it
 * to this process over IPC.
 *
 * A payload is stringified here rather than handed over as an object, because a
 * contextBridge function only takes serializable values and a string is the one
 * shape both sides agree on. Nothing is parsed or trusted here; `parseReport`
 * does that in the main process, where the contract lives.
 *
 * Fail-soft: with no bridge (a page loaded outside this app) the property is left
 * alone, the observer's own assignment lands on a plain global, and nothing else
 * changes.
 */
export function transportPrelude() {
  return `(function () {
  if (window.__clawDesktopPairingTransport) return;
  var post = window.__clawPairingReport;
  if (typeof post !== 'function') return;
  window.__clawDesktopPairingTransport = true;
  try {
    Object.defineProperty(window, '${OBSERVER_GLOBAL}', {
      configurable: true,
      get: function () { return undefined; },
      set: function (payload) { try { post(JSON.stringify(payload)); } catch (error) {} }
    });
  } catch (error) {}
})();`;
}

/**
 * What goes into the gateway page at document start, in the order it must run.
 *
 * The injector is src/preload.cjs, which reads this over the synchronous
 * `pairing:script` channel and evaluates each source in the page's main world; a
 * preload is the only surface already running before the page has a document, so
 * it is the only reliable document-start hook this app has. Main serves the
 * bytes and never touches the page itself (see the device-pairing section of
 * src/main.js for the CDP route that was tried first and measured not to work).
 *
 * An array rather than one blob so the observer half is asserted byte for byte
 * against the spec, which is the property that keeps the two clients running one
 * script instead of two that agree by convention. The transport has to be in
 * place first: the observer only posts on a socket event, but a report that
 * arrived before the channel existed would land in a plain global and be lost.
 */
export function injectedSources() {
  return [transportPrelude(), observerScript()];
}

/**
 * Read an observer report into something the app acts on, or null.
 *
 * The payload crosses a page boundary, so every field is read defensively and
 * the one thing that decides what counts as pairing stays the shared contract:
 * the reason is narrowed to a key the spec knows (an unknown one falls back to
 * the general case rather than showing a typo), and the id is re-checked against
 * the spec's pattern, so a malformed id becomes the `--latest` command rather
 * than arbitrary text on a screen.
 *
 * @param {unknown} payload the report as it arrived (a JSON string, or an object)
 * @returns {{kind: 'open'}|{kind: 'close', refusal: {reason: string, requestId: (string|null)}}|null}
 */
export function parseReport(payload) {
  let body = payload;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object') return null;

  if (body.kind === AUTHENTICATED) return { kind: 'open' };
  if (body.kind !== PAIRING_REQUIRED) return null;

  const named = typeof body.reason === 'string' && PAIRING_REASONS.includes(body.reason) ? body.reason : null;
  const requestId = typeof body.requestId === 'string' ? readRequestId(`(requestId: ${body.requestId})`) : null;
  return { kind: 'close', refusal: { reason: named || FALLBACK_REASON, requestId } };
}

/**
 * The desktop's pairing state: the visible phase, the refusal behind it, and the
 * two timers that make the screen honest.
 *
 * The moves are the shared reducer's, so "a 1008 pairing close enters the
 * pairing state from ANY phase" is one rule for both clients rather than a
 * behaviour each of them reimplements. This object adds only what a client has
 * to add: a reload cadence while the screen is up, and a settle window between a
 * socket opening and believing it.
 *
 *   - A RETRY BEAT asks the host for a fresh connect attempt. The page's own
 *     socket retry cannot be relied on (observed against the live gateway: the
 *     Control UI stopped reattaching a few seconds after the refusal), so the
 *     native layer drives it, exactly as the phone does. The reload re-runs the
 *     page's OWN connect rather than reimplementing one.
 *   - An OPEN while pairing is UNCONFIRMED, and this is the anti-flicker rule
 *     from the shared contract: a 1008 close is only deliverable after a
 *     handshake, so the gateway opens the socket and then closes it 1008 on every
 *     retry. Believing that open would tear the screen away for the gap between
 *     the two, once per retry. So it holds, and only an open that survives the
 *     settle window with no pairing close (a `confirm`) is the approval.
 *   - `closed()` cancels the settle window before it moves the phase, so a
 *     refusal that follows an open can never let a confirm race in behind it.
 *
 * The timers are injected so a test can drive them with no clock, and the
 * durations come from the shared spec so both clients keep one cadence.
 *
 * `onChange` fires after EVERY phase move, including the one the settle window
 * makes on its own. That last one is not tidiness: the confirm that clears the
 * screen happens in a timer with no other caller, so a client that only repaints
 * on a page report leaves the pairing screen up over a session that is working.
 * Measured live: the device was approved, the socket stayed open, the gateway
 * served the Control UI, and the screen sat over it until the app was restarted.
 *
 * @param {object} [deps]
 * @param {(fn: () => void, ms: number) => any} [deps.schedule]
 * @param {(handle: any) => void} [deps.cancel]
 * @param {() => void} [deps.onRetry] one reload attempt, called per beat while pairing
 * @param {() => void} [deps.onChange] the phase moved; repaint whatever shows it
 */
export function createState({ schedule = setTimeout, cancel = clearTimeout, onRetry = () => {}, onChange = () => {} } = {}) {
  let phase = CONNECTING;
  let refusal = null;
  let retryHandle = null;
  let settleHandle = null;
  // The phase the CURRENT stay in pairing-required was entered from, kept so the
  // entry can be routed (core/pairing.js's pairingRoute). A first connection and
  // a session that was working and had its approval revoked are the same close
  // and want different surfaces, and the difference is only knowable at the move
  // that entered the state, so it is recorded there rather than guessed here.
  let enteredFrom = CONNECTING;

  function move(next) {
    // Recorded only on an ENTRY into pairing-required. Re-entering from
    // pairing-required (a retry, or a repeat close) must not overwrite the
    // phase the wait actually started from, or a revocation would start
    // reporting itself as a first connection a few seconds in.
    if (next === PAIRING_REQUIRED && phase !== PAIRING_REQUIRED) enteredFrom = phase;
    phase = next;
    return next;
  }

  function stopRetry() {
    if (retryHandle !== null) {
      cancel(retryHandle);
      retryHandle = null;
    }
  }

  function stopSettle() {
    if (settleHandle !== null) {
      cancel(settleHandle);
      settleHandle = null;
    }
  }

  // Recursive `schedule` rather than an interval, so one injected timer is enough
  // to drive the whole thing in a test with no real clock in the room.
  function startRetry() {
    if (retryHandle !== null) return;
    const beat = () => {
      retryHandle = null;
      if (phase !== PAIRING_REQUIRED) return;
      onRetry();
      startRetry();
    };
    retryHandle = schedule(beat, RETRY_SECONDS * 1000);
  }

  function startSettle() {
    stopSettle();
    settleHandle = schedule(() => {
      settleHandle = null;
      // Guarded on the phase rather than on the handle: a late beat after some
      // other move must do nothing at all.
      if (phase !== PAIRING_REQUIRED) return;
      move(nextPhase(phase, { type: 'confirm' }));
      refusal = null;
      stopRetry();
      // The screen comes down here or nowhere: this is the recovery, and it has
      // no other caller to repaint for it.
      onChange();
    }, CONFIRM_SECONDS * 1000);
  }

  return {
    /** A connect attempt is starting. Two cases, and the shared reducer decides. */
    connecting() {
      const next = move(nextPhase(phase, { type: 'connect' }));
      // A first connect invalidates any earlier refusal and stops the cadence:
      // a fresh load is in flight. A retry from the pairing screen HOLDS both,
      // because the device is still unapproved and the command on screen must
      // not change; the attempt happens underneath the screen.
      if (next !== PAIRING_REQUIRED) {
        refusal = null;
        stopRetry();
      }
      onChange();
    },

    /** The gateway socket opened: confirmed only if it survives the settle window. */
    opened() {
      const next = move(nextPhase(phase, { type: 'open' }));
      if (next === PAIRING_REQUIRED) {
        startSettle();
      } else {
        refusal = null;
        stopRetry();
        stopSettle();
      }
      onChange();
    },

    /** The socket closed; `refusal` is the result of readPairingClose. */
    closed(pairing) {
      stopSettle();
      move(nextPhase(phase, { type: 'close', pairing }));
      refusal = pairing;
      if (phase === PAIRING_REQUIRED) startRetry();
      else stopRetry();
      onChange();
    },

    /** The load itself failed (host unreachable, page did not load). */
    failed() {
      move(nextPhase(phase, { type: 'fail' }));
      refusal = null;
      stopRetry();
      stopSettle();
      onChange();
    },

    /** Whether the pairing screen should be up. */
    isPairing() {
      return phase === PAIRING_REQUIRED;
    },

    /** Everything a screen or a log line needs, as one value. */
    snapshot() {
      return {
        phase,
        refusal: refusal ? { ...refusal } : null,
        pairing: phase === PAIRING_REQUIRED,
        reason: refusal ? refusal.reason : null,
        requestId: refusal ? refusal.requestId : null,
        requirement: refusal ? requirement(refusal.reason) : requirement(FALLBACK_REASON),
        command: approveCommand(refusal ? refusal.requestId : null),
        // Where this entry should send the reader, from the shared rule: the
        // pairing screen for a first connection, the settings surface for a
        // session that was working and has had its approval revoked. Null
        // whenever this is not a pairing state at all.
        route: pairingRoute({ fromPhase: enteredFrom, toPhase: phase }),
        enteredFrom,
      };
    },

    /** For a test: the live phase, without building a snapshot. */
    get phase() {
      return phase;
    },
  };
}

/** The phase names this module reasons about, re-exported for its consumers. */
export { AUTHENTICATED, CONNECTING, FAILED, PAIRING_REQUIRED };
