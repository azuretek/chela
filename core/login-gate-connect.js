// Connect pressed on the Control UI's own login gate, and the loading cover that
// answers it.
//
// The gate is upstream's page and is not patched: a script installed at document
// start (spec.hook) listens for the press and reports three things over the
// pairing observer's channel, and this module turns those reports into the cover.
// See core/spec/login-gate-connect.json for why each part is shaped as it is, and
// core/ui/CONVENTIONS.md for the rules it serves: the loading screen goes up on the
// press, comes down only once the interface has rendered, and a connect that does
// not answer lands on the failed state with Try again on a bounded deadline.
//
// Every client uses this: the desktop installs LOGIN_GATE_CONNECT_SCRIPT beside
// the pairing observer, and the iOS client bundles the spec and runs the same
// bytes (mobile/Chela/LoginGateConnect.swift).

import spec from './spec/login-gate-connect.json' with { type: 'json' };

/** The injected script, joined from the spec's lines. */
export const LOGIN_GATE_CONNECT_SCRIPT = spec.hook.join('\n');

/** The report kinds the script posts. */
export const CONNECT_REPORTS = Object.freeze({ ...spec.reports });

/** How long a press may go unanswered before the cover lands on its failed state. */
export const CONNECT_DEADLINE_MS = spec.deadlineMs;

/**
 * Read a report from the page into a connect event, or null.
 *
 * The payload crosses a page boundary, so only the three kinds the spec names
 * are accepted, and the one free-text field is narrowed to a short string.
 *
 * @param {unknown} body a parsed report
 * @returns {{event: 'pressed'|'rendered'|'failed', title: string}|null}
 */
export function readConnectReport(body) {
  if (!body || typeof body !== 'object') return null;
  const event = Object.keys(CONNECT_REPORTS).find((key) => CONNECT_REPORTS[key] === body.kind);
  if (!event) return null;
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { event, title };
}

/**
 * The host's half: one press, one cover, one ending.
 *
 * cover() runs on the press. Exactly one of lift('rendered') or fail(reason)
 * follows: the interface rendered, the page reported a failure, or the deadline
 * passed. A report with no press in flight is ignored, a second press while one
 * is in flight is the same attempt, and cancel() drops the press without either
 * ending, for a load of the client's own that supersedes it.
 *
 * Clock-free, so every timing is exercised from one test run.
 *
 * @param {{cover: () => void, lift: (why: string) => void, fail: (why: string, title: string) => void,
 *   deadlineMs?: number, setTimer?: Function, clearTimer?: Function}} deps
 */
export function createConnectPress({ cover, lift, fail, deadlineMs = CONNECT_DEADLINE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let active = false;
  const end = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const was = active;
    active = false;
    return was;
  };
  return {
    report(report) {
      if (!report) return;
      if (report.event === 'pressed') {
        if (active) return;
        active = true;
        cover();
        timer = setTimer(() => { timer = null; if (end()) fail('deadline', ''); }, deadlineMs);
        return;
      }
      if (!active) return;
      if (report.event === 'rendered') { end(); lift('rendered'); return; }
      if (report.event === 'failed') { end(); fail('refused', report.title || ''); }
    },
    cancel() { end(); },
    get active() { return active; },
  };
}
