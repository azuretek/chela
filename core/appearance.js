// The one appearance decision, shared by every client so none of them invents its
// own answer. Abi, 2026-09-20: "as long as we are abstracting so the logic is
// exactly the same we are good" and "make electron/windows use the same code, we
// should not diverge for the same features ever".
//
// The decision is small and it is the whole of it: given the appearance a page has
// RESOLVED for its own palette, what should the client tell its web view about the
// colour scheme? A page that resolved an explicit light or dark is drawn in that;
// a page that resolved neither is left to the DEVICE, so the reader's OS setting
// reaches the page and a live OS change still does.
//
// This is platform-free on purpose. It returns an abstract answer, and each client
// maps that answer to its own web-view API:
//
//   desktop  nativeTheme.themeSource   = 'light' | 'dark' | 'system'
//            (desktop/src/chrome.js applyTheme)
//   iOS      overrideUserInterfaceStyle = .light | .dark | .unspecified
//            (mobile/Claw/ThemeTokens.swift pageTrait, .unspecified IS 'system')
//
// The mapping is a one-line adapter on each side; the DECISION is here, and
// mobile/ClawTests/AppearanceParityTests.swift runs the same inputs through the
// Swift adapter and asserts the same answers, so the two cannot drift: a change
// here fails there until it moves too, the same contract core/tokens.js has with
// ThemeTokensParityTests.
//
// Why "else -> system" is the important branch: pinning the web view to a resolved
// mode changes what `prefers-color-scheme` reports INSIDE the view, and the Control
// UI's own "System" appearance reads that media query to follow the OS. Pin it and
// System reads the pin back rather than the OS and freezes (measured on Windows,
// 2026-09-20: a live OS change never reached the page and the first-load mode won
// regardless of the OS). Leaving it to the device is what the iOS client already
// does, and this is the desktop converging onto it.

/**
 * The colour scheme a client should give its web view for a page that resolved
 * the given mode.
 *
 * @param {unknown} mode  What the page resolved: 'light', 'dark', or anything
 *   else (including null/undefined) for "did not resolve an explicit mode".
 * @returns {'light'|'dark'|'system'} 'light'/'dark' to pin the view to that mode,
 *   'system' to leave the device to answer prefers-color-scheme.
 */
export function pageColorScheme(mode) {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return 'system';
}
