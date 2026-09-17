import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import defaults from './defaults.js';
import * as model from '../../core/config-model.js';

// Desktop's config file: the persistence around the shared config model.
//
// The shape of a fresh config and the CRUD over its gateway list live in
// core/config-model.js, so the desktop and the iOS client cannot disagree about
// what "remove the active gateway" does. Everything platform-bound stays here:
// where the file lives (Electron's userData), the atomic read/write, the cache,
// and the desktop-only defaults (window bounds, the global shortcut) handed to
// the model's blank().

let cache = null;
let configFile = null;
let userDataOverride = null;

// Where the profile lives. `electron` is the default import so this module loads
// under plain `node` (the electron stub has no `app`) and only reaches for
// `app.getPath` when actually run inside Electron. A unit test points this at a
// temp directory through setUserDataDir() rather than launching Electron, the
// same seam profile.js and noticelog.js already take as a parameter.
function userDataDir() {
  if (userDataOverride) return userDataOverride;
  return electron.app.getPath('userData');
}

function file() {
  if (!configFile) configFile = path.join(userDataDir(), 'config.json');
  return configFile;
}

/**
 * Test seam: point config at a directory and clear the cache, so a unit test
 * can exercise the real read/write path without an Electron `app`. Not called
 * in production, where userData comes from Electron.
 */
export function setUserDataDir(dir) {
  userDataOverride = dir;
  configFile = null;
  cache = null;
}

function blank() {
  return model.blank({
    suggestedGateways: defaults.suggestedGateways,
    uuid: () => crypto.randomUUID(),
    window: {
      width: defaults.windowDefaults.width,
      height: defaults.windowDefaults.height,
      x: null,
      y: null,
      maximized: false,
    },
    globalShortcut: defaults.globalShortcut,
  });
}

function read() {
  if (cache) return cache;
  const base = blank();
  if (!fs.existsSync(file())) {
    // Materialise the defaults on first boot so the file is there to inspect and
    // hand-edit, rather than appearing only after the first settings change.
    return write(base);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    // Shallow-merge so a config written by an older build never loses new keys,
    // and a hand-edited file missing a key still boots.
    cache = {
      ...base,
      ...raw,
      window: { ...base.window, ...(raw.window || {}) },
      trustedCerts: { ...(raw.trustedCerts || {}) },
      swVersions: { ...(raw.swVersions || {}) },
      // Per gateway, like the other maps: a config written before this key
      // existed boots with an empty one and falls back to `themeMode`, rather
      // than losing the appearance it had.
      themeByGateway: { ...(raw.themeByGateway || {}) },
    };
    if (!Array.isArray(cache.gateways) || cache.gateways.length === 0) cache.gateways = base.gateways;
  } catch {
    // Keep the unreadable file in place as evidence; run from defaults this boot.
    cache = base;
  }
  return cache;
}

// Atomic: a crash mid-write must never leave a truncated config that wipes
// pinned certs and gateway list on next boot.
function write(next) {
  cache = next;
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return cache;
}

function update(patch) {
  return write({ ...read(), ...patch });
}

function activeGateway() {
  return model.activeGateway(read());
}

function addGateway({ label, url }) {
  const { config, entry } = model.addGateway(read(), { label, url }, () => crypto.randomUUID());
  write(config);
  return entry;
}

function updateGateway(id, patch) {
  return write(model.updateGateway(read(), id, patch));
}

function removeGateway(id) {
  return write(model.removeGateway(read(), id));
}

function trustCert(host, fingerprint) {
  return write(model.trustCert(read(), host, fingerprint));
}

/**
 * The appearance a gateway was last seen in. A read, and only a read.
 *
 * Every surface of ours asks for its colours through this: the loading cover,
 * the window background and the title strip. Nothing here writes, which is the
 * property being preserved as much as the value is: a theme that gets
 * re-derived at launch is a theme the reader chose and the app replaced.
 */
function themeFor(gatewayId) {
  return model.themeFor(read(), gatewayId);
}

/**
 * Remember that a gateway is in `mode`.
 *
 * Written only where a theme genuinely CHANGED, which is the two events that may
 * move an appearance and no others: the reader chose one in the Control UI, or
 * the app moved to a gateway whose theme differs. `model.rememberTheme` returns
 * the same config when there is nothing new to record, and that identity is what
 * skips the write, so a launch that changes nothing touches no file.
 */
function rememberTheme(gatewayId, mode) {
  const next = model.rememberTheme(read(), gatewayId, mode);
  if (next === cache) return false;
  write(next);
  return true;
}

export default {
  path: file,
  get: read,
  update,
  activeGateway,
  addGateway,
  updateGateway,
  removeGateway,
  trustCert,
  themeFor,
  rememberTheme,
};
