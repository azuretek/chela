// One screenshot, taken the way the harnesses need it: retried when the
// compositor's copy fails, and bounded by a clock when it never answers.
//
// Two failures, both of a shot rather than of the page:
//
//   * A copy that FAILS. In the Electron this repo pins (44), `capturePage()` rejects
//     when Chromium's CopyFromSurface comes back with an error, naming it
//     ("UnknownVizError", "Frame Gone", "Timeout", ...; the strings are
//     CopyFromSurfaceErrorToString in shell/browser/api/electron_api_web_contents.cc).
//     On a window that was never shown, the first capture is the one that marks the
//     page visible (IncrementCapturerCount) and it issues the copy in the same task,
//     with no delay, so the copy can reach viz before the surface it asks for is
//     there. That is what took the whole `npm run measure` step down on CI, at the
//     FIRST capture of capture-pages.js, twice on 2026-10-02 (on 5ef5924 and on
//     #125's d8b67b7), with no other change in between and every later capture fine.
//     A failed copy is transient: the page is now visible, so a fresh frame is
//     asked for and the copy is made again.
//   * A copy that never answers, which dump-overlays.js measured on a window with no
//     display surface. A clock bounds each attempt, and that one is not retried:
//     it means there is no surface, and waiting again would only spend the watchdog.
//
// Every failed attempt is logged, so a retry is never silent.

/** The messages Electron rejects a failed copy with: a shot worth trying again. */
export const COPY_ERRORS = Object.freeze([
  'Unknown', 'Not implemented', 'Frame Gone', 'Timeout',
  'EmbeddingTokenChanged', 'VizSentEmptyBitmap', 'UnknownVizError',
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when an error is a failed compositor copy rather than anything else. */
export function isCopyError(err) {
  return Boolean(err) && COPY_ERRORS.includes(err.message);
}

/**
 * `wc.capturePage(rect)`, retried on a failed copy and bounded per attempt.
 *
 * @param {{ capturePage: Function, invalidate?: Function }} wc a WebContents or BrowserWindow
 * @param {{ rect?: object, attempts?: number, timeoutMs?: number, settleMs?: number, label?: string, log?: Function }} [options]
 */
export async function capturePage(wc, options = {}) {
  const { rect, attempts = 3, timeoutMs = 4000, settleMs = 250, label = 'capture', log = console.log } = options;
  for (let attempt = 1; ; attempt += 1) {
    let timer;
    try {
      return await Promise.race([
        rect ? wc.capturePage(rect) : wc.capturePage(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no shot within ' + timeoutMs + 'ms')), timeoutMs); }),
      ]);
    } catch (err) {
      if (!isCopyError(err) || attempt >= attempts) throw err;
      log('     ' + label + ': capture attempt ' + attempt + ' failed (' + err.message + '), retrying');
      // Ask for a fresh frame rather than copying the one that just failed.
      if (typeof wc.invalidate === 'function') wc.invalidate();
      await delay(settleMs);
    } finally {
      clearTimeout(timer);
    }
  }
}
