// Connect pressed on the Control UI's own login gate, and the loading cover that
// answers both that press and the gate's own presence.
//
// The gate is upstream's page and is not patched: a script installed at document
// start (spec.hook) reports the press, the gate leaving, the gate's failure coming
// back and -- because the reader should never see that screen at all -- the gate's
// arrival and departure. This module turns those reports into the cover. See
// core/spec/login-gate-connect.json for why each part is shaped as it is, and
// core/ui/CONVENTIONS.md for the rules it serves: the loading screen goes up rather
// than the gate, comes down only once the interface has rendered, and a connect
// that does not answer lands on the failed state with Try again on a bounded
// deadline.
//
// Every client uses this: the desktop installs LOGIN_GATE_CONNECT_SCRIPT beside
// the pairing observer, and the iOS client bundles the spec and runs the same
// bytes (mobile/Chela/LoginGateConnect.swift).

import spec from './spec/login-gate-connect.json' with { type: 'json' };

/** The injected script, joined from the spec's lines. */
export const LOGIN_GATE_CONNECT_SCRIPT = spec.hook.join('\n');

/** The report kinds the script posts. */
export const GATE_REPORTS = Object.freeze({ ...spec.reports });

/** How long a press may go unanswered before the cover lands on its failed state. */
export const CONNECT_DEADLINE_MS = spec.deadlineMs;

/** How long the cover is held over a page that is on its own gate before it fails. */
export const GATE_HOLD_MS = spec.gateMs;

/**
 * Read a report from the page into a gate event, or null.
 *
 * The payload crosses a page boundary, so only the kinds the spec names are
 * accepted, and the one free-text field is narrowed to a short string.
 *
 * @param {unknown} body a parsed report
 * @returns {{event: 'pressed'|'rendered'|'failed'|'gateShown'|'gateGone'|'pageReady', title: string}|null}
 */
export function readGateReport(body) {
  if (!body || typeof body !== 'object') return null;
  const event = Object.keys(GATE_REPORTS).find((key) => GATE_REPORTS[key] === body.kind);
  if (!event) return null;
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { event, title };
}

/**
 * The host's half: one cover, and the endings that may take it down.
 *
 * Two things raise it: the press on the gate's own Connect, and the gate itself
 * appearing. One thing lifts it: an answer -- the interface rendered, a failure the
 * page reports, or, for a gate the reader was never shown, that gate going away.
 * Both are bounded, the press at deadlineMs and the gate at gateMs, so neither can
 * leave a cover that never lets go (core/ui/CONVENTIONS.md).
 *
 * A press while the gate is up is the gate's own Connect, and takes the cover over
 * from it: a press while one is already in flight is the same attempt, and cancel()
 * drops the press for a load of the client's own that supersedes it.
 *
 * `pageReady` is the RESET rather than an ending: a gate reported by one document
 * says nothing about the next, so a document beginning is what forgets it. Without
 * that, a gate that was up when a new page began would keep the cover down over a
 * page that is connecting normally.
 *
 * Clock-free, so every timing is exercised from one test run.
 *
 * @param {{cover: () => void, lift: (why: string) => void, fail: (why: string, title: string) => void,
 *   deadlineMs?: number, gateMs?: number, setTimer?: Function, clearTimer?: Function}} deps
 */
export function createLoginGateCover({ cover, lift, fail, deadlineMs = CONNECT_DEADLINE_MS, gateMs = GATE_HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pressTimer = null;
  let gateTimer = null;
  let active = false;
  let onGate = false;
  const forgetGate = () => {
    if (gateTimer !== null) clearTimer(gateTimer);
    gateTimer = null;
    onGate = false;
  };
  const endPress = () => {
    if (pressTimer !== null) clearTimer(pressTimer);
    pressTimer = null;
    const was = active;
    active = false;
    return was;
  };
  return {
    report(report) {
      if (!report) return;
      if (report.event === 'pageReady') { forgetGate(); return; }
      if (report.event === 'gateShown') {
        if (onGate) return;
        onGate = true;
        if (active) return; // the press owns the cover, and has its own deadline
        cover();
        gateTimer = setTimer(() => {
          gateTimer = null;
          if (!onGate || active) return;
          onGate = false;
          fail('gate', report.title || '');
        }, gateMs);
        return;
      }
      if (report.event === 'gateGone') {
        if (!onGate) return;
        const wasPressed = active;
        forgetGate();
        if (wasPressed) return; // the press's own answer ends it
        lift('gate-gone');
        return;
      }
      if (report.event === 'pressed') {
        if (active) return;
        forgetGate();
        active = true;
        cover();
        pressTimer = setTimer(() => { pressTimer = null; if (endPress()) fail('deadline', ''); }, deadlineMs);
        return;
      }
      if (!active) return;
      if (report.event === 'rendered') { forgetGate(); endPress(); lift('rendered'); return; }
      if (report.event === 'failed') { forgetGate(); endPress(); fail('refused', report.title || ''); }
    },
    cancel() { endPress(); forgetGate(); },
    get active() { return active; },
    get onGate() { return onGate; },
  };
}

