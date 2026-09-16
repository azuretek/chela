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

/** The default label and tooltip, so a client that passes neither still reads sensibly. */
export const DEFAULT_LABEL = 'App settings';
export const DEFAULT_TOOLTIP = 'Open this app\u2019s settings';

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
    tokens: tokens && typeof tokens === 'object' ? tokens : {},
  };
  return `window.${spec.configGlobal} = ${JSON.stringify(config)};`;
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
