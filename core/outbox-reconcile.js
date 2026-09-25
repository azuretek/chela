// The outbox reconcile: the document-start script both clients install so a
// message the Control UI queued is never left stuck on a live connection.
//
// The Control UI keeps its outbox in sessionStorage and, on every pass through
// its codec, rewrites an in-flight row as if the page had reloaded. A send the
// gateway already accepted then reads "Reconnected before delivery was
// confirmed" on a socket that never dropped, and the rows behind it wait on a
// reconnect that never comes. The script checks such a row against the gateway's
// own record over the page's own socket, removes it when the gateway holds it,
// and sends it once, under its own send id, when the gateway does not. The why,
// the thresholds and the removal trigger are in spec/outbox-reconcile.json.
//
// Platform-free and data-driven, like the reconnect-resume shim: the script
// lives in the spec, the desktop evaluates it from its preload and the phone
// installs it through a WKUserScript, so there is one copy of it in the tree.

import spec from './spec/outbox-reconcile.json' with { type: 'json' };

/** The install-guard global, which also carries the script's state and log for a reader. */
export const RECONCILE_GLOBAL = spec.global;

/**
 * The injected script, exactly as the spec holds it.
 *
 * @returns {string} the script, one line per spec line
 */
export function reconcileScript() {
  return spec.hook.join('\n');
}
