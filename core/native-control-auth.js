// The native token handoff: the one JS global a native client sets on the
// Control UI's window so the page authenticates as the operator who entered the
// token rather than as nobody.
//
// The Control UI reads `window.__OPENCLAW_NATIVE_CONTROL_AUTH__` during boot,
// before it opens its gateway socket, and deletes it (see
// resolveApplicationStartupSettings in the OpenClaw checkout at
// ui/src/app/startup-settings.ts). So a native client that sets this global at
// document START is feeding a mechanism the page was built to consume, not
// inventing a parallel one, and the timing mirrors the client-context hook for
// the same reason: installed at document end it would race a socket the page had
// already opened.
//
// Platform-free. The global name and the object's shape live here and in
// spec/native-control-auth.json; the credential is never here (it is read from
// each client's own secure store at connect time), and the client descriptor's
// per-client facts (id, platform, deviceFamily) are passed in by the client.
// What is shared is the envelope, which is what lets a second client, an Android
// one later, feed the same global the same way.
//
// The token is put on this global and NOT on the navigation URL, unlike the
// `#token=` fragment in gateway-url.js: the same page reads either, but this
// keeps a real credential out of the address entirely and carries a client
// identity beside it. Neither path weakens the gateway's auth: the token is
// still checked, and a client id grants no admission of its own.
//
// Consumers: mobile/Chela/NativeControlAuth.swift ports these rules and proves
// itself against core/fixtures/native-control-auth.json; a later Android client
// installs the same statement its own way.

import spec from './spec/native-control-auth.json' with { type: 'json' };

/** The global the native handoff object is set on, read by the Control UI at boot. */
export const NATIVE_CONTROL_AUTH_GLOBAL = spec.global;

/** The coarse client mode native UI clients connect with. */
export const NATIVE_CONTROL_AUTH_MODE = spec.mode;

/** The operator scopes a native client requests, mirroring the Control UI's own set. */
export const NATIVE_CONTROL_AUTH_SCOPES = spec.scopes;

/**
 * The native handoff object, from the token and the client's own descriptor.
 *
 * The token is included only when it is a non-empty string: an absent or empty
 * token hands no credential over, and an object with an empty `token` would tell
 * the page to retire shared-owner auth rather than to stay as it was. The client
 * descriptor is included only when its per-client facts are all present, because
 * the Control UI builds a native client identity only from a complete descriptor
 * and a partial one would be dropped there anyway, so a partial one is left out
 * here rather than sent to be discarded.
 *
 * @param {object} [options]
 * @param {string} [options.token]        the gateway token; falsy hands none over
 * @param {string} [options.clientId]     the canonical native client id (per client)
 * @param {string} [options.platform]     the runtime platform string (per client)
 * @param {string} [options.deviceFamily] the device family hint (per client)
 * @returns {object} the object to set on the global
 */
export function nativeControlAuth({ token, clientId, platform, deviceFamily } = {}) {
  const auth = {};
  if (typeof token === 'string' && token !== '') {
    auth.token = token;
  }
  if (clientId && platform && deviceFamily) {
    auth.client = {
      id: clientId,
      mode: spec.mode,
      platform,
      deviceFamily,
      scopes: [...spec.scopes],
    };
  }
  return auth;
}

/**
 * The install statement: the one assignment that sets the global.
 *
 * A single assignment rather than a script with logic in it, because the whole
 * of the mechanism is "the page reads this global at boot". The client installs
 * this at document start, before the page's own script runs. Building the object
 * here rather than in the client keeps one owner of the shape, and the client
 * passes only its own facts and the token it read.
 *
 * @param {Parameters<typeof nativeControlAuth>[0]} [options]
 * @returns {string} `window.<global> = <json>;`
 */
export function installation(options = {}) {
  return `window.${spec.global} = ${JSON.stringify(nativeControlAuth(options))};`;
}
