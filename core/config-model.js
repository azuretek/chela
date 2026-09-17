// The gateway configuration model: what a config looks like, and the pure CRUD
// over its gateway list.
//
// This is the half of desktop's src/config.js that has no machine in it. The
// persistence, where the file lives, how it is read and atomically written,
// which Electron path holds it, stays on desktop because it is desktop's disk.
// What lives here is the shape of a fresh config and the rules for adding,
// editing and removing a gateway, because those are identical on every client
// and a phone that disagreed with the desktop about what "remove the active
// gateway" does would be a drift bug waiting to happen.
//
// Every function is pure: it takes a config object and returns a new one, and
// never touches disk, an app path or a clock. The caller supplies the id
// generator (desktop uses node:crypto's randomUUID, a Swift port uses its own)
// and, for blank(), the suggested gateways and window/shortcut defaults, so this
// module carries no platform default of its own.

/**
 * A fresh config, as first-run should materialise it.
 *
 * The suggestions and the desktop-only defaults (window bounds, the global
 * shortcut) are passed in rather than imported, because they are the platform's
 * to decide: a phone has no window bounds and no global shortcut, and its blank
 * config simply omits them.
 *
 * @param {object} opts
 * @param {Array<{label: string, url: string}>} [opts.suggestedGateways]
 * @param {() => string} opts.uuid  an id generator
 * @param {object} [opts.window]    desktop window defaults, or omit on mobile
 * @param {string} [opts.globalShortcut]  desktop shortcut, or omit on mobile
 * @returns {object}
 */
export function blank({ suggestedGateways = [], uuid, window = null, globalShortcut = null } = {}) {
  const base = {
    gateways: suggestedGateways.map((g) => ({ id: uuid(), ...g })),
    activeGatewayId: null,
    zoomLevel: 0,
    closeToTray: true,
    launchAtLogin: false,
    startHidden: false,
    // Opt-in because these facts leave the client and become part of each
    // ordinary chat prompt sent to the configured gateway.
    promptMetadata: false,
    // Download and offer to install a new version without being asked. True by
    // default because an out-of-date client against a moving gateway is the
    // failure this app is most likely to have, and the update is offered rather
    // than applied, nothing restarts behind anyone's back. Turning it off keeps
    // the six-hourly check, so the app can still say a release exists and offer
    // to fetch it on the spot; see updates.policy().
    autoUpdate: true,
    // "light" | "dark" | null, the Control UI's theme as of the last run, so a
    // cold start opens its windows in the right colours before the gateway has
    // answered. Learned, never configured; see adoptTheme in src/main.js.
    //
    // ONE slot, which is now only the fallback: a gateway with no entry of its
    // own in themeByGateway takes this. It is kept rather than migrated away so
    // an existing profile keeps the appearance it had, and it is never cleared
    // by a gateway switch, because clearing it is exactly how the last known
    // appearance would be lost on the way to a gateway that has none.
    themeMode: null,
    // gateway id -> "light" | "dark", the appearance THAT GATEWAY was last seen
    // in. Keyed because the effective theme is per gateway: the Control UI's
    // theme is chosen in the Control UI, which belongs to one gateway, so
    // switching between two gateways with different themes has to move the app
    // between two remembered values rather than overwrite one slot. Learned,
    // never configured; see themeFor() and rememberTheme() below.
    themeByGateway: {},
    // host -> "sha256/BASE64", pinned on first accept. See src/certs.js.
    trustedCerts: {},
    // origin -> Control UI build id as of the last successful load, so an
    // upgraded gateway has its service-worker cache dropped exactly once rather
    // than on every connect. Learned, never configured; see src/cache.js.
    swVersions: {},
    // Fingerprint of the app build that last ran, version plus the app bundle's
    // size and mtime, because the semver alone does not move between builds. An
    // app upgrade brings a new Electron and a new preload, so its caches are
    // cleared once on the first run after. null on a fresh profile, which is
    // deliberately *not* an upgrade: there is nothing stale in a cache that does
    // not exist yet.
    appBuild: null,
  };
  if (window) base.window = { ...window };
  if (globalShortcut) base.globalShortcut = globalShortcut;
  return base;
}

