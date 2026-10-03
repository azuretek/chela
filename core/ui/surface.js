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

    /**
     * Move this surface out of the way, and hold it there.
     *
     * For the one case where two of our surfaces would otherwise be on screen at
     * the same time: About goes over Settings, and two cards in one window is a
     * view nobody asked for. Reported 2026-10-01.
     *
     * The card plays its departure and stays at its last frame, and the view is
     * NOT removed: what the reader was looking at is still there to come back to,
     * with the tab and the scroll position it had. The dim is left alone on
     * purpose, because it is the window one dim and the sheet arriving above keeps
     * its own scrim clear (surface--stacked); covering it too would leave the
     * interface undimmed for the length of the handoff.
     *
     * Resolves with whether anything was animated, like leave(), and never
     * rejects, so a page that throws here is a surface the host still covers.
     */
    cover: function () {
      var wait;
      try {
        var body = document.body;
        if (!body) return Promise.resolve(false);
        // A native sheet is the platform own presentation, so there is no card of
        // ours to move: the host dismisses the sheet instead, which is the same
        // rule leave() follows.
        if (nativeSheet()) return Promise.resolve(false);
        body.classList.add('surface--covered');
        wait = reduced() ? durationMs('--duration-fast') : durationMs('--motion-sheet-out');
      } catch (e) {
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(true); }, wait + SLACK_MS);
      });
    },

    /**
     * Close this surface on a click on the dim around its card, and never on a
     * click on the card.
     *
     * ONE implementation for every sheet that dims the window, so Settings and
     * About cannot come to mean different things by "outside". It answers with the
     * page's own dismiss, the same function its "Back to app" control and Escape
     * call, so there is no second way out that could skip what that one does.
     *
     * A click counts only when the press and the release both land on the scrim
     * itself. A press on the card released on the dim (a text selection dragged
     * out of the card) is not a click on the dim, and neither is the reverse; the
     * browser's own `click` cannot tell those apart, because it fires on the
     * common ancestor, which is the scrim either way.
     *
     * The press is remembered in a variable on purpose. The code this replaced
     * compared the release's target with the press event's `currentTarget` from
     * inside a later listener, and an event's currentTarget is null once its
     * dispatch is over, so the comparison never held and the dim never closed
     * anything (#141, measured by desktop/scripts/test-outside-click.js).
     *
     * Inside a native sheet it does nothing: there the scrim's padding is part of
     * the sheet the reader sees, so a tap on it is a tap INSIDE the sheet, and the
     * area outside belongs to the native host, which closes the sheet itself.
     */
    dismissOnOutsideClick: function (scrim, dismiss) {
      if (!scrim || typeof scrim.addEventListener !== 'function' || typeof dismiss !== 'function') return;
      var pressed = false;
      scrim.addEventListener('mousedown', function (e) {
        pressed = e.target === scrim && e.button === 0 && !nativeSheet();
      });
      // Every release inside the page bubbles here, the card's included, so a
      // press that ends anywhere else is forgotten rather than left armed.
      scrim.addEventListener('mouseup', function (e) {
        var armed = pressed;
        pressed = false;
        if (armed && e.target === scrim && e.button === 0) dismiss();
      });
    },

    /**
     * Bring a covered surface back.
     *
     * Synchronous, and there is nothing to wait for: taking the class off changes
     * the card animation-name back to the arrival the stylesheet already declares,
     * and a changed animation-name starts a new animation, so the slide up is the
     * same motion as the original arrival. A caller may not read its own result as
     * a signal either, so an answer would be a second way to get this wrong.
     */
    reveal: function () {
      try {
        if (document.body) document.body.classList.remove('surface--covered');
      } catch (e) { /* a page with no body has nothing to reveal */ }
    },
  };
})();
