// The reconnect-resume shim: the document-start script the iOS client installs
// so the Control UI's chat page can send after a reconnect.
//
// The page marks the first chat.send after a reconnect with a reserved property
// on its params (`__controlUiReconnectResume`), and the gateway accepts that
// marker only from a client it counts as an operator UI. This client's page
// connects with a NATIVE descriptor (mobile/Chela/NativeControlAuth.swift), so
// the marker is never stripped for it, the field then fails chat.send's own
// parameter validation, and the whole send is refused: the reader sees a message
// that will never send, on a connection that is otherwise healthy.
//
// The shim wraps `WebSocket.prototype.send` and deletes that one property from
// the chat.send frame before it leaves the page. Every other frame goes out as
// the bytes it arrived as, and the wrapper never throws. The durable fix is
// upstream, where the gateway should strip the field for every client; this is
// the prevention that makes the phone work before that ships, and
// spec/reconnect-resume-shim.json names the trigger that retires it.
//
// Platform-free and data-driven. The reserved property, the method it travels
// on and the script itself live in spec/reconnect-resume-shim.json, so the
// desktop, the phone and a later Android client run one copy of one script
// rather than a port each. The iOS client bundles the spec and installs the
// script through a WKUserScript; see mobile/Chela/ReconnectResumeShim.swift.
//
// Consumers: mobile/Chela/ReconnectResumeShim.swift installs these bytes at
// document start, and core/test/reconnect-resume-shim.test.js drives them
// against a fake window and WebSocket.

import spec from './spec/reconnect-resume-shim.json' with { type: 'json' };

/** The property the Control UI puts on a resumed chat.send, which the gateway refuses from this client. */
export const RESERVED_PROPERTY = spec.reservedProperty;

/** The method whose frames the shim rewrites, and the only one it touches. */
export const SHIM_METHOD = spec.method;

/** The install-guard global, so a second installation cannot stack a second wrapper. */
export const SHIM_GLOBAL = spec.global;

/**
 * The injected shim script, exactly as the spec holds it. One copy, two engines.
 *
 * The iOS client runs these bytes through a WKUserScript at document start, the
 * same way it installs the pairing observer and the client-context hook, and
 * neither ports it: a port is a second copy, and a second copy of a script is
 * the fork this file exists to prevent.
 *
 * @returns {string} the script, one line per spec line
 */
export function shimScript() {
  return spec.hook.join('\n');
}
