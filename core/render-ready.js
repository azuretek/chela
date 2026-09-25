// Whether a loaded page has PAINTED, and the gate that holds a cover until it has.
//
// A load that finished is not a page on screen. The Control UI is a single-page
// app: `did-finish-load` (WKWebView's `didFinish`) fires once the document and
// its scripts are in, and the app then builds its interface, so a cover taken
// down on that event shows the reader an empty window until the first paint.
// Reported 2026-09-24 as a blank frame between Try again and the page.
//
// So the cover waits for the page's FIRST CONTENTFUL PAINT, the browser's own
// record that text, an image or an SVG reached the screen, and then two more
// animation frames, so the frame that carries it has been presented rather than
// merely produced. Nothing here knows the Control UI: any page that draws
// anything passes, and a page that draws nothing is held by the backstop.
//
// Every client uses this: the desktop runs RENDERED_PROBE in the gateway view,
// and the iOS client ships the same source as a bundled resource.

/** How long a cover is held for a page that never reports a paint. A backstop,
 *  never the path that fires: a view the OS treats as hidden may not paint until
 *  it is shown, and a cover that never lifts is worse than one frame of blank. */
export const RENDER_BACKSTOP_MS = 4000;

/** Evaluates to a Promise that resolves once the page has painted content and
 *  that frame has been presented. Read-only: it defines no global and touches
 *  nothing on the page. */
export const RENDERED_PROBE = `new Promise(function (resolve) {
  var settled = false;
  function presented() {
    if (settled) { return; }
    settled = true;
    requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); });
  }
  function isFcp(entry) { return entry.name === 'first-contentful-paint'; }
  try {
    if (performance.getEntriesByType('paint').some(isFcp)) { presented(); return; }
    new PerformanceObserver(function (list, observer) {
      if (list.getEntries().some(isFcp)) { observer.disconnect(); presented(); }
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {
    presented();
  }
})`;

/**
 * Holds a cover until the page under it has rendered.
 *
 * `loaded(target)` is called where the cover used to come down. It runs
 * `probe(target)`, and calls `lift()` once that settles or the backstop fires,
 * whichever is first, and only if nothing has asked for the cover since:
 * `hold()` voids every lift in flight, so a retry that raises the cover again
 * is never uncovered by the load before it.
 *
 * @param {{probe: (target: any) => Promise<unknown>, lift: (why: string) => void,
 *   timeoutMs?: number, setTimer?: Function, clearTimer?: Function}} deps
 */
export function createCoverGate({ probe, lift, timeoutMs = RENDER_BACKSTOP_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0;
  return {
    loaded(target) {
      const mine = ++generation;
      let done = false;
      let timer = null;
      const finish = (why) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimer(timer);
        if (mine === generation) lift(why);
      };
      timer = setTimer(() => finish('backstop'), timeoutMs);
      let pending;
      try { pending = Promise.resolve(probe(target)); } catch { pending = Promise.reject(new Error('probe threw')); }
      pending.then(() => finish('rendered'), () => finish('probe-failed'));
    },
    hold() { generation++; },
  };
}
