// Build the Control UI URL that hands the token to the gateway.
//
// The Control UI accepts a token handoff on the URL fragment (`#token=<token>`):
// it reads the fragment during boot, stores it for that gateway, and strips it
// from the address bar (docs/web/urls.md, "Remote Gateway handoff"). The
// fragment form is the documented preference over `?token=` because fragments
// never reach an HTTP request log or a Referer header. This is what lets a
// client supply the credential instead of asking someone to paste one, and
// because it is reapplied on every connect it also self-heals a stale stored
// token.
//
// Pure URL construction, no platform in it, so desktop and a Swift port build
// the exact same address from the same gateway URL and token. The one behaviour
// worth pinning: an existing fragment is preserved and only the `token` key is
// set, and a URL that will not parse is handed back untouched rather than thrown,
// because the caller's next move is to load it and let the real navigation fail
// with a real error, not to crash on a typo in Settings.

/**
 * `rawUrl` with `#token=<token>` merged into its fragment.
 *
 * @param {string} rawUrl  the gateway's Control UI URL
 * @param {string} [token] the token to hand off; falsy leaves the URL unchanged
 * @returns {string}
 */
export function withTokenHandoff(rawUrl, token) {
  return withFragmentHandoff(rawUrl, 'token', token);
}

/**
 * `rawUrl` with `#bootstrapToken=<token>` merged into its fragment.
 *
 * The setup-code / QR credential, NOT the shared connect token. The Control UI
 * reads `bootstrapToken` from the fragment during boot and exchanges it in the
 * device pairing handshake (it becomes `auth.bootstrapToken` on the connect,
 * which the gateway validates against the device-bootstrap table and answers
 * with a pending pairing request), whereas `token` is the shared-owner connect
 * secret the gateway checks directly. They are different gates: a setup code fed
 * as `token` is rejected with "This Gateway expects its token", which is why the
 * two handoffs are distinct keys and this one exists.
 *
 * Same fragment rules as `withTokenHandoff`: an existing fragment is preserved,
 * only the `bootstrapToken` key is set, a falsy token leaves the URL unchanged,
 * and a URL that will not parse is handed back untouched.
 *
 * @param {string} rawUrl  the gateway's Control UI URL
 * @param {string} [token] the bootstrap/setup-code token; falsy leaves the URL unchanged
 * @returns {string}
 */
export function withBootstrapHandoff(rawUrl, token) {
  return withFragmentHandoff(rawUrl, 'bootstrapToken', token);
}

/**
 * `rawUrl` with `#<key>=<value>` merged into its fragment. The one owner of the
 * merge rule both handoffs share, so `token` and `bootstrapToken` cannot drift
 * in how they preserve an existing fragment or replace an existing key.
 *
 * @param {string} rawUrl
 * @param {string} key
 * @param {string} [value]
 * @returns {string}
 */
function withFragmentHandoff(rawUrl, key, value) {
  if (!value) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const frag = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    frag.set(key, value);
    url.hash = `#${frag.toString()}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}