/** The active gateway, or null. */
export function activeGateway(cfg) {
  return cfg.gateways.find((g) => g.id === cfg.activeGatewayId) || null;
}

/**
 * A config with a new gateway appended, plus the entry that was created.
 *
 * Returns both so the caller can persist the config and report the id it
 * assigned, without this module needing to know how either happens.
 *
 * @returns {{config: object, entry: {id: string, label: string, url: string}}}
 */
export function addGateway(cfg, { label, url }, uuid) {
  const entry = { id: uuid(), label: label || url, url };
  return { config: { ...cfg, gateways: [...cfg.gateways, entry] }, entry };
}

/** A config with gateway `id` patched. Unknown fields on the patch are ignored. */
export function updateGateway(cfg, id, patch) {
  const gateways = cfg.gateways.map((g) => (g.id === id
    ? { ...g, label: patch.label ?? g.label, url: patch.url ?? g.url }
    : g));
  return { ...cfg, gateways };
}

/**
 * A config with gateway `id` removed.
 *
 * If it was the active gateway, the active pointer is cleared too, because a
 * pointer to a gateway that no longer exists is a state nothing else guards
 * against.
 */
export function removeGateway(cfg, id) {
  const gateways = cfg.gateways.filter((g) => g.id !== id);
  const activeGatewayId = cfg.activeGatewayId === id ? null : cfg.activeGatewayId;
  return { ...cfg, gateways, activeGatewayId };
}

/** A config with `host` pinned to `fingerprint`. */
export function trustCert(cfg, host, fingerprint) {
  return { ...cfg, trustedCerts: { ...cfg.trustedCerts, [host]: fingerprint } };
}

/** The two modes a theme can be, which is also what a store may hold. */
const THEME_MODES = new Set(['light', 'dark']);

/**
 * The appearance gateway `id` was last seen in, or the last known one.
 *
 * Read-only by construction, and this is the function every surface of ours is
 * supposed to go through: the loading cover, the window background and the
 * title strip all ask for this rather than deciding an appearance, which is how
 * a theme the reader chose survives a launch instead of being re-derived.
 *
 * A gateway with no entry falls back to the single `themeMode` slot rather than
 * to a default, so switching to a gateway that has never been seen opens in the
 * appearance the app was already in, and the page's own report corrects it if
 * that gateway differs. The fallback is a guess about what to PAINT for a few
 * hundred milliseconds; it is never written anywhere, and it cannot overwrite
 * the entry of a gateway that has one.
 *
 * @returns {string|null} "light", "dark", or null when nothing is known at all.
 */
export function themeFor(cfg, id) {
  const stored = id == null ? null : (cfg.themeByGateway || {})[id];
  if (THEME_MODES.has(stored)) return stored;
  return THEME_MODES.has(cfg.themeMode) ? cfg.themeMode : null;
}

/**
 * A config remembering that gateway `id` is in `mode`, leaving every other
 * gateway's entry exactly as it was.
 *
 * Only the two modes are accepted, so an absent, empty or unrecognised report
 * cannot blank a stored value: a caller with nothing to say gets the config
 * back unchanged. The legacy `themeMode` slot is deliberately not touched, for
 * the reason it exists at all.
 *
 * @returns {object} the same config when there is nothing to record, so a
 *   caller can compare identity and skip a write.
 */
export function rememberTheme(cfg, id, mode) {
  if (id == null || !THEME_MODES.has(mode)) return cfg;
  if ((cfg.themeByGateway || {})[id] === mode) return cfg;
  return { ...cfg, themeByGateway: { ...(cfg.themeByGateway || {}), [id]: mode } };
}
