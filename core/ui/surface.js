// The one shared line between a surface and the host that is taking it away.
//
// ONE script, EVERY surface page. The settings, about, pairing and loading pages
// all load this, so a departure is one mechanism rather than a class each host
// remembers to toggle on its own page. The host asks the page to leave, waits for
// the answer, and only then removes the view: that is what makes the leaving
// animation visible at all, since a view removed on the same tick as the ask never
// paints a frame of it.
//
// WHY THE PAGE OWNS THE TIMING. It owns the stylesheet that declares the
// duration, so the wait and the animation cannot disagree, and it owns the
// reduced-motion preference, which is a fact about the reader rather than about
// the host. A host that waited a duration it had guessed would be wrong twice: on
// a page whose stylesheet never loaded, and for a reader who asked for no motion.
//
// The rules and the reasoning are ui/CONVENTIONS.md.
(function () {
  // The fallback for a page that somehow has no token, so a missing stylesheet
  // makes a departure instant rather than a surface that never lets go.
  var FALLBACK_MS = 100;
  // A frame of slack past the token. The animation starts on the next paint after
  // the class lands, so resolving exactly on the token can cut its last frame.
  var SLACK_MS = 32;

  function reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      // A page that cannot ask the question animates. The preference is a courtesy
      // and an unreadable one must not change what the reader sees.
      return false;
    }
  }

  /**
   * A duration token from the stylesheet that declares it, in milliseconds.
   *
   * Exposed because more than one page needs it and a second copy of this parsing
   * would be a second answer to "how long is --duration-fast": the notice banner
   * plays a card off its bar on the same token, without wanting the whole-surface
   * departure below.
   */
  function durationMs(name) {
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      var value = parseFloat(raw);
      if (!isFinite(value)) return FALLBACK_MS;
      // The token is a time, so it needs its unit: `100` is not 100ms in CSS, and
      // `0.1s` is.
      return /ms$/.test(raw) ? value : value * 1000;
    } catch (e) {
      return FALLBACK_MS;
    }
  }

  // Inside a native sheet (the phone's Settings and About) the platform's own
  // presentation is the motion, so this page has no departure of its own to play.
  // The host states it at document start; see ui.css, surface--native-sheet.
  function nativeSheet() {
    try {
      return document.documentElement.classList.contains('surface--native-sheet');
    } catch (e) {
      return false;
    }
  }

  // A surface opened over another surface that already dims the window (About
  // over Settings) draws no dim of its own, so the window keeps ONE dim rather
  // than two stacked. The desktop host states it in the URL; read here, before
  // first paint, so the second dim never shows for a frame. See ui.css,
  // surface--stacked.
  (function markStacked() {
    try {
      if (new URLSearchParams(location.search).has('stacked')) {
        document.documentElement.classList.add('surface--stacked');
      }
    } catch (e) {
      // A page that cannot read its URL draws its own dim, which is the safe side.
    }
  })();

  // Hold a surface's ARRIVAL until the page has painted its first frame, then let
  // it play. A view of ours is attached while its page loads (a surface the reader
  // opened takes the keyboard, see ui/CONVENTIONS.md), so an arrival that started
  // with the document's first style ran partly while nothing was yet on screen,
  // and a sheet appeared already half way up. Paused at its first keyframe it is
  // wholly off screen, so nothing is shown early either.
  //
  // Fail-safe by construction: the pause is a class THIS script adds, so a page
  // whose script never ran animates as it always did, and the class comes off on
  // a short bound even if no frame is ever reported.
  (function holdArrivalForFirstPaint() {
    try {
      var root = document.documentElement;
      if (!root || !root.classList || typeof root.classList.add !== 'function') return;
      root.classList.add('surface--pending');
      var released = false;
      var release = function () {
        if (released) return;
        released = true;
        try { root.classList.remove('surface--pending'); } catch (e) { /* the page is going */ }
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () { window.requestAnimationFrame(release); });
      }
      setTimeout(release, 250);
    } catch (e) {
      // A page that cannot be held animates as it always did.
    }
  })();

  window.clawSurface = {
    /**
     * Whether the reader has asked for no motion.
     *
     * Exposed rather than kept private so a host can decide not to raise a surface
     * at all where the motion would be the point, and so a page can take the same
     * answer without reading the media query a second time.
     */
    reducedMotion: reduced,

    /** One of the two duration tokens, in milliseconds. */
    durationMs: durationMs,

    /**
     * The minimum-visible floor, in milliseconds, read from the stylesheet.
     *
     * The page-side reach for what core/ui/motion.js exports as MIN_VISIBLE_MS: a
     * sandboxed page cannot import the module, so it reads the same value off the
     * `--motion-min-visible` custom property ui.css declares, the same way it reads
     * the duration tokens above. A transient state a page raises (the About page's
     * “Checking…”, say) is held this long before it reverts, so a cached answer
     * that settles instantly is still on screen long enough to read. The eighth
     * rule in ui/CONVENTIONS.md, and the desktop main process floors its own
     * transients against the same constant.
     *
     * Falls back to the module's value if the token is missing, so a page whose
     * stylesheet did not load holds too long rather than flashing, which is the
     * safe direction for this rule.
     */
    minVisibleMs: function () {
      var value = durationMs('--motion-min-visible');
      return value === FALLBACK_MS ? 900 : value;
    },

    /**
     * Play this surface's departure, and resolve when it has finished.
     *
     * Resolves with whether anything was animated, which the host logs rather than
     * branches on: the removal happens either way, and only the wait differs.
     * Never rejects, because a page that throws here would be a view the host
     * never takes away.
     */
    leave: function () {
      var wait;
      try {
        // A native sheet leaves by the platform's own motion, so there is nothing
        // here to wait for.
        if (nativeSheet()) return Promise.resolve(false);
        var body = document.body;
        if (body) body.classList.add('surface--leaving');
        // The page's own departure: a sheet's slide, or the short fade that stands
        // in for every movement under reduced motion (the stylesheet swaps the
        // value, so this reads whichever one is in force). Reduced motion still
        // plays its fade, so it still waits, just for the shorter time.
        wait = reduced() ? durationMs('--duration-fast') : durationMs('--surface-leave');
      } catch (e) {
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(true); }, wait + SLACK_MS);
      });
    },
  };
})();
