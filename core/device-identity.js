// Making the Control UI's device identity survive a reinstall.
//
// The gateway recognises an already-paired device by its Ed25519 keypair, not by
// the operator token: the token is the auth gate, and the keypair is the pairing
// gate. The Control UI generates that keypair, derives the device id as the
// SHA-256 of the public key, keeps the pair in localStorage under one key, and
// signs the gateway's connect challenge with it (see loadOrCreateDeviceIdentity
// and buildGatewayConnectDevice in the OpenClaw checkout, and
// deriveDeviceIdFromPublicKey / verifyGatewayConnectDeviceProof on the gateway
// side). On the desktop that localStorage is Chromium origin storage and
// persists, so the desktop pairs once. On iOS the same page runs in a WKWebView
// whose localStorage is wiped on uninstall, so every reinstall mints a new key,
// a new device id, and a fresh pairing request.
//
// This module owns the storage key and the two injected scripts that bridge that
// localStorage value to a store that outlives the web view: a seed script at
// document start that restores a persisted identity into localStorage before the
// page boots and reads it, and a capture script that posts the page's current
// identity out to the native layer so it can be persisted. It does NOT generate,
// derive or sign anything: the page stays the one owner of the crypto, and all
// the native layer does is make the value the page reads and writes persist.
//
// Platform-free, like the other shared contracts. The storage key, the seed
// global, the message-handler name and the two scripts are data, read from
// spec/device-identity.json so a Swift port and a later Android one share the
// exact same source of truth and run identical injected bytes.
//
// Consumers: mobile/Chela/DeviceIdentityStore.swift (the Keychain that holds the
// persisted identity) and mobile/Chela/DeviceIdentityBridge.swift (the capture
// handler) port these rules and prove themselves against
// core/fixtures/device-identity.json; the desktop needs no bridge, because
// Chromium already persists the page's localStorage across launches.

import spec from './spec/device-identity.json' with { type: 'json' };

/** The one localStorage key the Control UI keeps its device keypair under. */
export const DEVICE_IDENTITY_STORAGE_KEY = spec.storageKey;

/** The global the seed script reads the persisted identity from. */
export const DEVICE_IDENTITY_SEED_GLOBAL = spec.seedGlobal;

/** The message-handler name the capture script posts the current identity to. */
export const DEVICE_IDENTITY_MESSAGE_NAME = spec.messageName;

/** How often the capture script reads the storage key, in milliseconds. */
export const DEVICE_IDENTITY_POLL_INTERVAL_MS = spec.pollIntervalMs;

/**
 * The seed statement: the persisted identity assigned to the seed global, then
 * the seed script.
 *
 * Two parts in one string, in this order for one reason: the script reads the
 * global, so the global has to be set first, and both have to be in place before
 * the page's own script runs. A client installs this at document start. The
 * identity is included only when it is a non-empty string; with none to restore
 * the assignment is `null` and the seed script does nothing, which is the
 * first-ever launch where the page mints its own.
 *
 * The identity is the opaque JSON the page owns. This never parses it: a value
 * that is not what the page expects is the page's problem to reject on read, and
 * this module keeps no opinion about the keypair's shape so a change to it on the
 * page side needs no change here.
 *
 * @param {object} [options]
 * @param {string} [options.identity] the persisted identity JSON, or falsy for none
 * @returns {string} `window.<seedGlobal> = <json>;\n<seed script>`
 */
export function seedInstallation({ identity } = {}) {
  const value = typeof identity === 'string' && identity !== '' ? identity : null;
  const assignment = `window.${spec.seedGlobal} = ${JSON.stringify(value)};`;
  return `${assignment}\n${spec.seed.join('\n')}`;
}

/** The capture script, exactly as the spec holds it. One copy, both engines. */
export function captureScript() {
  return spec.capture.join('\n');
}
