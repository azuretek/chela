// The affordance that adds an "App settings" control to the Control UI's
// sidebar footer, and the host bridge it calls to open the app's own settings
// surface.
//
// ONE script, TWO clients. This is the platform-free half: the script itself
// lives in spec/app-settings-affordance.json so the bytes the desktop runs and
// the bytes the phone run are one copy rather than two that agree by
// convention, exactly as the client-context hook is (see prompt-metadata.js).
// The desktop reads this module and installs the script into the gateway page
// over executeJavaScript; the iOS client bundles the spec and installs it
// through a WKUserScript, reading the same fields this module exposes.
//
// What the affordance does NOT do is reimplement settings. It finds the footer,
// adds a control, and on a click calls a host bridge the client wires up. That
// bridge is the one thing that differs between clients, and it differs only in
// how open() reaches the app's window: an IPC on the desktop, a message handler
// on the phone. The shared settings surface it opens is core/ui/settings.html,
// which both clients already load; this only opens it.
//
// Consumers: desktop/src/main.js installs installation() into the gateway page
// and answers the bridge in desktop/src/preload.cjs; iOS installs the same
// script through a WKUserScript and answers the bridge in a message handler.

import spec from './spec/app-settings-affordance.json' with { type: 'json' };

/** The global the client installs its host bridge on. May be a FROZEN contextBridge object, so the script only reads it. */
export const AFFORDANCE_GLOBAL = spec.global;

/** The plain, writable global the config (label, tooltip, tokens, anchors) is set on. */
export const AFFORDANCE_CONFIG_GLOBAL = spec.configGlobal;

/** The attribute the injected control carries, so a re-render cannot stack two of them. */
export const AFFORDANCE_MARKER = spec.marker;

/** The selectors the script tries in order: the footer actions, the footer bar, then any sidebar. */
export const AFFORDANCE_ANCHORS = spec.anchors;

/**
 * The Control UI routes a client may hand the reader to, by name.
 *
 * One today: the route the Control UI's own settings entry opens, which is the
 * destination "Go to the Control UI settings" promises. Preferred mechanism is
 * still to press the Control UI's own control; this is what happens when there
 * is no control to press, so the button cannot silently do nothing.
 */
export const AFFORDANCE_ROUTES = spec.routes;

/** The default label and tooltip, so a client that passes neither still reads sensibly. */
export const DEFAULT_LABEL = 'App settings';
export const DEFAULT_TOOLTIP = 'Open this app\u2019s settings';

/**
 * How long a client holds its own surface waiting for the Control UI's settings
 * page to arrive, and how often it asks.
 *
 * Read from the spec rather than written here, because the phone has to hold the
 * same line and a number that two clients must agree on needs one owner. A
 * DEADLINE rather than an open wait, and the reason is the failure it bounds: a
 * Control UI that never reaches the route (a renamed surface node, a gateway that
 * redirects away, a page that is simply broken) must not leave a reader behind a
 * surface that never lets go. Past the deadline the client reveals anyway and logs
 * it, which is the behaviour of the day before rather than a new way to be stuck.
 *
 * The number is generous on purpose. The gap this exists to remove is the
 * destination's own load, which on a remote gateway is seconds rather than
 * milliseconds, and holding a working settings page a moment longer is strictly
 * better than showing a page the reader did not ask for. What it is NOT is
 * unbounded: ten seconds is longer than any gateway this app talks to takes to
 * paint its own settings page, and a surface still holding at that point is
 * reporting a fault rather than waiting on a load.
 */
export const CONTROL_UI_SETTINGS_READY_TIMEOUT_MS = spec.handoff.readyTimeoutMs;

/** The interval between readiness questions. Cheap: the statement is one boolean. */
export const CONTROL_UI_SETTINGS_POLL_MS = spec.handoff.pollMs;

/**
 * The injected script, exactly as the spec holds it. One copy, two engines.
 *
 * The desktop runs these bytes through executeJavaScript and the phone through
 * a WKUserScript; neither ports it, because a port is a second copy and a second
 * copy is the fork this file exists to prevent.
 */
export function affordanceSource() {
  return spec.script.join('\n');
}

