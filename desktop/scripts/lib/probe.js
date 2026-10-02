// One in-page probe, taken the way the harnesses need it: bounded by a clock, and
// naming what the page was doing when it never answered.
//
// `webContents.executeJavaScript` is not bounded on its own. In the Electron this
// repo pins (44), it first awaits `waitTillCanExecuteJavaScript`, which waits for the
// main frame to STOP LOADING (`lib/browser/api/web-contents.ts`) with no clock of its
// own. A frame that never reaches `did-stop-loading` (one load-blocking subresource
// the server never answers is enough) therefore holds the call forever, and a harness
// whose own bound sits BETWEEN samples (`until(..., ms)`) never reaches it: the first
// sample never returns. That is how `login-gate-cover-gate` sat to its 120s watchdog
// on main's 58f314a with no `OK`, no `FAIL`, and not a word about the page.
//
// So `evaluate` bounds the CALL, and when the clock trips it reads the flag Electron
// is itself waiting on (`isLoadingMainFrame()`) and the URL, logs one line naming
// them, and rejects with that state. The next occurrence says what never finished.

/** Millis a probe may take before it is read as a page that is still loading. A page
 *  that has stopped loading answers in single-digit milliseconds, so anything near
 *  this is already a page that is not going to answer. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * The state of a page a probe could not get an answer out of: the flag Electron's
 * `waitTillCanExecuteJavaScript` is waiting on, and the URL it is waiting on it in.
 * Read defensively, because a view can be missing or destroyed under us.
 *
 * @param {{ getURL?: Function, isLoadingMainFrame?: Function } | null} wc
 */
export function loadingState(wc) {
  if (!wc) return { url: '(no view)', isLoadingMainFrame: null };
  try {
    return {
      url: typeof wc.getURL === 'function' ? wc.getURL() : '(no url)',
      isLoadingMainFrame: typeof wc.isLoadingMainFrame === 'function' ? wc.isLoadingMainFrame() : null,
    };
  } catch {
    return { url: '(destroyed)', isLoadingMainFrame: null };
  }
}

/** Thrown when a probe does not answer inside its clock. Carries the page state, so
 *  a caller that wants to report it rather than the message alone has it. */
export class PageStillLoading extends Error {
  constructor({ url, isLoadingMainFrame, timeoutMs, label }) {
    super(`${label}: no answer within ${timeoutMs}ms (isLoadingMainFrame=${isLoadingMainFrame}, url=${url})`);
    this.name = 'PageStillLoading';
    this.url = url;
    this.isLoadingMainFrame = isLoadingMainFrame;
    this.timeoutMs = timeoutMs;
    this.label = label;
  }
}

/**
 * `wc.executeJavaScript(script, userGesture)`, bounded by a clock.
 *
 * @param {{ executeJavaScript: Function, getURL?: Function, isLoadingMainFrame?: Function }} wc a webContents
 * @param {string} script
 * @param {{ userGesture?: boolean, timeoutMs?: number, label?: string, log?: Function }} [options]
 * @returns {Promise<unknown>} the script's value, or rejects with PageStillLoading
 */
export async function evaluate(wc, script, options = {}) {
  const { userGesture = true, timeoutMs = PROBE_TIMEOUT_MS, label = 'the page', log = console.log } = options;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(wc.executeJavaScript(script, userGesture)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new PageStillLoading({ ...loadingState(wc), timeoutMs, label });
          log('FAIL ' + error.message);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
