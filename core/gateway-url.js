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
  if (!token) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const frag = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    frag.set('token', token);
    url.hash = `#${frag.toString()}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}