/**
 * The configuration the script reads, as the statement that sets it.
 *
 * A separate statement ahead of the script rather than text spliced into it, so
 * the script body has no per-platform parts and both engines run identical
 * bytes. The client supplies the label, the tooltip and the resolved design
 * tokens; the anchors come from the spec so a selector change is one edit.
 *
 * Set on the CONFIG global rather than the bridge global. The desktop's bridge
 * is a frozen contextBridge object, so a reassignment or an Object.assign onto
 * it throws in the page; the config lives on its own plain global instead, and
 * the script only ever reads the bridge. The `open` function is not set here: it
 * is the bridge the client installs, reached at click time, and the two clients
 * reach their own windows in two different ways.
 */
export function configStatement({ label = DEFAULT_LABEL, tooltip = DEFAULT_TOOLTIP, tokens = {} } = {}) {
  const config = {
    label: String(label || DEFAULT_LABEL),
    tooltip: String(tooltip || DEFAULT_TOOLTIP),
    anchors: spec.anchors,
    // The Control UI's own route for the destination its settings entry opens.
    // Handed in like the anchors, so a route change is one edit in the spec
    // rather than one per client, and so the script that uses it runs identical
    // bytes on both.
    routes: spec.routes,
    tokens: tokens && typeof tokens === 'object' ? tokens : {},
  };
  return `window.${spec.configGlobal} = ${JSON.stringify(config)};`;
}

/**
 * The call that takes the reader to the CONTROL UI's own settings.
 *
 * A separate statement from the installation, the same shape as the config
 * statement, because it is evaluated at a different moment by a different
 * caller: installation happens once per page at document start, and this is
 * asked for when someone presses the button on our settings page. The script
 * installation left the function on the CONFIG global (which is writable; the
 * bridge may be frozen), so this only has to look it up and call it.
 *
 * It returns whether a control was there to press, which the caller logs rather
 * than hides: a fail-soft placement is fine for a control nobody pressed, and a
 * fail-soft navigation is a button that appears to do nothing, which is worth a
 * line in the app's own stdout.
 */
export function controlUiSettingsSource() {
  return `(function () {
  try {
    var config = window.${spec.configGlobal};
    if (config && typeof config.openControlUiSettings === 'function') return config.openControlUiSettings();
  } catch (e) { return false; }
  return false;
})()`;
}

/**
 * The question that tells a client whether the destination has ARRIVED.
 *
 * The other half of the handoff, and the reason the handoff is atomic. The
 * source above asks the Control UI to show its settings; this one answers
 * whether it has, so a client can hold its own surface until there is something
 * to reveal rather than dismissing into a load it cannot see the end of.
 *
 * Asked REPEATEDLY against the live page rather than awaited inside the page,
 * and that is forced by the mechanism rather than chosen: the shipping Control UI
 * has no footer settings control, so the ask falls through to the Control UI's own
 * route, and a route is a FULL DOCUMENT LOAD. A promise returned by the page is
 * destroyed by the very navigation it is waiting on, so the wait has to be driven
 * from outside the document, where it can survive the swap and re-ask the new one.
 *
 * Both halves of the answer are necessary and neither is sufficient. The ROUTE is
 * what makes it the destination the reader asked for, and it is also what makes
 * the answer mean "arrived" rather than "already there": the settings shell is up
 * on every `/settings/*` route, so a reader who came from the Control UI's own
 * settings page would satisfy a node-only question at the instant they pressed.
 * The NODE, painted, is what makes it rendered rather than committed, since the
 * route lands a frame or more before the page has drawn anything.
 *
 * The selectors and the route come from the spec, spliced in as JSON, so there is
 * one owner of every Control UI fact this depends on and the Swift client builds
 * the same statement from the same file rather than a hand-copied selector.
 */
export function controlUiSettingsReadySource() {
  const surface = spec.anchors.controlUiSettingsSurface;
  const route = spec.routes.appearance;
  return `(function () {
  try {
    if (location.pathname !== ${JSON.stringify(route)}) return false;
    var node = document.querySelector(${JSON.stringify(surface)});
    if (!node) return false;
    var box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  } catch (e) { return false; }
})()`;
}
/**
 * What a client installs into the gateway page: the configuration, then the
 * shared script. The client installs its bridge on `window.<AFFORDANCE_GLOBAL>`
 * separately (the desktop in its preload, the phone in a shim); the script reads
 * that bridge at click time rather than at install time, so the order of the two
 * installs does not matter.
 *
 * Re-installing is safe: the configuration is a plain assignment, and the script
 * no-ops if the control is already placed.
 */
export function installation(options = {}) {
  return `${configStatement(options)}\n${affordanceSource()}`;
}
