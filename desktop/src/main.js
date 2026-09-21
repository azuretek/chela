import {
  app, BrowserWindow, WebContentsView, Tray, Menu, MenuItem, shell,
  globalShortcut, nativeImage, ipcMain, screen, session,
} from 'electron';
import http from 'node:http';
import { createRequire } from 'node:module';
import { clipboard } from 'electron';

// electron-updater is CommonJS and exposes no named ESM export, so it is pulled
// in with require at the point of use (createRequire is how an ESM file gets
// require back). This also keeps the original behaviour of loading it lazily,
// only when an update check actually runs.
const require = createRequire(import.meta.url);
// No `dialog` here on purpose. Everything this app says to the user is one of
// its own overlay pages, see the overlay section below. The one exception in
// the project is src/certs.js, which has to be able to ask about a certificate
// before any page has loaded, and where the question is a security decision
// rather than a piece of app chrome.
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as autostart from './autostart.js';
import config from './config.js';
import * as buildInfo from './build-info.js';
import * as cache from './cache.js';
import * as certs from './certs.js';
import chrome from './chrome.js';
import * as connectionState from './connection.js';
import * as menus from './menus.js';
import * as noticeStore from './notices.js';
import * as noticelog from './noticelog.js';
import * as overlay from './overlay.js';
import * as pairing from './pairing.js';
import * as profile from './profile.js';
import * as progress from './progress.js';
import * as promptMetadata from './prompt-metadata.js';
import * as quips from './quips.js';
import * as tokens from './tokens.js';
import updates from './updates.js';
// The minimum-visible-duration primitive, shared with the phone: how long a
// transient state (a manual check's answer card) must stay on screen before a
// fresher one may replace it, so a second press does not flash. See
// core/ui/motion.js and the eighth rule in core/ui/CONVENTIONS.md.
import { MIN_VISIBLE_MS, remainingVisibleMs } from '../../core/ui/motion.js';
import secrets from './secrets.js';
import defaults from './defaults.js';
import { withTokenHandoff } from '../../core/gateway-url.js';
// Whether an address is an OpenClaw gateway. The signals and the sentences are
// core/spec/gateway-identity.json's; this imports the module that reads it, and
// the iOS client bundles the same spec. Answering is not identifying: this is
// what stops a 200 from a stranger's page being put behind our chrome.
import * as gatewayIdentity from '../../core/gateway-identity.js';
import * as bootstrapHealth from '../../core/bootstrap-health.js';
import issueReporter from './issue-reporter.js';
// The pairing copy and the approve command, read from the shared contract rather
// than written down here: the screen the desktop shows and the screen the phone
// shows say the same thing because they read the same file. The phase names, the
// close parser and the reducer come through src/pairing.js.
import { COPY as PAIRING_COPY, ROUTE_SETTINGS_GATEWAYS, ROUTE_SETTINGS_TAB } from '../../core/pairing.js';
import { product, repo, releasesUrl } from '../../core/naming.js';
// The shared "App settings" affordance: the ONE injected script that adds a
// control to the Control UI's sidebar footer and calls a host bridge to open our
// own settings surface. Installed into the gateway page here, answered by the
// bridge in preload.cjs; the iOS client installs the same script through a
// WKUserScript. See core/app-settings-affordance.js.
import * as appSettingsAffordance from '../../core/app-settings-affordance.js';
// The app frame inset: the region our own chrome leaves for the page, published
// on the page's root as custom properties, plus the rule that binds the page's
// viewport-anchored overlays to it. Installed from the preload at document start
// (see the frame:inset-script channel below) and moved from the layout pass, so a
// notice band appearing takes the frame with it. The phone installs the same bytes
// from the same spec. See core/app-frame-inset.js.
import * as appFrameInset from '../../core/app-frame-inset.js';
// The URL shape of a release's own notes. Shared rather than built here, because
// the phone puts the same link behind the same button and a link that says
// "release notes" has to land where the notes are.
import { releaseNotesUrl } from '../../core/feed.js';
// The settings surface's spec, read here rather than by the page: the page is a
// file:// document with `default-src 'none'`, so it cannot fetch a JSON file, and
// the spec has to arrive inside the state this process already pushes. The iOS
// client bundles the same file and hands it over the same way, so the two clients
// render from one copy of the split. See core/spec/settings.json.
import settingsSpec from '../../core/spec/settings.json' with { type: 'json' };
// The Control UI this app wraps, and the revision of it our borrowed components
// came out of. Read from the pin rather than written down here, because the pin is
// the one owner of that identity and the class guard is what keeps it true
// (core/test/upstream-classes.test.js): a version beside these classes would agree
// with them on the day it was typed and keep agreeing after they moved. About
// shows it, so that a rendering problem is reported against a revision rather than
// against "the Control UI".
import upstreamReference from '../../core/spec/upstream-reference.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Our own pages, which live in the repo's core/ui rather than here, and which the
// desktop loads out of core/ui in a source checkout and out of the packaged copy
// of core in a build (electron-builder ships core both inside the asar and beside
// it, see electron-builder.yml). Settings is there because the iOS client loads
// that same page; the rest are the desktop's own, and they are there with it for
// a reason that is mechanical rather than tidiness: a page in this tree cannot
// reach a stylesheet in that one by a relative href that is correct in BOTH
// layouts, because packing flattens `desktop/` into the archive's root, so
// `src/ui/about.html` sits one directory deeper in the checkout than in the
// build. Everything in one directory is the only arrangement where one relative
// href is right in both. desktop/test/dialogs.test.js asserts that each href
// resolves.
const UI_DIR = path.join(HERE, '..', '..', 'core', 'ui');
const ASSETS = path.join(HERE, 'assets');
const PRELOAD = path.join(HERE, 'preload.cjs');

// Read once: the stamp is baked into the bundle at pack time and cannot change
// while the app is running.
const buildStamp = buildInfo.read();

/* ------------------------------------------- profile and identity after rename */

// Runs at load, before app.whenReady() and before anything opens the profile,
// and `appData` is one of the few paths resolvable that early. The logic itself
// lives in src/profile.js so it can be tested without launching Electron.
//
// TWO things are settled here, and the second is the one that is easy to miss,
// so it is spelled out in full: see the header of src/profile.js for why the
// userData directory and the safeStorage keychain item move for different
// reasons, and why one migrates while the other is pinned.
{
  const isolated = app.commandLine.hasSwitch('user-data-dir');
  if (isolated) {
    // A caller that pinned userData is isolating this run: scripts/smoke.js,
    // scripts/dump-overlays.js, any harness. The migration works on `appData`,
    // which none of them redirect, so running it here would move the profile of
    // whoever happens to be on this machine, which is the opposite of what an
    // isolated run is for. Leave the directory alone and use theirs.
    console.log('[claw-desktop] isolated userData; not migrating the profile');
  } else {
    const migration = profile.migrate(app.getPath('appData'));
    if (migration.status === 'migrated') console.log(`[claw-desktop] migrated profile: ${migration.from} -> ${migration.to}`);
    if (migration.status === 'failed') console.warn(`[claw-desktop] could not migrate profile (${migration.error}); starting fresh`);
    // Explicit rather than left to the default, which Electron derives from the
    // app name: the name is about to be overridden below, and a path that
    // silently follows it is how the profile ends up in two places.
    app.setPath('userData', migration.to);
  }

  // The keychain item holding the key to credentials.json is named after the app
  // name, so it follows a rename unless something stops it. This stops it, on
  // every run including the first one after the rename, and before any
  // safeStorage call. Credentials written by the previous name stay readable.
  //
  // Logged, because a credential that cannot be decrypted fails silently by
  // design (see src/secrets.js): the item name is the whole diagnosis, and this
  // is the one line that shows which one the app is looking in.
  app.setName(profile.KEYCHAIN_NAME);
  console.log(`[claw-desktop] credentials keychain item: ${profile.KEYCHAIN_NAME} Safe Storage`);
}

let mainWindow = null;
// The gateway page, and the app's own error and first-run pages, live in a
// child view rather than in the window's own WebContents, because a child view
// can be given bounds and a window's own contents cannot.
//
// That is the entire mechanism behind the reserved title strip: the view starts
// below the window buttons, so the page's viewport genuinely excludes them and
// nothing it draws can land underneath, not a header, not a docked panel, not a
// `position: fixed` overlay anchored to a corner. Linux keeps its OS frame, so
// there the view simply fills the window and this costs nothing.
let pageView = null;

/**
 * Which gateway's document the page view is holding, or null when the view is
 * holding one of our own pages (or nothing at all).
 *
 * A gateway id rather than a boolean, and the identity is the point: `true` used
 * to mean "there is a payload" without saying whose, so a connect to a DIFFERENT
 * gateway held the previous gateway's document on screen for as long as the
 * attempt took to fail and left it there afterwards, which is a client showing an
 * authenticated interface while nothing is connected. What may be PRESENTED is
 * this value read against the connection, and that rule is
 * `connectionState.mayPresentGatewayView` rather than a second copy of it here.
 *
 * Set when a gateway document has loaded and been accepted, cleared whenever the
 * connection it belongs to ends: a failed load, a socket the gateway closed, or
 * one of our own pages taking the window. A cleared value does not mean the view
 * is gone, only that nothing may be shown out of it.
 */
let payloadGateway = null;

/**
 * True from the moment this app asks the page view to load or reload until that
 * load finishes.
 *
 * A document being replaced closes the socket it had, and the observer cannot tell
 * that from a gateway going away: both are a close with no pairing reason. So this
 * is what separates them, and it is set only where WE cause the navigation. The
 * connect path does not need it (its phase is already `connecting`, which the drop
 * handler refuses), but the menu's Reload keeps the connection's phase and needs
 * exactly this.
 */
let pageReloading = false;

/**
 * Set while the app is showing its own failure surface because the page's socket
 * went away, as opposed to because a load failed.
 *
 * The two want different recoveries: a failed load is recovered by a retry, while a
 * dropped socket is already recovering on its own inside the page, so the socket
 * opening again IS the gateway being back.
 */
let socketDropped = false;

/**
 * The load attempt in flight, when it is being made beside the payload on screen.
 *
 * One at a time, and never added to the window until it has loaded: see
 * `createGatewayView` for why an attempt cannot be made in the visible view.
 */
let attemptView = null;
// The strip above it, on macOS and Windows. See ui/titlebar.html.
let stripView = null;
// Settings, About and message dialogs are views layered over the main window's
// contents rather than windows or native dialogs of their own. See the overlay
// section below for why, and for the map that holds them.
//
// True while the main window is showing the settings page directly, which is
// the first run: there is no gateway to lay a modal over yet.
let settingsIsPage = false;
let tray = null;
let quitting = false;
let saveTimer = null;
// Inserted-stylesheet keys, per WebContents id, so a theme change can replace
// the sheet it wrote rather than stacking a second one on top.
const themeCssKeys = new Map();
// The same bookkeeping for our own design tokens, kept in its own map: this
// sheet is the fallback the live theme overrides, so it is inserted on a page
// loading rather than on a theme change.
const tokenCssKeys = new Map();

// The colours the app paints for itself, tracking whichever theme the Control
// UI is in. Seeded from the STORED appearance for the active gateway, so a cold
// start opens in the one that gateway was last seen in rather than flashing the
// wrong palette for as long as the gateway takes to answer, which, over
// Tailscale to a sleeping box, is not a flash.
//
// Seeded rather than decided, and the distinction is the whole of the theme
// rule: `config.themeFor` reads a stored value and never computes one, so
// nothing here can replace a theme the reader chose. A gateway with no stored
// entry falls back to the last known mode, which is what keeps the app in the
// appearance it was already in while a switch is in flight, and the page's own
// report corrects it if that gateway differs. A first run, where nothing is
// known at all, is the dark fallback, which is also the window's own background
// and the title strip's colour, so the first frame is internally consistent;
// that fallback is never written back over a stored value.
//
// This value is also what the loading cover is painted with before any gateway
// has answered: on a cold start it IS the resolved appearance, and it updates on
// the same assignment as the rest of our chrome. applyTheme() in startup sets
// nativeTheme.themeSource from it before the window exists, which is what makes
// the cover's own `prefers-color-scheme` agree with it on the first frame.
let currentTheme = chrome.fallbackTheme(config.themeFor(config.get().activeGatewayId));

/* ------------------------------------------------------------------ helpers */

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function activeOrigin() {
  const gw = config.activeGateway();
  return gw ? originOf(gw.url) : null;
}

function promptMetadataConfig() {
  return {
    enabled: config.get().promptMetadata === true,
    block: promptMetadata.formatBlock(promptMetadata.collectMetadata({
      appVersion: app.getVersion(),
    })),
  };
}

function installPromptMetadata(wc) {
  if (!wc || wc.isDestroyed() || originOf(wc.getURL()) !== activeOrigin()) return;
  wc.executeJavaScript(promptMetadata.clientScript(promptMetadataConfig()), true)
    .catch((err) => console.warn(`[claw-desktop] prompt metadata hook failed: ${err.message}`));
}

/**
 * The label and resolved tokens the affordance styles itself with. The tokens
 * are whatever the live theme has reported for this page; an empty map is fine,
 * the script falls back to the page's own `currentColor` and neutral values, so
 * the control still reads as part of the footer before the first theme report.
 */
function appSettingsAffordanceOptions() {
  const tokens = currentTheme.tokens || {};
  return {
    label: 'App settings',
    tooltip: `${chrome.APP_NAME} settings`,
    tokens: {
      border: tokens['--border'],
      radius: tokens['--radius-sm'] || tokens['--radius'],
      muted: tokens['--muted'],
      text: tokens['--text-strong'] || tokens['--text'],
      hover: tokens['--bg-hover'] || tokens['--panel-hover'],
    },
  };
}

/**
 * Install the shared App-settings affordance into the gateway page.
 *
 * The bridge the script calls is `window.__clawAppSettings.open`, which the
 * preload installs on the remote gateway page (see preload.cjs): it is the only
 * property that page's bridge exposes, and it runs `openSettings()` here over
 * IPC. The affordance itself is client-agnostic; only that open() differs
 * between the desktop and the phone.
 *
 * Fail-soft is the script's own job: a footer it cannot find leaves the page
 * untouched and app settings still reachable from the menu bar and the tray.
 */
function installAppSettingsAffordance(wc) {
  if (!wc || wc.isDestroyed() || originOf(wc.getURL()) !== activeOrigin()) return;
  wc.executeJavaScript(appSettingsAffordance.installation(appSettingsAffordanceOptions()), true)
    .catch((err) => console.warn(`[claw-desktop] app settings affordance failed: ${err.message}`));
}

/**
 * The WebContents showing the gateway, or, on a first run or a failed connect,
 * one of the app's own pages. Everything that used to address
 * `mainWindow.webContents` addresses this instead.
 */
function page() {
  return pageView && !pageView.webContents.isDestroyed() ? pageView.webContents : null;
}

/**
 * Position the child views. A child view does not track its parent's size, so
 * this has to run on every event that changes it; one missed event leaves the
 * page the wrong size or the modal floating in a corner.
 *
 * The strip's height is the only thing the page gives up, and it is zero on
 * Linux, which keeps its OS frame.
 */
/**
 * Move the published frame when the client's own chrome moves.
 *
 * The frame is not fixed: a notice banner appears over the page's top-trailing corner
 * and takes a band, and goes away again, so the inset the page is holding has to
 * follow. Nothing is re-installed to do that, the page's setter sits on the global
 * the script left, and this only pushes new numbers, which is why it can ride the
 * layout pass the app already runs rather than a watcher of its own.
 *
 * Only sent when the numbers CHANGE, because a window resize fires this pass
 * constantly and a statement evaluated in the page per event is a cost with no
 * effect. A fresh document needs no reset here: its own preload installed the current
 * numbers at its document start.
 */
let lastFrameInsetKey = '';
function publishFrameInsets() {
  const wc = page();
  if (!wc || wc.isDestroyed() || originOf(wc.getURL()) !== activeOrigin()) return;
  const insets = frameInsets();
  const key = `${insets.top}/${insets.bottom}`;
  if (key === lastFrameInsetKey) return;
  lastFrameInsetKey = key;
  wc.executeJavaScript(appFrameInset.setStatement(insets), true)
    .catch((err) => console.warn(`[claw-desktop] app frame inset not published: ${err.message}`));
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const top = chrome.contentInset().top;
  if (stripView) stripView.setBounds({ x: 0, y: 0, width, height: top });
  if (pageView) pageView.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  // Exactly over the page it stands in for, so the title strip stays visible
  // and draggable while the app is connecting.
  if (loadingView) loadingView.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  // ★ Exactly the card cluster, and no bigger, hugging the top-trailing corner:
  // the view eats every click inside its bounds regardless of what is drawn there,
  // so a view any wider or taller than the cards is a dead strip over the Control
  // UI. The bar is gone (Abi, 2026-09-19); the cards float, and everything beside
  // and below them passes through. Right-aligned to match the sweep chip and the
  // phone's trailing stack, with the same 12px side inset the sweep uses.
  // Where the sweep hangs from: the cards' foot, or the strip top when the bar is
  // gone. Updated as the banner view is placed.
  let bannerFoot = top;
  if (bannerView) {
    const bw = Math.max(0, Math.min(bannerSize.width, width));
    const bh = Math.max(0, Math.min(bannerSize.height, Math.max(0, height - top)));
    const bx = Math.max(0, width - bw - 12);
    bannerView.setBounds({ x: bx, y: top, width: bw, height: bh });
    bannerFoot = top + bh;
  }
  // The sweep is sized to the CONTROL rather than to the window: only the pixels
  // it draws may claim a click, so the view is exactly the button and it hangs
  // under the card cluster's trailing edge. The 12px inset matches the cards', and
  // the gap clears the last card so the chip reads as below the stack rather than
  // inside it.
  if (sweepView) {
    const gap = 8;
    const w = Math.max(0, Math.min(sweepSize.width, width));
    const h = Math.max(0, Math.min(sweepSize.height, Math.max(0, height - top)));
    const y = Math.min(bannerFoot + gap, Math.max(0, height - h));
    sweepView.setBounds({ x: Math.max(0, width - w - 12), y, width: w, height: h });
  }
  // A modal covers everything including the strip: the scrim is meant to dim
  // the whole window, and each overlay page carries its own drag band.
  for (const view of overlayViews.values()) view.setBounds({ x: 0, y: 0, width, height });
  // And the page is told where our chrome now is. Last, because it reads what the
  // banner above was just placed as: a band that appears, moves or goes away takes
  // the published frame with it.
  publishFrameInsets();
}

function trayImage() {
  // Not a macOS template image. A template adapts to the menu bar automatically,
  // which is the more native behaviour, but legibility is the reason to want
  // one, and the mark was checked against both a light and a dark menu bar and
  // holds contrast in red on either. So it keeps the app's colour.
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  img.setTemplateImage(false);
  return img;
}

/* ------------------------------------------------------------- window state */

// Persist size/position, but only reuse them if the saved rectangle still
// intersects a display that exists now, otherwise unplugging a monitor strands
// the window off-screen with no way to get it back.
function restoredBounds() {
  const saved = config.get().window;
  const { width, height, x, y } = saved;
  const base = {
    width: width || defaults.windowDefaults.width,
    height: height || defaults.windowDefaults.height,
  };
  if (x == null || y == null) return base;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x < a.x + a.width && x + base.width > a.x && y < a.y + a.height && y + base.height > a.y;
  });
  return visible ? { ...base, x, y } : base;
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? config.get().window : mainWindow.getNormalBounds();
  config.update({
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x ?? null,
      y: bounds.y ?? null,
      maximized,
    },
  });
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistBounds, 400);
}

/* ------------------------------------------------------------------ session */

// All gateways share one session, exactly as they would share one browser
// profile.
//
// An earlier version gave each gateway entry its own `persist:` partition,
// reasoning that device pairing is per browser profile. That was wrong twice
// over. Chromium already keys site storage, localStorage, IndexedDB, cookies,
// cache, by origin, so two gateways at different origins are isolated inside
// one session anyway; the partition bought nothing. And because the partition
// name was derived from the entry's UUID, the app threw away its device
// identity the moment the entry changed, so the Gateway saw a brand-new device
// and reported a login from an unrecognised client. Editing a URL, removing and
// re-adding a gateway, or simply upgrading was enough to trigger it.
//
// Sharing the session keeps one stable device identity per gateway origin,
// which is what "pair once" is supposed to mean.
function configureSession(ses, gw) {
  const granted = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'pointerLock']);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details?.requestingUrl || (wc && wc.getURL()) || '');
    callback(origin === activeOrigin() && granted.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    requestingOrigin === activeOrigin() && granted.has(permission));

  applyHeaders(ses);
}

// Extra request headers for gateways behind an authenticating proxy, Cloudflare
// Access, a shared-secret header, Basic auth on a reverse proxy.
//
// Matched per request against the origin of the gateway that owns them, which is
// the whole point: a header set here is a credential, and it must never ride
// along on a request to some third-party host the page happens to load. Keying
// the lookup on the request's own origin (rather than the active gateway's) also
// means one listener covers every gateway and never needs re-registering.
function headersByOrigin() {
  const map = new Map();
  for (const gw of config.get().gateways) {
    const origin = originOf(gw.url);
    const headers = secrets.load(gw.id).headers;
    if (origin && headers.length) map.set(origin, headers);
  }
  return map;
}

function applyHeaders(ses) {
  const map = headersByOrigin();
  // Electron keeps only one listener per session for this event, so re-running
  // this after a credential change replaces the old set rather than stacking.
  if (map.size === 0) {
    ses.webRequest.onBeforeSendHeaders(null);
    return;
  }
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = map.get(originOf(details.url));
    if (!headers) return callback({ requestHeaders: details.requestHeaders });
    const next = { ...details.requestHeaders };
    for (const h of headers) next[h.name] = h.value;
    callback({ requestHeaders: next });
  });
}

/* --------------------------------------------------------------- connection */

// Which gateway this app is pointed at and how that is going. One gateway at a
// time, because only one is ever loaded.
//
// `milestone` and `milestoneAt` are the loading cover's progress bar: the
// furthest stage this load has reached and when it got there. Held here rather
// than in the cover because the cover is torn down and rebuilt across a retry
// and the load is not -- see src/progress.js for what the pair means.
let connection = {
  gatewayId: null,
  phase: connectionState.IDLE,
  error: null,
  milestone: progress.START,
  milestoneAt: Date.now(),
};

function setConnection(patch) {
  connection = { ...connection, ...patch };
  notifyStateChanged();
}

/**
 * Record that the load reached a stage, if it is actually further than the last.
 *
 * Forward-only, because these events do not arrive in a clean order: the Control
 * UI routes on load, so its in-page navigation fires `did-start-navigation`
 * after `dom-ready`, and taking that at face value walks the bar backwards.
 */
function reachMilestone(milestone) {
  if (connection.phase !== connectionState.CONNECTING) return;
  if (!progress.isAhead(milestone, connection.milestone)) return;
  setConnection({ milestone, milestoneAt: Date.now() });
}

/**
 * Show Settings as the window's own content rather than as a modal over it.
 *
 * One situation needs this now: a first run, where there is no gateway to lay a
 * modal over and nothing to connect to. A failed connection used to come here
 * too, it raises a notice instead, and leaves the window where it was.
 *
 * @param {{firstRun?: boolean}} [opts]
 */
function showSettingsAsPage(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  settingsIsPage = true;
  // Our own page is what this view holds from here, so there is no payload to fall
  // back to until a gateway answers again.
  payloadGateway = null;
  if (attemptView && !attemptView.webContents.isDestroyed()) destroyGatewayView(attemptView);
  // A modal of the same page over the top of itself is not an improvement.
  // Not animated: this surface is not going away so much as being REPLACED as the
  // window's own content on the next line, and a fade would be a hundred
  // milliseconds of nothing in the middle of a page load.
  closeOverlay('settings', { animate: false });
  page()?.loadFile(path.join(UI_DIR, 'settings.html'), {
    search: overlaySearch({ firstRun: opts.firstRun, page: true }),
  });
}

/**
 * A connection failed, so say so without moving anyone.
 *
 * Two screens have held this job before: a dedicated error page whose whole
 * content was one sentence and two buttons, and then Settings itself. Both take
 * the window away from someone who did not ask to leave it, and both make the
 * failure a *place*, somewhere you now are and have to get back out of.
 *
 * It is a condition instead. The notice slides down from the top, stays until
 * the gateway answers or the reader dismisses it, and offers the one link worth
 * offering. The window keeps showing the loading cover it was already showing
 * while the connect was in flight, now in its stopped state.
 *
 * THE COVER GOES UP HERE, always, and that is the rule rather than a detail: a
 * failure means this client has no connection, and a client with no connection
 * may not present a gateway view. It used to have a way to be told not to, for the
 * case where an attempt failed beside a document that was already on screen -- the
 * document was left there and only the notice was shown. That left the reader
 * looking at the gateway they were last connected to while nothing was connected,
 * which is a worse fault than the one it avoided: the screen said authenticated
 * and working, and neither was true. A failed attempt now ends the hold too; see
 * the failure handler in createGatewayView.
 *
 * The cover is already up from the connect attempt in the common case, so this
 * usually re-asserts it and moves it to its stopped state.
 */
function showConnectionFailure(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const gw = config.activeGateway();
  const label = gw ? gw.label || gw.url : null;
  console.warn(`[claw-desktop] cannot reach ${label || 'the gateway'}: ${detail.errorCode} ${detail.errorDescription}`);
  connection = {
    gatewayId: gw ? gw.id : null,
    phase: connectionState.nextPhase(connection.phase, { type: 'failed' }),
    error: { code: detail.errorCode, description: detail.errorDescription || '' },
  };
  // A load that never reached a page is a network/host failure, not pairing: the
  // gateway did not get far enough to refuse the device. Kept distinct so the
  // pairing screen does not appear for a dropped connection, exactly as the phone
  // keeps them apart in WebView.report().
  pairingState.failed();
  setNotice('connection', connectionState.failureNotice({ label, error: connection.error }));
  // Already up from the connect attempt; this re-asserts it for the case where
  // the very first load failed before anything covered the window, and for an
  // attempt that failed beside a document, where no cover was raised for it.
  showLoadingCover();
  // One last push so the bar lands on the stage the load genuinely reached, then
  // stop: nothing is progressing, and a line of jokes still cycling under a dead
  // connection reads as an app that has not noticed.
  pushProgress();
  stopProgressTicker();
  notifyStateChanged();
}

/* -------------------------------------------------------------- main window */

// The Control UI token handoff (build the URL with the token on the `#token=`
// fragment) lives in the shared core now, so desktop and the iOS client hand a
// credential over identically. See core/gateway-url.js for the why; it is
// imported as withTokenHandoff at the top of this file.

/**
 * Whether a document may be on screen while an attempt is made.
 *
 * * ONE RULE, TWO CALLERS. The attempt raises the cover before its identity probe
 * when this is false (see loadActiveGateway) and decides whether the load happens
 * in place or beside the document already on screen when it is true (see
 * beginGatewayConnect), so the two halves read the same answer rather than one
 * restating the other's rule.
 *
 * connectionState.mayPresentGatewayView owns the rule: the document must belong to
 * the gateway being connected and the connection it belongs to must not have
 * failed. The two cases it refuses are both measured faults -- a document from
 * ANOTHER gateway held through the attempt, and a document belonging to a
 * connection that has already failed.
 */
function mayPresentPayload(gw) {
  return Boolean(connectionState.mayPresentGatewayView({
    gatewayId: gw.id,
    heldGatewayId: payloadGateway,
    phase: connection.phase,
  }) && pageView && !pageView.webContents.isDestroyed());
}

function loadActiveGateway() {
  const gw = config.activeGateway();  if (!gw) {
    // Nothing to lay a modal over, so settings *is* the window's content. Also
    // the only thing that makes the window paintable at all on a first run:
    // `ready-to-show` never fires for a window that was never asked to load
    // anything, so without this the app would sit in the tray, invisible.
    setConnection({ gatewayId: null, phase: connectionState.IDLE, error: null });
    showSettingsAsPage({ firstRun: true });
    return null;
  }
  // IDENTIFY, THEN CONNECT. The address is checked before anything is pointed at
  // it, which is the difference between telling a reader their address is not an
  // OpenClaw gateway and showing them whatever that address happens to serve.
  //
  // Asynchronous while this function is not, because a probe is a network round
  // trip and the two callers that matter (a launch, and the pairing cadence's
  // retries) both want the answer rather than a blocking pause. The gateway is
  // re-read when the probe lands: a reader who changed gateway or left Settings
  // while it was in flight must not be connected to the one they were on.
  //
  // * AND THE COVER COMES UP BEFORE THE PROBE, NOT AFTER IT. A probe is a network
  // round trip with its own timeout, and until either the cover or the gateway's
  // page is on the window there is nothing to paint: the window is a rectangle of
  // its own background colour. Raising the cover only in beginGatewayConnect left
  // the whole probe as a black window, and when the probe REFUSED, no cover was
  // raised at all -- so the app sat there black, with nothing on screen to act on
  // and nothing saying it was trying. Abi, 2026-09-20: "I'm also seeing black
  // pages". Whether a cover may go up at all is not restated here: it is the same
  // rule beginGatewayConnect uses, so a reconnect beside a document already on
  // screen still does not blink it.
  if (!mayPresentPayload(gw)) showLoadingCover();
  void identifyBeforeConnect(gw).then((ok) => {
    if (!ok) return;
    const current = config.activeGateway();
    if (!current || current.id !== gw.id || current.url !== gw.url) {
      console.log(`[claw-desktop] the active gateway changed while ${gw.url} was being identified; not connecting`);
      return;
    }
    beginGatewayConnect(gw);
  });
  return gw;
}

/**
 * The connect itself, once the address is known to be an OpenClaw gateway.
 *
 * Split from `loadActiveGateway` only so the identification can happen first and
 * asynchronously; everything below is the attempt it always was.
 */
function beginGatewayConnect(gw) {
  settingsIsPage = false;
  autofilled = false;
  // Re-seed the appearance from the gateway being switched TO, before anything
  // of ours is painted: the cover is created a few lines down, and a window
  // painted in the previous gateway's colours and corrected a moment later is
  // the flip this whole arrangement exists to avoid. A gateway with nothing
  // stored keeps the appearance we are already in rather than resetting to a
  // default, and the page's own report moves it if that gateway differs.
  applyStoredTheme(gw.id);
  // The previous failure is over the moment a new attempt starts. Leaving it up
  // would have the banner reporting a dead error against a live connect.
  clearNotice('connection');
  // Back to the start of the bar. A retry that inherited the last attempt's
  // milestone would open at 78% and go nowhere.
  setConnection({
    gatewayId: gw.id,
    // Through the shared reducer rather than straight to CONNECTING, so an
    // attempt issued while the device is unapproved HOLDS the pending phase: the
    // pairing cadence reissues this every few seconds, and a row that dropped to
    // "Connecting..." on each beat and back again is the flicker this prevents.
    phase: connectionState.nextPhase(connection.phase, { type: 'connect' }),
    error: null,
    milestone: progress.START,
    milestoneAt: Date.now(),
  });
  // A connect attempt is starting, so the pairing state hears about it too. Two
  // cases, and core/pairing.js decides which: a first connect clears any earlier
  // refusal, while a retry from the pairing screen HOLDS the screen and its
  // refusal, so the command on it does not change and the attempt happens
  // underneath. This is the anti-flap rule, and it is why the retry cadence does
  // not make the screen flash once per attempt.
  pairingState.connecting();
  // Raised before the load rather than after, because the whole point is to
  // cover the gap: a `loadURL` to an unreachable host leaves the previous
  // document, or a blank view, on screen for as long as it takes to fail.
  //
  // Unless a document may still be shown, which is the same sentence read the
  // other way: there is nothing there to cover but the reader's current place, and
  // the attempt is made beside it instead (see createGatewayView). A cover raised
  // on every retry would also blink the window the whole time a gateway is
  // restarting.
  //
  // WHAT MAY BE SHOWN IS ONE RULE, not a decision taken here: the document must
  // belong to the gateway being connected and the connection it belongs to must
  // not have failed. `mayPresentGatewayView` owns it, and the two cases it refuses
  // are both measured faults -- a document from ANOTHER gateway held through the
  // attempt, and a document belonging to a connection that has already failed.
  const hasPayload = mayPresentPayload(gw);
  if (!hasPayload) {
    // From here nothing on screen may be presented, so the view's own record of
    // what it holds goes with it: whatever it has is covered now, and only a load
    // that finishes puts a document back in its place.
    payloadGateway = null;
    showLoadingCover();
  }
  const creds = secrets.load(gw.id);
  const supplied = [creds.token && 'token', creds.password && 'password', creds.headers.length && `${creds.headers.length} header(s)`]
    .filter(Boolean).join(', ');
  console.log(`[claw-desktop] connecting to ${gw.label || gw.url} <${gw.url}>${supplied ? ` (supplying ${supplied})` : ''}`);
  const url = withTokenHandoff(gw.url, creds.token);
  // A payload on screen is never navigated away from just to find out whether a
  // fresh one exists: see createGatewayView for what a failed navigation does to
  // the frame. So the attempt happens off to the side and is swapped in only if it
  // loads.
  if (hasPayload) {
    startGatewayAttempt(gw, url);
    return;
  }
  // The page view takes the load itself: an error document with no attempt beside
  // it, and the cover above it either way.
  pageReloading = true;
  page()?.loadURL(url, FRESH_DOCUMENT);
}

// The server's payload rather than a cached copy of it, on the one load the app
// cannot know the answer to.
//
// A launch is when the profile may hold a service worker and an HTTP cache from
// a build the gateway has since replaced, and the Control UI's own worker is
// cache-first under `/assets/` by design. What must not happen is this app
// PAINTING an old Control UI on the way in, and a cached DOCUMENT is exactly
// that: it renders the previous payload, references the previous asset URLs, and
// looks perfectly correct while being yesterday's product.
//
// Measured 2026-09-16, against a marker gateway serving two distinguishable
// payloads and read off the DOM (see scripts/test-payload-freshness.js). With the
// document served `Cache-Control: no-cache`, which is what OpenClaw's gateway
// sends (src/gateway/control-ui.ts), a launch after an upgrade painted the NEW
// payload and never the old one. With the document cacheable, the SAME launch
// painted the old payload first and the new one 76ms later, once the build-id
// refresh below had dropped the worker's caches and reloaded. That first paint is
// the defect: it is the pre-loaded Control UI Abi ruled out, and how long it lasts
// is the gateway's caching policy rather than ours.
//
// So the document request revalidates. That is the whole fix: the document decides
// which asset URLs the page wants, and upstream's asset names are content-hashed,
// so a fresh document cannot pull a stale bundle with it. The worker's caches are
// still dropped by maybeRefreshForNewBuild when the gateway's build id moved,
// which a document request cannot see, and an asset served from a FIXED url is
// still the worker's to hold until that clear, which upstream does not do.
const FRESH_DOCUMENT = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache' };

/* --------------------------------------------------------------- stale cache */

// The Control UI is a PWA whose service worker serves /assets/ cache-first. A
// browser re-checks sw.js on navigation, which is normally often enough, but
// this app closes to tray rather than quitting, so its document can sit there
// for weeks without one, still controlled by the worker an old gateway
// installed. What that looks like is an app that keeps showing yesterday's
// Control UI after the gateway has been upgraded under it.
//
// Three ways out, in order of how little the user has to notice:
//   - the gateway's build id changed since the last load   -> clearAndReload
//   - this app was upgraded since the last run             -> clearOnAppUpgrade
//   - neither, but it still looks wrong                    -> the menu/tray item
//
// All three route through cache.clear(), which drops caches and *only* caches;
// see src/cache.js for why that boundary is load-bearing.

function gatewayOrigins() {
  return config.get().gateways.map((g) => originOf(g.url)).filter(Boolean);
}

function forgetBuildIds(origins) {
  const next = { ...config.get().swVersions };
  for (const origin of origins) delete next[origin];
  config.update({ swVersions: next });
}

// Set while a reload we triggered ourselves is in flight, so the probe on that
// load is skipped. Not a loop guard, the new build id is recorded *before* the
// reload, so a second pass would decide `unchanged` anyway, just a way to
// avoid re-probing a page we already know the answer for.
let selfReloading = false;

/**
 * Read the gateway's Control UI build id and, if it moved, drop the caches and
 * reload. Called after every successful load of a gateway page.
 */
async function maybeRefreshForNewBuild(wc) {
  if (selfReloading) { selfReloading = false; return; }
  const origin = activeOrigin();
  if (!origin || !wc.getURL().startsWith(origin)) return;

  let source = null;
  try {
    source = await wc.executeJavaScript(cache.SW_SOURCE_PROBE, true);
  } catch {
    // A page that refuses the probe (navigated away mid-flight, no service
    // worker, not a Control UI at all) is not an error worth surfacing: the
    // manual command still covers it.
    return;
  }

  const version = cache.parseServiceWorkerVersion(source);
  const seen = config.get().swVersions[origin] || null;
  const decision = cache.decideRefresh(seen, version);
  if (decision.action === 'none') return;

  // Record first, unconditionally. If clearing or reloading then fails, the
  // worst case is that this upgrade is not auto-cleared; recording afterwards
  // would instead retry the clear on every single load.
  config.update({ swVersions: { ...config.get().swVersions, [origin]: version } });
  if (decision.action === 'record') return;

  console.log(`[claw-desktop] control ui build changed at ${origin} (${seen} -> ${version}); clearing cache`);
  selfReloading = true;
  await cache.clear(session.defaultSession, [origin]);
  loadActiveGateway();
}

/**
 * Manual escape hatch, on the File menu and the tray. Clears the active
 * gateway's caches, or every gateway's, if none is active, which is the case
 * on the error page where this is most likely to be reached for.
 */
async function clearCacheAndReload() {
  const gw = config.activeGateway();
  const active = activeOrigin();
  const origins = active ? [active] : gatewayOrigins();
  console.log(`[claw-desktop] clearing cache for ${origins.join(', ') || '(no gateway)'}`);
  const results = await cache.clear(session.defaultSession, origins);
  // Drop the recorded ids too, so the load that follows records what it finds
  // instead of comparing against a build whose cache no longer exists.
  forgetBuildIds(origins);
  // The next gateway load is the one the reader asked for, so it is the one that
  // reports back to whoever asked. Recorded BEFORE the load is started, because
  // the load can finish faster than the line after it runs.
  clearedLoadPending = true;
  loadActiveGateway();

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    origins,
    // What was actually cleared, per origin, so the reader is told the effect
    // rather than the intention: a step that refused is reported as refused.
    cleared: results.filter((r) => r.ok).map((r) => r.origin),
    failed: failed.map((r) => ({ origin: r.origin, error: r.error })),
    // The kinds of cache this drops, named for the reader rather than for the API.
    kinds: [...cache.CACHE_STORAGES],
    reloading: true,
    gateway: gw ? { label: gw.label || gw.url, url: gw.url } : null,
  };
}

// Set when the reader presses Clear cache and refresh, cleared by the first
// gateway load that lands afterwards. Its whole job is that confirmation: the
// About box says "Reloading..." and can then say the reload really happened,
// rather than assuming a load that was asked for is a load that arrived.
let clearedLoadPending = false;

/**
 * Tell the About box that the reload it asked for has landed.
 *
 * Sent from the load that finishes rather than from the press, and that is the
 * only honest place to send it from: `loadActiveGateway` starts an off-screen
 * attempt when a document is already on screen, so the clear returning is not the
 * same event as the fresh payload arriving. A message that said "reloaded" when
 * the clear returned would be the app asserting something it had not seen.
 */
function notifyCacheCleared(ok, detail) {
  const view = overlayViews.get('about');
  if (view && !view.webContents.isDestroyed()) view.webContents.send('app:cache-cleared', { ok, detail });
}

/**
 * Identify the installed build.
 *
 * Prefers the commit stamped in at pack time, which is what a build actually
 * is. Failing that, a source run, or a build made from a dirty tree, it stats
 * the app bundle (`app.asar` when packaged, the project directory in
 * development), because the semver alone does not move between builds. See
 * cache.buildFingerprint. A stat that fails degrades to the version, which
 * simply means this particular upgrade is not detected; it must never throw and
 * take startup with it.
 */
function appBuildId() {
  const version = app.getVersion();
  const commit = buildInfo.buildId(buildStamp);
  if (commit) return cache.buildFingerprint({ version, commit });
  try {
    const stat = fs.statSync(app.getAppPath());
    return cache.buildFingerprint({ version, size: stat.size, mtimeMs: stat.mtimeMs });
  } catch {
    return version;
  }
}

/**
 * Clear once on the first run after an app upgrade, before anything loads.
 *
 * A new build brings a new Electron and a new preload; leaving a worker from
 * the previous one in place is the same staleness by a different route. A
 * profile with no recorded build is a fresh install, not an upgrade.
 */
async function clearOnAppUpgrade() {
  const previous = config.get().appBuild;
  const current = appBuildId();
  if (previous === current) return;
  config.update({ appBuild: current, swVersions: {} });
  if (!previous) return;
  console.log(`[claw-desktop] app build changed (${previous} -> ${current}); clearing web cache`);
  await cache.clear(session.defaultSession, gatewayOrigins());
}

/* --------------------------------------------------------------- login gate */

// Password mode has no URL handoff, the Control UI parses only `gatewayUrl`,
// `token` and `bootstrapToken`, and its docs are explicit that "passwords stay
// in memory only". So the one way to avoid a manual paste is to fill the login
// gate ourselves.
//
// This is deliberately best-effort and must stay that way: it depends on the
// Control UI's markup, which is not an API. It fills only empty fields, runs at
// most once per load, and if the gate never appears it simply does nothing, // the worst case is the login screen you would have seen anyway.
let autofilled = false;

function autofillScript(creds) {
  return `(() => {
    if (window.__clawDesktopAutofilled) return 'already';
    const creds = ${JSON.stringify({ token: creds.token, password: creds.password })};
    if (!creds.token && !creds.password) return 'nothing-to-fill';

    const setValue = (el, value) => {
      // Lit binds .value as a property, so assigning el.value alone leaves the
      // component's own state untouched. Go through the native setter and fire
      // the input event its @input handler is listening for.
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const attempt = () => {
      const form = document.querySelector('.login-gate__form');
      if (!form) return false;
      // Field order in the gate: [0] gateway token, [1] gateway password.
      const fields = form.querySelectorAll('.settings-secret input');
      if (!fields.length) return false;
      const filled = [];
      if (creds.token && fields[0] && !fields[0].value) { setValue(fields[0], creds.token); filled.push('token'); }
      if (creds.password && fields[1] && !fields[1].value) { setValue(fields[1], creds.password); filled.push('password'); }
      if (!filled.length) return false;
      window.__clawDesktopAutofilled = true;
      const last = filled.includes('password') ? fields[1] : fields[0];
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    };

    // The gate renders only after the WebSocket handshake is refused, which is
    // after did-finish-load, so poll briefly rather than checking once.
    if (attempt()) return 'filled';
    const deadline = Date.now() + 10000;
    const tick = () => { if (attempt() || Date.now() > deadline) return; setTimeout(tick, 250); };
    setTimeout(tick, 250);
    return 'watching';
  })()`;
}

function maybeAutofill(wc) {
  if (autofilled) return;
  const gw = config.activeGateway();
  if (!gw || originOf(wc.getURL()) !== originOf(gw.url)) return;
  const creds = secrets.load(gw.id);
  if (!creds.token && !creds.password) return;
  autofilled = true;
  wc.executeJavaScript(autofillScript(creds), true)
    .then((result) => console.log(`[claw-desktop] login gate autofill: ${result}`))
    .catch((err) => console.warn(`[claw-desktop] login gate autofill failed: ${err.message}`));
}

/* ------------------------------------------------------------ device pairing */

// The gateway's second gate, after the token check, finally surfaced here.
//
// The page opens the gateway socket, so a refusal for an unapproved device is an
// event INSIDE the page rather than a navigation failure: the HTML loads fine,
// `did-finish-load` fires, this app marks the connection CONNECTED, and the
// socket is closed 1008 behind it. Nothing in the desktop's world could see that,
// so the app sat on a dead page with no explanation. The phone has had a pairing
// screen since 366184d; the desktop had none, which is why a device whose
// approval was revoked server-side (the gateway closes the established session
// `4001 device removed`, then refuses the next connects 1008) showed nothing at
// all, at any point in the app's life.
//
// Three pieces, all shared-contract-driven, none of them a second copy of the
// rules (see src/pairing.js):
//   - the observer bytes from core/spec/pairing.json, injected into the page at
//     document START so it wraps WebSocket before the page opens one;
//   - the report that comes back, narrowed through the contract before anything
//     is shown;
//   - the shared reducer's phase moves, plus a reload cadence and a settle
//     window while the screen is up.
//
// The injection is the one piece with no plain Electron equivalent, and it is
// the piece that shipped broken. The first version reached for CDP's
// `Page.addScriptToEvaluateOnNewDocument` through `webContents.debugger`: it
// registered, it logged that it registered, and the script never ran. Measured
// here, both ways. The debugger's page domain does not answer until the
// webContents has a live renderer, so a registration fired before the first
// navigation is queued and lands on the wrong side of the document it was meant
// to precede. And a registration that DOES resolve belongs to the target it was
// sent to, so it missed the next document even on a plain reload: the page came
// back with `injected:false` and a native `WebSocket` both times, which is the
// refusal disappearing with nothing to report it.
//
// What holds is the preload. `webFrame.executeJavaScript` called from that
// page's own preload runs in the MAIN world at document start (measured: the
// injected marker landed before the document's first inline script, with the
// contextBridge surface already visible to it), and it is not subject to the
// page's CSP because it evaluates rather than inserting a script element. The
// isolated world still cannot reach it, so the page gains no call it did not
// have. src/preload.cjs owns that half now, and this side only owns the bytes:
// the preload reads them over the synchronous `pairing:script` channel below.

const pairingState = pairing.createState({
  onRetry: () => retryPairingConnect(),
  // Every phase move repaints the screen, INCLUDING the one the settle window
  // makes with no other caller. Without this the recovery is invisible: measured
  // live, an approval landed, the socket stayed open, the gateway was serving the
  // Control UI, and the pairing screen sat over it with nothing to take it down.
  //
  // The came-down line is kept here rather than in the report handler for the
  // same reason: the recovery has two routes (an approval confirmed by the settle
  // window, or a report that never was pairing), and only one of them passes
  // through a report. One place sees both.
  onChange: () => {
    const pairingNow = pairingState.isPairing();
    if (pairingWasUp && !pairingNow) console.log('[claw-desktop] device pairing cleared; the pairing screen is down');
    pairingWasUp = pairingNow;
    syncPairing();
  },
});

/** The last phase's pairing flag, so the change can be logged once, where it happens. */
let pairingWasUp = false;

/**
 * The observer bytes, read by the preload at document start.
 *
 * Synchronous on purpose. The preload runs at document start, which is the only
 * moment early enough to wrap `WebSocket` before the page opens one, and an
 * async read would come back a tick later, after the page's own first script had
 * already run. The reply is two short strings, once per document, so blocking
 * that one tick is the cheap side of the trade; see the pairing section of
 * src/preload.cjs for the half that does the injecting.
 *
 * Registered at import time rather than from registerIpc(), because the first
 * page load can begin before the app's own IPC table is built, and a preload
 * that asked too early would get no reply at all.
 */
ipcMain.on('pairing:script', (event) => {
  event.returnValue = pairing.injectedSources();
});

/**
 * The preload's word that the injection ran, which is the only proof of it.
 *
 * A registration that silently does nothing is exactly how this shipped broken
 * once, so the line is logged either way: the app's own stdout says whether the
 * observer is in the page, and it is the line to read when a pairing refusal
 * does not surface.
 */
ipcMain.on('pairing:injected', (_event, report) => {
  if (report && report.ok) {
    console.log('[claw-desktop] pairing observer installed (document start)');
    return;
  }
  console.warn(`[claw-desktop] pairing observer did not install (${(report && report.error) || 'no reason given'}); a pairing refusal will not surface`);
});

/**
 * The app frame inset's bytes, read by the preload at document start.
 *
 * Synchronous for the same reason the observer's are: the preload runs before the
 * page has a document, and an async read would come back after the page's own first
 * script, which is exactly the frame the rule has to precede.
 *
 * What the numbers ARE is the part of the page's viewport our chrome occupies, and on
 * this client it is small on purpose. The title strip is not in there at all: the page
 * view is a child view placed BELOW the strip, so the strip cannot be painted over and
 * contributes nothing. What the page genuinely cannot see is the notice band, which is
 * drawn over the page's own top-trailing corner as a separate view. That is what this
 * publishes, and it publishes zeros rather than omitting them, so the page's own value
 * is replaced by "nothing" rather than left in place.
 */
function frameInsets() {
  const band = bannerView && !bannerView.webContents.isDestroyed() ? Math.max(0, bannerSize.height) : 0;
  return { top: band, bottom: 0 };
}

ipcMain.on('frame:inset-script', (event) => {
  event.returnValue = appFrameInset.installation(frameInsets());
});

/**
 * The preload's word that the frame was published, for the same reason the
 * observer's is logged: a silent non-installation is how that shipped broken once,
 * and a full-bleed Control UI surface painting across our own notice band is the
 * shape of this one.
 */
ipcMain.on('frame:injected', (_event, report) => {
  if (report && report.ok) {
    console.log('[claw-desktop] app frame inset installed (document start)');
    return;
  }
  console.warn(`[claw-desktop] app frame inset did not install (${(report && report.error) || 'no reason given'}); a full-bleed Control UI surface can paint across our own notice band`);
});

/**
 * What the pairing screen renders: the state, plus the copy the contract owns.
 *
 * The page is sandboxed and cannot require core/pairing.js, the same split the
 * settings, About and loading pages use, so the requirement sentence and the
 * approve command arrive already built. The device row names the machine this
 * build is on, which is what an operator lines up against `openclaw devices
 * list`; the request id beside it is the thing they actually match.
 */
function pairingSnapshot() {
  const snap = pairingState.snapshot();
  return {
    phase: snap.phase,
    requestId: snap.requestId,
    requirement: snap.requirement,
    command: snap.command,
    device: os.hostname(),
    title: PAIRING_COPY.title,
    body: PAIRING_COPY.body,
    commandLabel: PAIRING_COPY.commandLabel,
    requestIdLabel: PAIRING_COPY.requestIdLabel,
    deviceIdLabel: PAIRING_COPY.deviceIdLabel,
    waiting: PAIRING_COPY.waiting,
    cannotRunHere: PAIRING_COPY.cannotRunHere,
    docsHref: PAIRING_COPY.docsHref,
  };
}

/**
 * Put the screen up, take it down, or repaint it, from the phase alone.
 *
 * Called after every move, so the screen cannot get ahead of the state: while
 * the phase is pairing-required the screen is up (opened here if it is not), and
 * the moment the phase leaves it the screen goes. Auto-recovery needs no button
 * of its own because of this: an approval produces a socket that survives, the
 * phase moves to authenticated, and the screen comes down on its own.
 */
function syncPairing() {
  const snap = pairingState.snapshot();
  const wasPairing = pairingWasUp;

  // The gateway row's phase follows the same state the screen does, which is what
  // keeps the two from describing one connection differently: an unapproved device
  // is `pending` (the page loaded, the gateway is holding the session), and a
  // socket that survived its settle window CONFIRMS the connect. Both moves are
  // core/connection.js's, and only a real change is pushed, so a retry that moved
  // nothing cannot re-render the row.
  const next = connectionState.nextPhase(connection.phase, { type: snap.pairing ? 'pending' : 'confirm' });
  if (next !== connection.phase) setConnection({ phase: next });

  if (snap.pairing) {
    if (!overlayAlive('pairing')) openOverlay('pairing');
    else notifyPairingChanged();
    // A REVOCATION is not a setup problem, so it does not stop at the pairing
    // screen: a session that was working and has had its approval withdrawn needs
    // the gateway row that now says the device needs approval, and the address it
    // is pointed at, which is what the settings surface is for. Routed ONCE, on
    // the entry, so closing settings while still revoked does not drag it back;
    // the rule and the tab come from the shared contract, and the pairing screen
    // is still there behind this for the approve command.
    if (!wasPairing && snap.route === ROUTE_SETTINGS_GATEWAYS) {
      console.warn('[claw-desktop] this device has had its approval revoked; opening settings on the gateway list');
      openSettings({ tab: ROUTE_SETTINGS_TAB });
    }
    return;
  }
  if (overlayAlive('pairing')) closeOverlay('pairing');
}

/** Push a fresh pairing state into the screen if it is up. */
function notifyPairingChanged() {
  const view = overlayViews.get('pairing');
  if (view && !view.webContents.isDestroyed()) view.webContents.send('app:pairing-changed');
}

/**
 * One reconnect beat while the pairing screen is up.
 *
 * The page's own socket retry cannot be relied on: observed against the live
 * gateway, the Control UI stopped reattaching a few seconds after the refusal,
 * so an approval that landed afterwards produced no reconnect at all. So this
 * drives the attempt, and it drives it through the app's OWN connect path rather
 * than a bespoke one, which is what makes an approval pick up with no relaunch
 * and no reimplementation of the page's connect. The cadence comes from the
 * shared spec. `connecting()` is the anti-flap rule: while the screen is up it
 * holds the phase, so the attempt happens underneath a screen that never moves.
 */
function retryPairingConnect() {
  if (!pairingState.isPairing()) return;
  pairingState.connecting();
  console.log('[claw-desktop] pairing: retrying the connect');
  loadActiveGateway();
}

/**
 * The page's own socket closed, and the gateway did not refuse it.
 *
 * This app holds no socket of its own: the Control UI opens one inside the page,
 * so the only signal that a working session has ended is the page's own socket
 * closing, reported by the observer (see core/spec/pairing.json's `socketClosed`).
 * Before this, nothing on this side could see it, and the app went on presenting
 * the gateway's Control UI -- authenticated, complete, and connected to nothing --
 * for as long as the reader looked at it. Measured: nine seconds of a dropped
 * gateway with the payload untouched on screen, and no notice either.
 *
 * So the hold ends and the app's own surface takes the screen, which is the same
 * outcome as a failed load and the same rule: a client with no connection does
 * not present a gateway view.
 *
 * GUARDED ON THE PHASE, and both halves of that guard are load-bearing:
 *
 *   - `connected` only. Every other phase is either an attempt in flight or a
 *     surface of ours already up, and a close arriving there is not news.
 *   - not while this app is itself replacing the document (see `pageReloading`),
 *     because a reload tears the old document's socket down and that close is our
 *     own doing rather than the connection ending.
 */
function handleSocketDropped() {
  if (connection.phase !== connectionState.CONNECTED) return;
  if (pageReloading) return;
  console.warn('[claw-desktop] the gateway closed the connection; showing the failure surface');
  payloadGateway = null;
  // Recorded so the OTHER half of this can happen: a socket that opens again on
  // its own means the gateway is back, and this app has no business sitting on its
  // failure screen while the page behind it is connected again.
  socketDropped = true;
  showConnectionFailure({ errorCode: null, errorDescription: 'The gateway closed the connection.' });
}

/**
 * A report from the page's observer, or nothing.
 *
 * The sender is checked against the live gateway page, so only the page this
 * app loaded can move this state; then the payload is narrowed through the
 * contract. The transition is logged with the request id, because that line and
 * the gateway's own are the two halves of any diagnosis of this.
 */
function handlePairingReport(event, payload) {
  const wc = page();
  if (!wc || event.sender !== wc) return;
  const report = pairing.parseReport(payload);
  if (!report) return;

  if (report.kind === 'dropped') {
    handleSocketDropped();
    return;
  }

  if (report.kind === 'open') {
    pairingState.opened();
    // The recovery leg of a drop: the page's socket is open again, so the gateway
    // is reachable and the failure surface is no longer true. Reconnected through
    // the app's own connect path rather than by uncovering the document that was
    // already there, and that is deliberate: only a load that FINISHED proves the
    // document on screen is the gateway's -- Chromium commits an error document for
    // the same URL -- and the page may have been replaced or reloaded while the
    // cover was up. A load that fails leaves the failure surface exactly as it was.
    if (socketDropped) {
      socketDropped = false;
      console.log('[claw-desktop] the gateway socket is open again; reconnecting');
      loadActiveGateway();
    }
  } else {
    pairingState.closed(report.refusal);
    console.warn(`[claw-desktop] gateway refused this device: ${report.refusal.reason}` +
      `${report.refusal.requestId ? ` (requestId: ${report.refusal.requestId})` : ''}; showing the pairing screen`);
  }
  // The screen and the recovery line both follow the phase through createState's
  // onChange, so there is nothing to do here but record what the page said.
}

function attachNavigationGuards(wc) {
  // A link to anywhere other than the gateway belongs in the real browser. Without
  // this, one click on an external link replaces the app with a page that has no
  // back button and no address bar.
  wc.setWindowOpenHandler(({ url }) => {
    if (originOf(url) === activeOrigin()) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          minWidth: defaults.minWindow.width,
          minHeight: defaults.minWindow.height,
          backgroundColor: currentTheme.surface,
          autoHideMenuBar: true,
          webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    const target = originOf(url);
    if (target === activeOrigin() || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  attachContextMenu(wc);
}

// Electron ships no default context menu; without this you cannot even
// right-click → Paste into the composer, or into the settings page's token and
// URL fields, which is the one place a paste is genuinely likely.
function attachContextMenu(wc) {
  wc.on('context-menu', (_event, props) => {
    const menu = new Menu();
    const { editFlags, isEditable, selectionText } = props;
    if (isEditable || selectionText) {
      menu.append(new MenuItem({ role: 'cut', enabled: editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: editFlags.canPaste }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    }
    if (props.linkURL && /^https?:/.test(props.linkURL)) {
      if (menu.items.length) menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Open link in browser', click: () => shell.openExternal(props.linkURL) }));
      menu.append(new MenuItem({ label: 'Copy link address', click: () => clipboard.writeText(props.linkURL) }));
    }
    if (menu.items.length) menu.popup();
  });
}

/* --------------------------------------------------------------- title strip */

/**
 * The strip the app draws above the page, carrying the window buttons.
 *
 * Deliberately inert: no preload, no IPC bridge, no script (its CSP forbids
 * one). It is a coloured, draggable band with a label, and the label is written
 * in from here, the one place that knows which session is loaded. Giving it a
 * bridge would mean a second privileged page for no gain.
 */
function createStrip() {
  if (chrome.contentInset().top === 0) return null;
  stripView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  stripView.setBackgroundColor(currentTheme.surface);
  mainWindow.contentView.addChildView(stripView);
  const wc = stripView.webContents;
  wc.loadFile(path.join(UI_DIR, 'titlebar.html'));
  wc.once('did-finish-load', () => {
    wc.insertCSS(chrome.stripCss()).catch(() => {});
    applyThemeCss(wc);
  });
  return stripView;
}

/**
 * Put the current session's name in the strip, or fall back to the app name.
 *
 * `executeJavaScript` rather than IPC because the strip has no preload to route
 * a message through, and it is not subject to the page's CSP. The value is
 * JSON-encoded, so a session named `</script>` or `'); …` is inert text.
 */
function setStripLabel(session) {
  const wc = stripView && !stripView.webContents.isDestroyed() ? stripView.webContents : null;
  if (!wc) return;
  const text = session || chrome.APP_NAME;
  wc.executeJavaScript(
    `document.getElementById('label').textContent = ${JSON.stringify(text)};`,
    true,
  ).catch(() => {});
}

/**
 * A gateway page view: created and wired, and not yet navigated.
 *
 * Extracted from `createMainWindow` because a load attempt may have to be made in a
 * view nobody is looking at. A failed navigation commits Chromium's own error
 * document over whatever was in that frame, so an attempt made in the view on
 * screen DESTROYS the payload there, and by the time the failure is known there is
 * nothing left to fall back to. Measured 2026-09-16 against a marker gateway: after
 * a reconnect to a gateway that had stopped listening, the page's own markers read
 * null and the view's Cache Storage read empty, because the frame was no longer the
 * Control UI at all. See scripts/test-payload-freshness.js.
 *
 * So an attempt is loaded off to the side and swapped in only once it has actually
 * loaded, which is what makes "the server's payload when there is one, the one
 * already on screen when there is not" true by construction rather than by
 * predicting whether the gateway will answer.
 *
 * `attempt` changes two things, both about what a failure MEANS. A failure on the
 * view on screen is the app's failure surface, cover and all, exactly as it was. A
 * failure of an attempt is a fresh payload that does not exist: the attempt is
 * thrown away, the payload behind it is left alone, and the failure is reported
 * OVER that payload rather than in place of it.
 */
function createGatewayView({ attempt = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  view.setBackgroundColor(currentTheme.surface);
  const wc = view.webContents;
  attachNavigationGuards(wc);
  // The pairing observer needs no arming here: it is installed by this view's own
  // preload at document start, on the first document and every one after it. See
  // the device-pairing section below for why, and for the CDP route that looked
  // like it worked and did not.

  // The Control UI sets document.title to "<session>, OpenClaw", and Electron
  // mirrors a page title onto the window by default. That put the upstream name
  // in our taskbar entry and window title even after the rename, which is the
  // one place a user actually reads it. Keep the page's session name, it is
  // genuinely useful when several windows are open, but under our own name.
  //
  // The event fires on the view now, not the window, so the title has to be set
  // rather than merely amended: a view's title does not reach the window at all.
  const refreshTitle = () => {
    const label = chrome.pageLabel(wc.getTitle(), wc.getURL());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(chrome.windowTitle(label));
    setStripLabel(label);
  };
  wc.on('page-title-updated', refreshTitle);
  // Also on in-page navigation: the label depends on the route, not only on the
  // title, and the two do not always change together, nor in a fixed order, so
  // a title-only listener can read the previous URL.
  wc.on('did-navigate-in-page', refreshTitle);

  // The two stages between "asked" and "answered", which is all Chromium offers
  // and all the progress bar gets to work with. A navigation that commits means
  // the host replied; `dom-ready` means the document parsed. Subresources are
  // deliberately not tracked: the bar would then be waiting on fonts.
  wc.on('did-navigate', () => reachMilestone(progress.NAVIGATED));
  wc.on('dom-ready', () => {
    reachMilestone(progress.DOM);
    installPromptMetadata(wc);
    installAppSettingsAffordance(wc);
    // The window's own shell has parsed, so this boot has genuinely come up
    // whether or not a gateway then connects: advance the stage and clear the
    // crash-loop marker. bootReady is idempotent, so a later navigation's
    // dom-ready does no harm.
    reachBootStage('renderer-ready');
    bootReady();
  });

  wc.on('did-finish-load', () => {
    // The load this app asked for has finished, so a socket closing from here is
    // the gateway's doing again rather than ours. See `pageReloading`.
    pageReloading = false;
    // A load that finished means this app is looking at the gateway's document
    // again, which is the other end of a drop whatever put it there.
    socketDropped = false;
    wc.setZoomLevel(config.get().zoomLevel || 0);
    // Our own pages (settings as the window's content) want the Control UI's
    // design tokens. The gateway's page gets nothing injected at all.
    if (wc.getURL().startsWith('file://')) {
      applyThemeCss(wc);
      return;
    }
    // The gateway answered -- if it really did. Chromium commits an error
    // document for a failed main frame and that fires this too, so the phase
    // decides; see shouldMarkConnected in src/connection.js.
    if (connectionState.shouldMarkConnected({ phase: connection.phase, url: wc.getURL() })) {
      // An attempt that really answered takes the place of the view on screen, and
      // ONLY here: the swap happens on a loaded document rather than on the intent
      // to load one, which is what keeps a failed attempt from having already
      // destroyed the payload it was replacing.
      if (attempt) promoteGatewayView(view);
      // The document on screen is this gateway's from here, and it stays
      // presentable while this connection does. The phase move below is the other
      // half of that: `connectionState.mayPresentGatewayView` reads the two
      // together, and the failure handlers read the phase and clear this.
      payloadGateway = config.get().activeGatewayId;
      // Through the reducer, and the pending case is why: a page that loaded is
      // NOT the same as a gateway that accepted this device. An unapproved device
      // is served the page and then has its socket closed 1008, so this holds
      // `pending` rather than claiming Connected, which is what the row did while
      // the gateway was refusing the session. Only the socket surviving its
      // settle window confirms the connect; see syncPairing.
      setConnection({
        phase: connectionState.nextPhase(connection.phase, { type: 'connected' }),
        error: null,
        milestone: progress.DONE,
        milestoneAt: Date.now(),
      });
      // The gateway is on screen behind the cover, so the cover comes down and
      // any failure it was reporting is over. Both are keyed to the one event
      // that proves it -- a load that finished on a page that is not ours.
      clearNotice('connection');
      hideLoadingCover();
      // The reader asked for a reload from the About box, and this is the load that
      // answered it. Reported from the LOAD rather than from the press, because
      // the clear returning and a fresh payload arriving are two different events
      // here: with a document already on screen the attempt is made off to the
      // side, so "reloaded" said at the press would be the app asserting something
      // it had not seen yet.
      if (clearedLoadPending) {
        clearedLoadPending = false;
        notifyCacheCleared(true, `The Control UI reloaded from ${wc.getURL()}.`);
      }
    }
    maybeAutofill(wc);
    void maybeRefreshForNewBuild(wc);
  });

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!connectionState.isRealFailure({ code: errorCode, isMainFrame })) return;
    pageReloading = false;
    // A reload the reader asked for from the About box that then failed is told to
    // them there, rather than left as a box still saying "Reloading...": a
    // confirmation that never arrives looks the same as one that was never asked
    // for, and the reader would be left waiting on a page that is not coming.
    if (clearedLoadPending) {
      clearedLoadPending = false;
      notifyCacheCleared(false, `The cache was cleared, but the Control UI did not reload: ${errorDescription || `error ${errorCode}`}.`);
    }
    // The connection this app was showing is over, whichever view failed, so the
    // hold ends: a failed attempt must not leave the document it was going to
    // replace on screen, and the visible view's failure must not either. Without
    // this the reader keeps the previous gateway in front of them while nothing is
    // connected, which is the one screen worse than no screen. The cover goes up
    // from showConnectionFailure, over whatever the view still holds.
    payloadGateway = null;
    if (attempt) {
      // Throw the attempt away now rather than at its own failure handler below,
      // so nothing can promote a document that failed to load.
      destroyGatewayView(view);
    }
    showConnectionFailure({ errorCode, errorDescription, url: validatedURL });
  });

  wc.on('render-process-gone', (_e, details) => {
    payloadGateway = null;
    if (attempt) destroyGatewayView(view);
    showConnectionFailure({
      errorCode: details.reason,
      errorDescription: `The window stopped responding (${details.reason}).`,
    });
  });

  return view;
}

/**
 * Put a loaded attempt in the window, and throw away what it replaces.
 *
 * Added and then restacked, so the cover, the overlays and the banner keep the
 * order they are supposed to have rather than the new view landing over a modal.
 */
function promoteGatewayView(view) {
  const previous = pageView;
  pageView = view;
  attemptView = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(view);
    restackViews();
    layoutViews();
  }
  if (previous && previous !== view) destroyGatewayView(previous);
}

/** Throw a view away: off the window, and its contents closed. */
function destroyGatewayView(view) {
  if (!view) return;
  if (attemptView === view) attemptView = null;
  themeCssKeys.delete(view.webContents.id);
  try { mainWindow?.contentView.removeChildView(view); } catch { /* window already gone */ }
  // Detaching is the part that unblocks things, so nothing after it may throw:
  // this runs on the crash path too, where the contents are already gone.
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already torn down */ }
}

/**
 * Load a fresh payload beside the one on screen.
 *
 * One attempt at a time: a second while the first is in flight would leave the
 * older one to be promoted after the newer had already been decided, and the pair
 * would race for the same slot.
 */
function startGatewayAttempt(gw, url) {
  if (attemptView && !attemptView.webContents.isDestroyed()) destroyGatewayView(attemptView);
  const view = createGatewayView({ attempt: true });
  attemptView = view;
  console.log(`[claw-desktop] loading ${gw.label || gw.url} beside the payload on screen; a failure ends that payload's stay rather than leaving it up`);
  view.webContents.loadURL(url, FRESH_DOCUMENT);
}

function createMainWindow() {
  const cfg = config.get();
  configureSession(session.defaultSession, config.activeGateway());

  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    ...chrome.windowOptions(currentTheme),
    minWidth: defaults.minWindow.width,
    minHeight: defaults.minWindow.height,
    show: false,
    backgroundColor: currentTheme.surface,
    autoHideMenuBar: true,
    title: chrome.APP_NAME,
    icon: process.platform === 'linux' ? path.join(ASSETS, 'icon.png') : undefined,
  });

  if (cfg.window.maximized) mainWindow.maximize();

  createStrip();

  pageView = createGatewayView();
  mainWindow.contentView.addChildView(pageView);
  // Named `wc` here because the reveal below is the WINDOW's business rather than
  // the view's: the first paint of the gateway view is what lets the window show.
  const wc = pageView.webContents;
  layoutViews();

  // Every event that changes the content size has to re-lay the views out, the
  // page's own size now depends on this, not just the modal's, so a missed one
  // is a page that does not fill the window rather than a cosmetic slip.
  mainWindow.on('resize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('move', schedulePersist);
  mainWindow.on('maximize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('unmaximize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('enter-full-screen', layoutViews);
  mainWindow.on('leave-full-screen', layoutViews);

  mainWindow.on('close', (event) => {
    persistBounds();
    if (quitting || !config.get().closeToTray) return;
    event.preventDefault();
    // Hide the window but deliberately keep the Dock icon: hiding the Dock icon
    // too suppresses the 'activate' event, and then only the tray or the global
    // shortcut can bring the app back, an easy way to lose it entirely.
    mainWindow.hide();
  });

  // Child views die with the window, but the module-level handles do not, and a
  // stale one would have `showMainWindow` hand work to a destroyed WebContents.
  mainWindow.on('closed', () => {
    pageView = null;
    // The attempt view and the payload flag go with it: a recreated window is a
    // new window, with nothing on screen and nothing to preserve.
    attemptView = null;
    payloadGateway = null;
    stripView = null;
    bannerView = null;
    bannerSize = { width: 0, height: 0 };
    // The sweep is a view of its own, so it is a handle of its own to drop.
    sweepView = null;
    sweepSize = { width: 0, height: 0 };
    loadingView = null;
    overlayViews.clear();
    // The set of views that were on the window: they die with the window, and a
    // stale entry would make restackViews try to re-add a destroyed view.
    attachedViews.clear();
    // A recreated window is a new window, and it has to be allowed to show.
    windowRevealed = false;
    // The cover went with the window, so nothing is listening for progress.
    stopProgressTicker();
  });

  // `ready-to-show` is the window's own signal and it never fires now: the
  // window has no content of its own, only child views. So the first paint of
  // any of them is what the window waits for, `dom-ready` rather than
  // `did-finish-load`, because subresources should not hold the window back.
  //
  // The window's backgroundColor is the theme surface, so the gap before that
  // fires shows the right colour rather than white.
  wc.once('dom-ready', revealMainWindow);
  // Backstop only, and it should never be what fires: the loading cover paints
  // in milliseconds and reveals the window itself (see showLoadingCover). This
  // is here for the case where there is no cover and no page either.
  setTimeout(revealMainWindow, 4000);

  loadActiveGateway();
  // Anything raised before there was a window to put it in -- the shortcut and
  // the credential store are both checked during startup, well before this --
  // would otherwise sit in the store with nothing on screen. Also covers the
  // window being recreated after it was closed for good on macOS.
  refreshBanner();
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow();
  // The tray icon and the global shortcut are what someone reaches for when the
  // window has stopped responding, so this is the right place to sweep up a dead
  // overlay: it makes the instinctive gesture the recovery gesture. Supervision
  // should have caught it already, this is the net under that.
  for (const name of [...overlayViews.keys()]) if (!overlayAlive(name)) closeOverlay(name, { animate: false });
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showMainWindow();
}

/* --------------------------------------------------------------------- theme */

/**
 * The appearance the app should be in for a gateway, applied to our chrome.
 *
 * A READ of the stored value and nothing more, which is the property to keep:
 * every surface of ours asks what the appearance is, and none of them decides
 * one. It only ever moves the app when the stored value differs from what is
 * already in force, so a switch to a gateway with nothing stored leaves the
 * current appearance alone rather than dropping to a default.
 *
 * Called on a gateway switch, and deliberately not called on a launch, where
 * the seed below the constant already did it.
 */
function applyStoredTheme(gatewayId) {
  const mode = config.themeFor(gatewayId);
  if (!mode || mode === currentTheme.mode) return;
  currentTheme = chrome.fallbackTheme(mode);
  console.log(`[claw-desktop] theme: ${currentTheme.mode} (stored for this gateway)`);
  chrome.applyTheme(currentTheme, mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []);
  refreshThemedPages();
}

// Adopt a theme reported by the page and repaint everything the page's own
// stylesheet cannot reach. Persisting the mode is what makes the *next* cold
// start open in the right colours; only the mode is kept, because the exact
// surface belongs to whichever palette is live and re-arrives within a frame of
// the page loading.
function adoptTheme(theme) {
  if (!theme) return;
  // Tokens are part of the comparison, not just the caption colours: two
  // palettes can share a `--bg` and differ everywhere else, and if that
  // difference is dropped here the settings page keeps the old theme's borders
  // and accents until something unrelated forces a repaint.
  const changed = theme.surface !== currentTheme.surface
    || theme.symbol !== currentTheme.symbol
    || theme.mode !== currentTheme.mode
    || JSON.stringify(theme.tokens) !== JSON.stringify(currentTheme.tokens);
  if (!changed) return;

  const modeChanged = theme.mode !== currentTheme.mode;
  console.log(`[claw-desktop] theme: ${theme.mode} ${theme.surface} (${Object.keys(theme.tokens).length} tokens)`);
  // A resolved palette replaces the stated fallback, so the next time our pages
  // have nothing to draw from the line is printed again rather than suppressed
  // for the life of the process.
  if (Object.keys(theme.tokens).length) statedFallback = false;
  currentTheme = theme;
  chrome.applyTheme(currentTheme, [mainWindow]);
  refreshThemedPages();
  // Remembered against the gateway that reported it, because the Control UI's
  // theme belongs to that gateway and is chosen in that gateway's own UI. This
  // is one of the only two writes to the appearance store.
  //
  // The comparison is against what is STORED for this gateway, never against
  // what we happen to be painting with, and that distinction is load-bearing.
  // The painted value on a cold start is a SEED: on a first run it is the dark
  // fallback, so comparing against it would make a gateway's first observed
  // theme look like "no change" and leave the store empty for ever, which is a
  // cold start that can never learn. Against the stored value the write happens
  // exactly once per gateway in this direction, and a launch that agrees with
  // what is already there still writes nothing.
  const active = config.get().activeGatewayId;
  if (config.themeFor(active) !== theme.mode) config.rememberTheme(active, theme.mode);
}

/* ----------------------------------------------------------------- overlays */

/**
 * Every dialog this app shows is one of these: a local page in a transparent
 * WebContentsView layered over the window's contents.
 *
 * None of them is a native dialog, and that is a deliberate rule for the whole
 * project rather than a preference about looks. A native message box is a
 * different dialog on each of the three platforms, takes its colours from the
 * OS rather than from the Control UI theme the rest of the app is tracking,
 * and, the reason the About box came here first, cannot carry anything but a
 * fixed line of text and a row of buttons. Electron's `role: 'about'` panel
 * cannot show which commit a build came from, and it does not exist at all on
 * Windows before Electron 15.
 *
 * They stay separate WebContents rather than being drawn into the gateway's own
 * document, because these pages hold the privileged IPC bridge: the preload
 * grants it only to `file://` pages, so hosting them inside remote content
 * would hand a gateway the ability to rewrite settings and read pinned
 * fingerprints. A child view keeps the modal *look* without giving that up.
 *
 * Views stack in the order they are added, so a message opened while Settings
 * is up lands on top of it and Settings is still there underneath when it goes.
 */
// name -> the page, resolved against UI_DIR at the call site, the way it always
// was. The directory is core/ui now, see the note on UI_DIR above.
const OVERLAY_PAGES = { settings: 'settings.html', about: 'about.html', pairing: 'pairing.html' };

/** name -> WebContentsView, in the order they were opened, which is z-order. */
const overlayViews = new Map();

// `frameless` rides in the URL rather than being fetched over IPC because the
// page uses it for layout, how far down the card starts, to clear the drag
// band. Asked for asynchronously it arrives after first paint, and the card
// visibly jumps on every open.
function overlaySearch(opts = {}) {
  const params = new URLSearchParams();
  if (opts.firstRun) params.set('firstRun', '1');
  // Settings is the window's own content rather than a dialog in it. Kept
  // separate from firstRun so the two can differ again, firstRun additionally
  // hides the preferences, which being the window's content does not imply.
  if (opts.page || opts.firstRun) params.set('page', '1');
  if (chrome.enabled()) params.set('frameless', '1');
  // Which tab to land on, for the notices whose whole offer is "the thing that
  // answers me is on that tab". Opening Settings and leaving someone to find it
  // is most of the way to not having said anything.
  if (opts.tab) params.set('tab', String(opts.tab));
  return `?${params}`;
}

/** True if this overlay is still a live thing that can be focused and closed. */
function overlayAlive(name) {
  const view = overlayViews.get(name);
  return Boolean(view) && !view.webContents.isDestroyed();
}

function openOverlay(name, opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // A destroyed view still covers the window and still eats clicks, so focusing
  // it does nothing and reopening has to mean *replace*. Otherwise the one
  // action a wedged user would try, click the menu item again, is the one
  // action guaranteed not to help.
  // Not animated: this view is the dead one being replaced, so there is no
  // departure to play and nothing left in it to ask.
  if (overlayViews.has(name) && !overlayAlive(name)) closeOverlay(name, { animate: false });
  if (overlayViews.has(name)) {
    const existing = overlayViews.get(name);
    existing.webContents.focus();
    return existing;
  }

  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Transparent, so the translucent scrim the page paints actually reveals the
  // Control UI underneath instead of a black rectangle. A view added to a
  // window is opaque until told otherwise.
  view.setBackgroundColor('#00000000');
  overlayViews.set(name, view);

  const wc = view.webContents;
  attachContextMenu(wc);
  // Armed before the view is attached, so a load that fails immediately is
  // already covered. `isCurrent` is a closure over the live handle rather than
  // a captured boolean: it has to answer for the overlay that is open *now*, or
  // a dying one closes its own replacement.
  overlay.supervise(wc, {
    isCurrent: () => overlayViews.get(name) === view,
    close: () => closeOverlay(name),
    log: (msg) => console.error(`[claw-desktop] ${name} overlay: ${msg}`),
  });
  mainWindow.contentView.addChildView(view);
  attachedViews.add(view);
  restackViews();
  layoutViews();
  wc.loadFile(path.join(UI_DIR, OVERLAY_PAGES[name]), { search: opts.search || overlaySearch() });
  wc.once('did-finish-load', () => {
    applyThemeCss(wc);
    wc.focus();
  });
  return view;
}

/**
 * How long the host waits for a page to say its departure is done, before taking
 * the view away regardless.
 *
 * NOT a duration the reader sees. The page owns that number, because its stylesheet
 * is what declares it. This is the point at which the host stops trusting an answer
 * that has not arrived, and it is generous on purpose: the page's own bound is one
 * `--duration-fast` plus a frame, so anything near this ceiling means the page is not
 * answering at all, and a view the host can no longer take away is a worse fault
 * than an un-animated dismissal.
 */
const SURFACE_LEAVE_CEILING_MS = 500;

/**
 * Ask a page to play its own departure, and resolve when it has.
 *
 * The PAGE owns both halves of the timing: its stylesheet declares the duration and
 * it reads the reduced-motion preference itself, which is why the host asks rather
 * than working out how long to sleep. A reader who asked for no motion gets an
 * immediate answer and the view goes at once, rather than the host holding a surface
 * for a duration nothing is going to animate.
 *
 * Every non-answer means "gone now": no `clawSurface` (a page whose script did not
 * load), a rejected evaluation (a page being torn down), or no answer inside the
 * ceiling. That is exactly the behaviour of the day before, so nothing new here can
 * strand a view on screen.
 */
function leaveSurface(view) {
  const wc = view && view.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  const asked = wc
    .executeJavaScript('window.clawSurface ? window.clawSurface.leave() : null', true)
    .then((animated) => animated === true)
    .catch(() => false);
  return Promise.race([
    asked,
    new Promise((resolve) => setTimeout(() => resolve(false), SURFACE_LEAVE_CEILING_MS)),
  ]);
}

/**
 * Close one of our surfaces, playing its departure first.
 *
 * The view leaves the map BEFORE the fade, so the surface is logically gone the
 * moment it is asked to leave: a second close, or a reopen during those hundred
 * milliseconds, must not find a half-departed view and act on it. What stays
 * attached is only the pixels on their way out, and the removal below happens
 * whatever the page answered.
 *
 * `animate: false` is for the paths where there is no transition to make: a view
 * that is already dead, and the one case where this surface is not going away but
 * being REPLACED as the window's own content, where a fade would be a hundred
 * milliseconds of nothing in the middle of a page load.
 */
async function closeOverlay(name, { animate = true } = {}) {
  const view = overlayViews.get(name);
  if (!view) return;
  overlayViews.delete(name);
  themeCssKeys.delete(view.webContents.id);
  if (animate) await leaveSurface(view);
  attachedViews.delete(view);
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch { /* window already gone; the view goes with it */ }
  // Detaching is the part that unblocks the window, so nothing after it may
  // throw: this runs on the crash path too, where the contents are already gone.
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch { /* already torn down */ }
  // About shown over Settings must hand focus back to Settings, not to the
  // gateway page buried under both of them.
  const remaining = [...overlayViews.values()].filter((v) => !v.webContents.isDestroyed());
  if (remaining.length) remaining[remaining.length - 1].webContents.focus();
  else page()?.focus();
}

function openSettings(opts = {}) {
  // On first run the main window is already showing this page full-size; a
  // modal of the same thing over the top of itself is not an improvement.
  if (settingsIsPage) {
    // But "Open Settings" must never be a no-op, and it was: a connect attempted
    // from settings-as-page and then failing raised a banner whose one offer
    // pointed here, and here did nothing, because the page it offered to open was
    // already the whole window. So the reader was left with a banner they could
    // not act on, a page whose Escape and "Back to app" are dead in this mode,
    // and no gateway on screen: a dead end with no way to the Control UI.
    // Measured on 2026-09-18 and guarded by
    // scripts/test-settings-as-page-escape.js.
    //
    // The failure IS a condition the settings page already shows (the row reads
    // "Cannot connect" and can be pressed again, or another gateway picked), so
    // what "Open Settings" means here is "let me see it": take the banner down and
    // put the reader back on the usable page it was covering. That is the same
    // escape the phone gets by dismissing its settings sheet on connect, and it
    // makes the two clients behave alike from a failed connect.
    clearNotice('connection');
    showMainWindow();
    return null;
  }
  return openOverlay('settings', opts);
}

function closeSettings() {
  closeOverlay('settings');
}

/**
 * Close our settings surface and take the reader to the CONTROL UI's own settings.
 *
 * Two halves of one action, which is why this is one function: closing is what
 * gets this surface out of the way, and the Control UI's own footer control is
 * what puts the reader where the button promised. The pressing is the shared
 * affordance script's (core/spec/app-settings-affordance.json), so the phone runs
 * the same bytes against the same Control UI rather than building a URL of its
 * own, and the route stays the Control UI's to own.
 *
 * Deliberately not a URL: loading the Control UI's settings path ourselves would
 * be a second copy of a decision that is not ours, it would be a full reload of a
 * page that is already loaded behind this one, and it would have to know the path
 * for the app's settings to land beside the gateway's.
 *
 * ATOMIC, and the order is the fix rather than the decoration. It used to close
 * this surface first and press second, which left the reader looking at whatever
 * the Control UI had been showing for the whole of the destination's load, a
 * visible few seconds, and only then at the settings page. Nothing was wrong with
 * the destination; the journey showed them a page they had not asked for. So the
 * ask comes first, this surface stays up while it lands, and the reveal happens
 * once the destination is genuinely on screen. The reader now goes from app
 * settings to the Control UI's settings page directly, which is the same shape as
 * the loading cover: revealed only once there is something to reveal.
 *
 * Both halves still run even when the ask finds nothing, because a surface that
 * will not let go is a worse fault than the one being fixed: the reveal is
 * unconditional, and only the WAIT is conditional on there being something to
 * wait for.
 */
async function openControlUiSettings() {
  const wc = page();
  // Nothing behind this surface to hand off to (a first run, where settings IS the
  // window's content), so there is nothing to wait for and the card that carries
  // this is hidden anyway.
  if (!wc) {
    closeSettings();
    return;
  }
  let asked = false;
  try {
    asked = await wc.executeJavaScript(appSettingsAffordance.controlUiSettingsSource(), true);
  } catch (err) {
    console.warn(`[claw-desktop] could not open the Control UI settings: ${err.message}`);
  }
  if (asked === true) await waitForControlUiSettings(wc);
  else console.warn('[claw-desktop] the Control UI has no footer settings control to press; the reader stays on the page');
  closeSettings();
}

/**
 * Whether the Control UI's own settings page is on screen yet, asked of the live
 * page.
 *
 * A separate statement from the ask (core/app-settings-affordance.js owns both)
 * because the two are answered by different documents: the ask is answered by the
 * page the reader was on, and this one has to be answered by the page they are
 * going to, once it exists.
 */
function controlUiSettingsReady(wc) {
  return wc.executeJavaScript(appSettingsAffordance.controlUiSettingsReadySource(), true);
}

/**
 * Wait until the Control UI has rendered the settings page this handoff promises.
 *
 * Polled from OUT here rather than awaited inside the page, and that is forced by
 * the mechanism. The shipping Control UI has no footer settings control to press,
 * so the ask falls through to the Control UI's own settings ROUTE, which is a full
 * document load: a promise returned by the page is destroyed by the very
 * navigation it would have been waiting on, and the question can only be asked
 * again from outside. It also survives the SPA case unchanged, which is what the
 * same wait will do if upstream ever ships the control.
 *
 * Every way of not getting an answer re-asks rather than giving up, because the
 * commonest non-answer here is not a failure but the navigation itself: asking a
 * document that is being replaced cannot be answered, and the answer worth having
 * is in the document that replaces it.
 *
 * Bounded by the shared deadline. Past it the caller reveals anyway, so a Control
 * UI that never arrives costs the reader the wait and nothing else, and the log
 * says which one happened.
 */
function waitForControlUiSettings(wc) {
  return new Promise((resolve) => {
    const deadline = Date.now() + appSettingsAffordance.CONTROL_UI_SETTINGS_READY_TIMEOUT_MS;
    const ask = () => {
      if (wc.isDestroyed()) {
        console.warn('[claw-desktop] the gateway page went away while waiting for the Control UI settings');
        resolve(false);
        return;
      }
      const again = () => {
        if (Date.now() >= deadline) {
          console.warn(`[claw-desktop] the Control UI did not render its settings page within ${appSettingsAffordance.CONTROL_UI_SETTINGS_READY_TIMEOUT_MS}ms; revealing anyway`);
          resolve(false);
          return;
        }
        setTimeout(ask, appSettingsAffordance.CONTROL_UI_SETTINGS_POLL_MS);
      };
      controlUiSettingsReady(wc).then((ready) => {
        if (ready === true) resolve(true);
        else again();
      }, again);
    };
    ask();
  });
}

/* ------------------------------------------------------------- first paint */

// Whether the window has had its one automatic reveal this lifetime.
//
// Several things can be the first to paint, the gateway page, the loading
// cover, the timeout backstop, and exactly one of them should show the window.
// A flag rather than `once` on each, because they are separate emitters, and
// without it a reconnect would re-show a window the user has since sent to the
// tray. Reset when the window is recreated, which macOS does after a real
// close.
let windowRevealed = false;

function revealMainWindow() {
  if (windowRevealed || config.get().startHidden) return;
  // Never reveal over a cover that has not been given the resolved palette yet.
  // The first frame that reaches the screen is the one that has to be right: a
  // cover styled a moment later is a colour flip in the first thing the app
  // ever shows, which is the one place a mismatch is most visible. The guard is
  // here rather than at each trigger because there are several (the cover's own
  // document, the gateway page's, and a clock), and while a cover is up only
  // the cover's own styling may open the door. `styleLoadingCover` calls back
  // into this, so the reveal still happens, once, and last.
  if (loadingView && !coverStyled) return;
  windowRevealed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

/* ----------------------------------------------------------- loading cover */

// What the window shows when it has no gateway page to show: during a connect,
// and after one that failed.
//
// A view of its own rather than a page loaded into the gateway's view, because
// of what a failure does to that view. Chromium commits its own error document
// there, and loading over the top of it would be a second navigation racing the
// first, the exact shape that produced spurious `did-fail-load` events the
// last time these two shared a WebContents. Here the gateway page loads, or
// fails, underneath and untouched, and success is this view going away.
let loadingView = null;
// Whether the cover has been given the resolved palette yet, which is what
// revealMainWindow waits for while a cover is up. See styleLoadingCover.
let coverStyled = false;

/**
 * Re-add the child views in z-order.
 *
 * `addChildView` on a view that is already attached moves it to the top, so the
 * order of these calls *is* the stacking order: the gateway page at the bottom,
 * then the cover over it, then any modals, and the notice banner above
 * everything. It runs whenever one of them appears, because a view added later
 * would otherwise land above ones that must stay above it, a cover over the
 * Settings modal is a locked window.
 *
 * The banner is on top rather than under the modals, and that is the whole
 * reason a notice can now be the app's only way of telling you something.
 * Underneath, anything raised while Settings was open was drawn behind it: a
 * connection failing, an update arriving, or the answer to a Connect pressed on
 * that very page went to a strip nobody could see. Which is why those three used
 * to be a dialog, a dialog, and a card on the Settings page, three shapes for
 * one job, because the one shape did not work from everywhere.
 *
 * It costs the top ~72px of a modal while a notice is up. That is a real cost
 * and it is the right way round: the modal is a page someone opened and can
 * scroll, the notice is the app saying something changed underneath them.
 */
// The views that are ON the window, as opposed to being prepared off it. A view
// is prepared, loaded and then attached, which is what keeps its page from taking
// the reader's keyboard; see attachReadyView.
const attachedViews = new Set();

function restackViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Only views that have been PUT there are restacked. A view of ours loads its
  // page BEFORE it joins the window (see attachReadyView), so a view that is
  // still preparing is not on the window to be restacked, and re-adding it here
  // would put it on screen half-loaded and take the reader's keyboard with it.
  for (const view of [loadingView, ...overlayViews.values(), bannerView, sweepView]) {
    if (!view || !attachedViews.has(view) || view.webContents.isDestroyed()) continue;
    try { mainWindow.contentView.addChildView(view); } catch { /* window gone */ }
  }
}

/**
 * Put one of our views on the window, and remember that it is there.
 *
 * The order this exists for is LOAD, THEN ATTACH, and it is a focus rule rather
 * than a tidy-up. Measured 2026-09-17 on Electron 44: a `WebContentsView` added
 * to the window and THEN loaded hands the window's keyboard to its own page the
 * moment the document commits, and it keeps it. Nothing in this app calls focus
 * on it; the load does. So the loading cover and the notice banner, which are
 * surfaces that appear on their own, are loaded while they are OFF the window and
 * attached once their document is ready. Measured in the same run: loaded
 * detached, the page underneath keeps the keyboard through the load, the attach,
 * a DOM change and the view's removal; loaded while attached, the keyboard moves
 * to the new view within 150ms and never comes back.
 *
 * It also fixes the other half of the same order: the style sheets are inserted
 * before the view is on screen, so the first frame anyone SEES is the styled one,
 * where attaching first could paint an unstyled banner for a frame.
 *
 * A hidden view is not an answer: `setVisible(false)` while loading still took the
 * keyboard in the same measurement.
 */
function attachReadyView(view) {
  if (!view || !mainWindow || mainWindow.isDestroyed()) return;
  if (view.webContents.isDestroyed()) return;
  try {
    mainWindow.contentView.addChildView(view);
    attachedViews.add(view);
  } catch { /* window gone */ }
  restackViews();
  layoutViews();
}

/* --------------------------------------------------------------- progress */

// The cover's progress bar and the line under it, both computed here and pushed
// as a pair.
//
// The cover is sandboxed and cannot require src/progress.js or src/quips.js, and
// the alternative to pushing is copying the curve into the page, two owners for
// one number, which drift the first time either is touched. So main ticks and
// the page draws.
//
// Four times a second, and only when the integer changes: that is far short of a
// frame, and it does not need to be. The fill has a CSS transition just longer
// than the tick, so the bar glides between the numbers it is given.
const PROGRESS_TICK_MS = 250;
let progressTimer = null;
let progressLast = null;
let quipOffset = quips.startAt();

function progressNow() {
  return {
    percent: progress.percent({
      milestone: connection.milestone,
      sinceMs: Date.now() - connection.milestoneAt,
      failed: connection.phase === connectionState.FAILED,
    }),
    // Rotated off the wall clock rather than the tick count, so the line does
    // not restart its cycle every time the cover is rebuilt on a retry.
    quip: quips.quipAt(Date.now() / quips.ROTATE_MS, quipOffset),
  };
}

function pushProgress() {
  if (!loadingView || loadingView.webContents.isDestroyed()) return;
  const next = progressNow();
  if (progressLast && progressLast.percent === next.percent && progressLast.quip === next.quip) return;
  progressLast = next;
  loadingView.webContents.send('app:progress', next);
}

function startProgressTicker() {
  if (progressTimer) return;
  progressLast = null;
  progressTimer = setInterval(pushProgress, PROGRESS_TICK_MS);
}

function stopProgressTicker() {
  if (!progressTimer) return;
  clearInterval(progressTimer);
  progressTimer = null;
  progressLast = null;
}

/**
 * Give the loading cover the resolved appearance, then reveal the window.
 *
 * Both sheets, in the order the rest of our chrome takes them: the shared token
 * layer first as the fallback palette, then the live gateway theme over the top,
 * so the cover matches the Control UI it is standing in for rather than only
 * ui.css's own literals. Two things about the sequence are deliberate, and the
 * second is the half only the cover needed: the token sheet goes before the
 * theme sheet as everywhere else, and BOTH go before the window is revealed.
 *
 * Fail OPEN. A cover that could not be styled is a mismatch that resolves
 * itself; a cover nobody reveals is an app that never appears, which is the
 * worse failure by a long way.
 */
async function styleLoadingCover(wc) {
  try {
    await applyTokenCss(wc);
    await applyThemeCss(wc);
    // ★ And only NOW onto the window. A cover is a surface the reader did not
    // ask for, so it may not take their keyboard either, and a view loaded while
    // attached takes it whether or not anything asks (see attachReadyView). So it
    // is loaded off the window and attached here, once its own page is styled:
    // the cover's first visible frame is the styled one, and the page underneath
    // keeps the caret it was typing into until the cover is genuinely in front of
    // it.
    if (loadingView && loadingView.webContents === wc) attachReadyView(loadingView);
  } catch { /* the page keeps ui.css's own palette */ }
  coverStyled = true;
  revealMainWindow();
}

function showLoadingCover() {
  if (!mainWindow || mainWindow.isDestroyed() || loadingView) {
    // Already up: a second connect attempt reuses the same cover, so the ticker
    // has to be (re)started here rather than only where the view is built.
    if (loadingView) startProgressTicker();
    return;
  }
  loadingView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  coverStyled = false;
  // Opaque, unlike the overlays: this is a cover, and the whole reason it
  // exists is that what is behind it should not be seen. The colour is the
  // resolved surface rather than transparency, so even the frame Chromium paints
  // before the document has one is the appearance we are in, and a cover
  // mid-repaint cannot show the Control UI through itself.
  loadingView.setBackgroundColor(currentTheme.surface);
  const wc = loadingView.webContents;
  attachContextMenu(wc);
  // Off the window while it loads, and put on it by styleLoadingCover once its
  // own page is styled. Same reason as the notice bar: a view loaded while it is
  // attached takes the reader's keyboard on its own. See attachReadyView.
  wc.loadFile(path.join(UI_DIR, 'loading.html'), { search: overlaySearch() });
  // Styled FIRST, revealed second, and the order is the fix rather than a
  // tidy-up. The cover is the first thing this window ever paints, so it is the
  // one surface where "styled a moment later" reads as the app flipping colour
  // as it starts. It draws from the shared token layer (core/spec/tokens.json
  // through core/tokens.js) exactly as the banner does, with the live gateway
  // theme over the top, and the window is not revealed until both have landed.
  //
  // The cover is usually the first thing in this window able to paint, and on a
  // slow or unreachable gateway it is the *only* thing for as long as the load
  // takes. Revealing on it turns "the app is invisible for four seconds and
  // then shows an error" into "the app opens, and it is loading".
  wc.once('dom-ready', () => { void styleLoadingCover(wc); });
  startProgressTicker();
  layoutViews();
}

function hideLoadingCover() {
  stopProgressTicker();
  if (!loadingView) return;
  const view = loadingView;
  // Cleared first: removing the view can throw if the window is already going,
  // and a handle left behind would keep the cover "up" forever from the app's
  // point of view while nothing is on screen. `coverStyled` goes with it, so a
  // cover that was never styled cannot hold the reveal back once it is gone.
  loadingView = null;
  coverStyled = true;
  attachedViews.delete(view);
  themeCssKeys.delete(view.webContents.id);
  tokenCssKeys.delete(view.webContents.id);
  // The cover is the ONE view painted opaque, so it has to be made see-through
  // BEFORE it is asked to leave. A page fading to transparent over a view whose own
  // background is still the surface colour would reveal nothing, and the fade would
  // read as the cover sitting there a moment longer rather than as the app arriving
  // underneath it.
  try { view.setBackgroundColor('#00000000'); } catch { /* window already gone */ }
  void (async () => {
    await leaveSurface(view);
    try { mainWindow?.contentView.removeChildView(view); } catch { /* window already gone */ }
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already torn down */ }
  })();
  // The gateway only takes focus if nothing of ours is in front of it. A
  // connect started from Settings finishes with Settings still open, and typing
  // into a page the user cannot see is worse than not moving focus at all.
  const top = [...overlayViews.values()].filter((v) => !v.webContents.isDestroyed()).pop();
  if (top) top.webContents.focus();
  else page()?.focus();
}

/* ------------------------------------------------------------------ banner */

// Conditions that are true until something fixes them: credentials that cannot
// be stored, a shortcut the OS refused, an update that would not download. None
// is a question, so none is a dialog.
const notices = noticeStore.create();

// The same failures, kept. The store above replaces a notice in place, which is
// what a banner needs and is exactly why it can never show that the gateway
// dropped five times overnight. Lazy, because app.getPath() is not answerable
// until the app is ready and this module is loaded well before that.
let noticeLogStore = null;
function noticeLog() {
  if (!noticeLogStore) noticeLogStore = noticelog.create({ dir: path.join(app.getPath('userData'), 'notice-log') });
  return noticeLogStore;
}

// A view rather than part of a page, because it has to sit over the *gateway's*
// page and this app draws no app UI into that. Its own WebContents for the same
// reason every other page of ours is one.
let bannerView = null;
// The card cluster's own box, in CSS pixels, reported by ui/banner.js. The view
// is resized to exactly this: a view swallows every mouse event inside its bounds
// no matter what the page draws there, so a view any bigger than the cards is an
// invisible strip that eats clicks on the UI underneath. The bar is gone (Abi,
// 2026-09-19: "floating cards no full width bar"), so this is a WIDTH as well as a
// height: the cards float at the top-trailing corner and everything beside them
// passes through. { width: 0, height: 0 } means gone.
let bannerSize = { width: 0, height: 0 };

// The sweep: the one control that closes the whole bar, in a view of its own,
// below the bar.
//
// ★ WHY A VIEW OF ITS OWN RATHER THAN SOMETHING ON THE BAR. A view claims every
// mouse event inside its own rectangle whatever the page draws there, so a
// control sharing the bar's view shares the bar's rectangle: a band of the bar
// carrying one right-aligned button left the rest of that band a dead zone over
// the Control UI, which is the regression Abi reported on 2026-09-18 and the
// second time this one area has produced it. Sized to the button alone and hung
// below the bar, the sweep claims the pixels it draws and gives every other pixel
// back to the Control UI. The page is core/ui/sweep.html, and the rule it follows
// is the one at the top of core/ui/banner.css.
let sweepView = null;
// What the sweep page says it needs, in CSS pixels: the view is sized to exactly
// this, so the control and the rectangle it claims are the same box.
let sweepSize = { width: 0, height: 0 };

/**
 * Whether the bar carries anything the sweep could act on.
 *
 * It is the same question the bar's control asked when it lived on the bar, and
 * it is asked of the store rather than of the cards. Anything unread is something
 * it can act on, because the sweep reads EVERY notice on the bar: it used to
 * exclude the cards that refuse to be dismissed, back when the sweep skipped them
 * too, and a card left standing on an otherwise empty bar is exactly what that
 * exclusion cost (Abi, 2026-09-18). Reading is not clearing, so there is nothing
 * left for this to exclude.
 */
function sweepWanted() {
  return notices.unread().length > 0;
}

/** Show the sweep, hide it, or leave it alone. Called on every notice change. */
function refreshSweep() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!sweepWanted()) {
    if (sweepView) {
      const view = sweepView;
      const wc = view.webContents;
      // Whether the keyboard is on the sweep, asked BEFORE it is taken away. It
      // never takes the keyboard by itself (it is loaded before it is attached,
      // see below), but the reader may have tabbed to it deliberately, and a view
      // taken off the window with the keyboard in it leaves the window with none.
      const held = !wc.isDestroyed() && wc.isFocused();
      attachedViews.delete(view);
      try { mainWindow.contentView.removeChildView(view); } catch { /* window gone */ }
      try { if (!wc.isDestroyed()) wc.close(); } catch { /* gone */ }
      themeCssKeys.delete(wc.id);
      tokenCssKeys.delete(wc.id);
      sweepView = null;
      sweepSize = { width: 0, height: 0 };
      if (held) {
        const top = [...overlayViews.values()].filter((v) => !v.webContents.isDestroyed()).pop();
        if (top) top.webContents.focus();
        else page()?.focus();
      }
    }
    return;
  }

  if (sweepView) return;

  // Provisional, and corrected by the page's first frame. A view with no size
  // never paints, and a view that never paints cannot run the script that reports
  // the size it needs.
  sweepSize = { width: 168, height: 40 };
  sweepView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  sweepView.setBackgroundColor('#00000000');
  const wc = sweepView.webContents;
  attachContextMenu(wc);
  // LOADED BEFORE IT IS PUT ON THE WINDOW, the same focus rule the bar follows: a
  // view added to the window and then loaded takes the window's keyboard the
  // moment its document commits, whether or not anything asks for it.
  wc.once('dom-ready', async () => {
    if (!sweepView || sweepView.webContents !== wc) return; // replaced while it loaded
    await applyTokenCss(wc);
    await applyThemeCss(wc);
    if (!sweepView || sweepView.webContents !== wc) return;
    attachReadyView(sweepView);
  });
  wc.loadFile(path.join(UI_DIR, 'sweep.html'), { search: overlaySearch() });
}

function refreshBanner() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The sweep follows the same store, so it is asked on every change and asked
  // first: the bar and the control that closes it must never disagree about
  // whether there is anything left to read.
  refreshSweep();
  // Unread rather than size: a condition that has been read is still true and
  // still in the store, and the bar has to come down anyway or reading it would
  // leave an empty strip eating clicks on the Control UI underneath.
  if (!notices.unread().length) {
    if (bannerView) {
      const view = bannerView;
      const wc = view.webContents;
      // Whether the keyboard is on the bar, asked BEFORE it is taken away. The
      // bar never takes it by itself (see attachReadyView), but the reader may
      // have given it deliberately by tabbing to one of its controls, and a view
      // taken off the window with the keyboard in it leaves the window with NONE.
      const held = !wc.isDestroyed() && wc.isFocused();
      attachedViews.delete(view);
      try { mainWindow.contentView.removeChildView(view); } catch { /* window gone */ }
      try { if (!wc.isDestroyed()) wc.close(); } catch { /* gone */ }
      themeCssKeys.delete(wc.id);
      tokenCssKeys.delete(wc.id);
      bannerView = null;
      bannerSize = { width: 0, height: 0 };
      // ★ Reposition everything now that the cards are gone. The sweep hangs off
      // the card cluster's foot (see layoutViews), so cards that leave without
      // this leave the sweep's y computed against the box they HAD. In the
      // ordinary case the sweep left on the same change (refreshSweep ran first
      // and unread() is empty), but the reader reported "Mark all read gets stuck
      // after banners leave": any path that keeps the sweep a moment longer, or a
      // later change that shrinks the cluster, was laying it out against a stale
      // box. bannerSize is zeroed now, so this puts the sweep back where it
      // belongs, or removes the strip the departed cards' box described.
      layoutViews();
      // Hand the keyboard back the way closeOverlay does, and only when it was
      // actually there: a dismissal must not move the reader's focus at all.
      if (held) {
        const top = [...overlayViews.values()].filter((v) => !v.webContents.isDestroyed()).pop();
        if (top) top.webContents.focus();
        else page()?.focus();
      }
    }
    return;
  }

  if (!bannerView) {
    // Provisional, and immediately corrected by the page. A view with no size
    // never paints, and a view that never paints cannot run the script that would
    // tell us how big to make it. A width too, now that the view hugs the cards
    // rather than spanning the window.
    //
    // * THE PROVISIONAL WIDTH IS THE WINDOW'S, AND THE VIEW IS LAID OUT BEFORE ITS
    // PAGE IS LOADED. Both halves are the fix for the collapse Abi reported on
    // Windows (2026-09-20: "the banners still collapse to the right"). A fresh
    // WebContentsView has NO bounds, and this one is loaded while it is off the
    // window, so the page's first report() was measured in a 0x0 viewport. The
    // cards are capped at max-width: 100% OF that viewport, so the report was 0
    // wide, and the host adopted 0 as the view's width: a width the page can never
    // exceed and so never reports again, leaving the two locked at nothing until
    // the view was torn down -- which is why only restarting the app recovered the
    // banner. Measured on the real sequence: bounds before load {0,0,0,0}, first
    // report {width: 0, height: 600}, cards 32px wide with one character per line.
    // The window's own width is the one honest starting point: it is wider than the
    // cluster, so the first measurement is taken in a viewport that can hold it,
    // and it cannot be derived from the answer.
    bannerSize = { width: mainWindow.getContentSize()[0], height: 72 };
    bannerView = new WebContentsView({
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    bannerView.setBackgroundColor('#00000000');
    const wc = bannerView.webContents;
    attachContextMenu(wc);
    // * Laid out NOW, before the load, for the reason above: the page reports its
    // own size the moment it runs, and a report taken before the view has ever had
    // bounds is a report taken in a viewport that cannot hold anything.
    layoutViews();
    // ★ LOADED BEFORE IT IS PUT ON THE WINDOW, and that order is a FOCUS rule
    // rather than a tidy-up. A WebContentsView added to the window and then
    // loaded takes the window's keyboard the moment its document commits,
    // whether or not anything asks for it: measured 2026-09-17 on Electron 44,
    // the keyboard moved to the bar within 150ms of the load and stayed there for
    // the life of the view, which is Abi's report exactly -- a card arriving
    // mid-sentence stopped the reader typing, and nothing in this file calls
    // focus() on the bar, so the ORDER is the only place the rule can live. See
    // attachReadyView for the measurement and for the half that fails.
    //
    // Attached on dom-ready, which lands after the page's script has run and
    // before its first card exists (the page awaits its own IPC read first), so
    // the arrival still plays where it can be seen.
    wc.once('dom-ready', async () => {
      if (!bannerView || bannerView.webContents !== wc) return; // replaced while it loaded
      await applyTokenCss(wc);
      await applyThemeCss(wc);
      if (!bannerView || bannerView.webContents !== wc) return;
      attachReadyView(bannerView);
    });
    wc.loadFile(path.join(UI_DIR, 'banner.html'), { search: overlaySearch() });
    return;
  }

  if (!bannerView.webContents.isDestroyed()) bannerView.webContents.send('app:notices-changed');
}

// Notices that take themselves down again, by id.
const noticeTimers = new Map();

/**
 * Raise a notice, optionally for a fixed time.
 *
 * Almost every notice is a standing condition and stays until whoever raised it
 * says otherwise, that is the shape of the thing. `ttlMs` is for the handful
 * that are not: the answer to a manual "check for updates", which is a reply to
 * a question rather than a problem, and would otherwise sit there permanently
 * announcing that nothing is wrong.
 *
 * The timer lives here rather than in the store so src/notices.js stays a pure
 * data structure with no clock in it.
 *
 * `announce` is the reader HAVING ASKED, and it is the store's: this passes it
 * through and owns nothing about what it means. The one caller that sets it is
 * the update card found by a check a person pressed (see onUpdateAvailable).
 */
function setNotice(id, notice, options = {}) {
  // A bare number is the old positional TTL, still accepted so the call sites
  // that pass one keep reading the same way.
  const { ttlMs = 0, announce = false } = typeof options === 'number' ? { ttlMs: options } : options;
  const existing = noticeTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    noticeTimers.delete(id);
  }
  // Whether this raise put something new on screen, returned so a caller that
  // floors how long a transient card stays (raiseAnswer) can tell a genuine change
  // from a same-content re-raise the store swallowed, and reset its visible clock
  // only on the former.
  const changed = notices.set(id, notice, { announce });
  if (changed) {
    // Read back from the store rather than logging the argument, so the default
    // tone is applied in exactly one place and a notice raised without one is
    // recorded as the error it actually became.
    noticeLog().raised(notices.get(id));
    refreshBanner();
  }
  if (ttlMs > 0) {
    const timer = setTimeout(() => clearNotice(id), ttlMs);
    // Never a reason to hold the process open: an app whose last act is waiting
    // to take down a banner nobody is looking at should just quit.
    if (typeof timer.unref === 'function') timer.unref();
    noticeTimers.set(id, timer);
  }
  return changed;
}

function clearNotice(id) {
  const timer = noticeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    noticeTimers.delete(id);
  }
  // A floored transient leaving the bar (its TTL fired, or a better answer
  // superseded it) resets its visible clock and any pending held replacement, so a
  // fresh raise re-presents at once rather than being held against a card that is
  // no longer there. resetFloor is a no-op for an id that was never floored.
  resetFloor(id);
  if (notices.clear(id)) {
    noticeLog().cleared(id);
    refreshBanner();
  }
}

/**
 * Give one of the app's own pages the Control UI's live design tokens.
 *
 * This is what makes settings look like part of the UI rather than beside it:
 * surfaces, borders, radii and the scrollbar tokens all come from whichever
 * palette the UI is actually running. ui.css declares a full fallback set, so a
 * page that loads before any theme has been reported, the first run, is
 * styled, just not matched.
 */
/**
 * Say which palette our own pages are wearing, once per state.
 *
 * A resolved palette needs no announcement: the app logs it when it adopts one.
 * The FALLBACK is the state that used to be invisible, and it is a deliberate
 * one rather than an accident: with nothing resolved, ui.css carries a complete
 * palette of its own (see its :root block) and every surface is drawn from that.
 * Saying so is the difference between a stated fallback and "the settings page
 * lost its theme", which is what the same state was reported as.
 */
let statedFallback = false;
function stateFallbackPalette() {
  if (statedFallback) return;
  statedFallback = true;
  console.log(`[claw-desktop] theme: no resolved palette, so our pages are using their own ${currentTheme.mode} fallback palette from ui.css`);
}

async function applyThemeCss(wc) {
  if (!wc || wc.isDestroyed()) return;
  const css = chrome.themeCss(currentTheme);
  if (!css) stateFallbackPalette();
  try {
    const previous = themeCssKeys.get(wc.id);
    if (previous) {
      themeCssKeys.delete(wc.id);
      await wc.removeInsertedCSS(previous);
    }
    if (css) themeCssKeys.set(wc.id, await wc.insertCSS(css));
  } catch { /* the page keeps ui.css's own palette */ }
}

/**
 * Give one of our pages the shared design tokens as its fallback palette.
 *
 * Inserted *before* applyThemeCss, deliberately, and always on a page load
 * rather than on a theme change: these are the values the Control UI resolves
 * to, and the live theme's declarations are the more specific answer for the
 * names the UI publishes. Both are inserted with `!important`, so the later one
 * is the one that wins, and the order here is what makes a loaded gateway theme
 * beat the fallback rather than lose to it.
 *
 * Only the banner takes this today. ui.css keeps its own palette for Settings,
 * About and the loading cover on purpose: those pages already get the live theme
 * over the top, and repainting them would move surfaces nobody asked about.
 */
async function applyTokenCss(wc) {
  if (!wc || wc.isDestroyed()) return;
  try {
    const previous = tokenCssKeys.get(wc.id);
    if (previous) {
      tokenCssKeys.delete(wc.id);
      await wc.removeInsertedCSS(previous);
    }
    tokenCssKeys.set(wc.id, await wc.insertCSS(tokens.stylesheet()));
  } catch { /* the page keeps ui.css's own palette */ }
}

/** Re-theme every page of ours that is currently on screen. */
function refreshThemedPages() {
  for (const view of overlayViews.values()) {
    if (!view.webContents.isDestroyed()) applyThemeCss(view.webContents);
  }
  // The strip is one of the app's own pages, and the one most visibly wrong if
  // it lags: it sits directly against the UI, so a stale surface colour reads as
  // a mismatched band across the top rather than as a slow repaint somewhere.
  if (stripView && !stripView.webContents.isDestroyed()) {
    applyThemeCss(stripView.webContents);
    stripView.setBackgroundColor(currentTheme.surface);
  }
  // The gateway view's own surface, which is NOT the page's stylesheet: it is
  // the colour Electron paints behind the Control UI where the page itself does
  // not, an overscroll rubber-band at the bottom edge, the gap while a fresh
  // payload is swapped in, the frame before a navigation paints. It is set once
  // at createGatewayView and was never moved after, so a theme change repainted
  // the strip (top) and the window while this kept the old colour, which the
  // reader saw as a band at the top or bottom disagreeing with the rest. The
  // strip's own note above is the same fault one surface over. The in-flight
  // attempt gets it too, so a view promoted right after a theme change does not
  // arrive wearing the previous surface.
  for (const view of [pageView, attemptView]) {
    if (view && !view.webContents.isDestroyed()) view.setBackgroundColor(currentTheme.surface);
  }
  if (bannerView && !bannerView.webContents.isDestroyed()) applyThemeCss(bannerView.webContents);
  if (loadingView && !loadingView.webContents.isDestroyed()) applyThemeCss(loadingView.webContents);
  if (settingsIsPage && mainWindow && !mainWindow.isDestroyed()) {
    applyThemeCss(page());
  }
}

/* ---------------------------------------------------------------- zoom/menu */

function setZoom(delta, absolute) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = page();
  if (!wc) return;
  const level = absolute !== undefined ? absolute : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
  config.update({ zoomLevel: level });
}

/* -------------------------------------------------------------------- updates */

// How often a running app looks for a new release is read from its own version:
// six hours on stable, five minutes on dev. See updates.checkIntervalMs().
// Where a platform that cannot install for itself sends the user. Hard-coded
// rather than read from electron-builder.yml's `publish` block: that file is not
// packaged, so the app would be parsing something it does not ship.
const RELEASES_URL = releasesUrl;
// Long enough that a cold start is not competing with the gateway connection
// for the network, and short enough to be within one sitting.
const UPDATE_FIRST_CHECK_MS = 60 * 1000;

let updater = null; // the electron-updater AppUpdater, or null where we do not check
let updateReady = null; // version string once downloaded and installable
let updateTimer = null;
// ★ The library's only handle on a transfer in flight. `checkForUpdates()` returns
// the CancellationToken it gave the download it starts on its own, and
// `downloadUpdate()` accepts one, so holding it is the difference between clearing
// a card and giving up the download behind it. See abandonUpdateDownload.
let downloadCancelToken = null;
// The last check to actually finish, for About to report. Updating is otherwise
// invisible, see updates.statusLine() for why that is worth a line.
//
// ★ It now carries what a manual press needs to re-present the answer AT ONCE,
// not just the one-line `result` About shows. `outcome` and `version` are the two
// facts `updates.checkAnswer` needs to recompose the same sentence a live check
// would, so a person who presses Check a second time gets the held answer from
// this cache immediately while the network re-check runs behind it, rather than a
// card that flashes waiting on a fetch. Populated by every completed check, from
// EVERY trigger (app-start, interval and manual), which is what makes the cache
// warm before the first manual press. `null` outcome means no check has finished
// this run yet, so there is nothing to re-present and the press waits on the live
// check as it always did.
let lastCheck = { at: null, result: null, outcome: null, version: null, current: null };

// ★ The trigger the running check was started with. The updater's own events do
// not carry it, and what a check may FETCH turns on it (updates.fetchPlan): a
// person who pressed Check is owed a card at once, while a background check is
// owed silence until there is evidence of movement. That difference is the whole
// of the reported 0% card.
let lastTrigger = 'scheduled';
// Whether the check in flight started a transfer this build has DECLINED. The
// library starts a download by itself when it finds a release, so declining one
// means giving up the handle it hands back, and that handle only exists once
// checkForUpdates() resolves. Hence a flag and a cancel rather than one step.
let declinedFetch = false;

/**
 * The version whose transfer this app has already been told to stop reporting,
 * as a record on disk, or null.
 *
 * ★ Why this is PERSISTED rather than held in memory like `clearedAttempt`.
 * The card it suppresses is raised by a check that runs on every LAUNCH (see
 * UPDATE_FIRST_CHECK_MS), so an in-memory mark is undone by quitting and
 * reopening the app: the reader clears the card, relaunches, and the same
 * transfer is started and announced all over again. Measured 2026-09-17 by
 * scripts/test-update-relaunch.js, which found exactly that.
 *
 * It lives in the app's own config file rather than one of its own, because that
 * is where this app already keeps state that outlives a run and About shows the
 * reader its path. It is deliberately NOT a claim that a download is in flight:
 * nothing is ever restored from it as live progress. What it decides is
 * fetchPlan() in core/updates.js.
 */
function suppressedUpdate() {
  const record = config.get().updateSuppression;
  if (!record || typeof record.version !== 'string') return null;
  return record;
}

// ---------------------------------------------------------- bootstrap health
//
// The crash-loop marker outlives a run in the same config store as the update
// suppression above, and for the same reason: a build that dies before its own
// code runs cannot report anything, so the signal has to be on disk. main.js
// writes a fresh attempt marker BEFORE anything can crash the boot, advances its
// stage as the boot passes each milestone, and clears it once the window's own
// shell is up (renderer-ready). A marker still present next launch is a boot
// that never finished; core/bootstrap-health.js turns the count into a verdict.
//
// The verdict read at THIS launch, before this launch's own attempt is written,
// so a later system (the broken-build banner and the automatic rollback) can ask
// "did the build we are running fail to come up last time?" without re-reading
// the store. Null until beginBootAttempt() has run.
let bootVerdict = null;

/** The verdict this launch was born with: is the running build in a crash loop? */
function bootHealth() {
  return bootVerdict;
}

/**
 * Read the marker left by previous launches, judge the running build, then write
 * a fresh attempt for THIS launch ahead of init. Called first thing in
 * whenReady, so the marker is on disk before any later step can crash the boot.
 */
function beginBootAttempt() {
  const version = app.getVersion();
  const previous = config.get().bootMarker || null;
  bootVerdict = bootstrapHealth.assess(previous, { version });
  if (bootVerdict.bad) {
    console.warn(`[claw-desktop] bootstrap: ${version} failed to come up ${bootVerdict.attempts} times in a row (last stage ${bootVerdict.stage || 'unknown'})`);
  }
  config.update({ bootMarker: bootstrapHealth.beginAttempt(previous, version) });
}

/** Record that the boot reached a later stage, so a report can say where it died. */
function reachBootStage(stage) {
  const marker = config.get().bootMarker;
  if (!marker) return;
  const next = bootstrapHealth.reachedStage(marker, stage);
  if (next !== marker) config.update({ bootMarker: next });
}

/**
 * The boot finished cleanly: clear the marker so it does not count against the
 * next launch. This is the ONLY clear, and it runs when the window's own shell
 * has loaded (renderer-ready), which is the point a boot has genuinely come up
 * whether or not a gateway then connects.
 */
function bootReady() {
  if (config.get().bootMarker) config.update({ bootMarker: null });
  recordLastKnownGood();
}

/**
 * Pin the running build as the last version that came up cleanly, so a future
 * crash loop has something to roll back TO.
 *
 * Written only on a clean boot and only when it changed, so a launch that
 * changes nothing touches no file. The version rolled back FROM is never pinned
 * as good even if it later limps to renderer-ready once: a build under an active
 * 'broken' suppression stays off the good list until the suppression is cleared,
 * which is what keeps a flaky build from re-nominating itself as the target.
 */
function recordLastKnownGood() {
  const version = app.getVersion();
  if (!version) return;
  const suppressed = suppressedUpdate();
  if (suppressed && suppressed.reason === 'broken' && suppressed.version === version) return;
  const record = config.get().lastKnownGood;
  if (record && record.version === version) return;
  config.update({ lastKnownGood: { version, at: Date.now() } });
  console.log(`[claw-desktop] bootstrap: ${version} came up cleanly; pinned as last-known-good`);
}

const BROKEN_BUILD = 'broken-build';

/**
 * Whether this install can roll the running build back to an earlier one.
 *
 * Two things have to hold: the platform's updater can downgrade at all (macOS
 * cannot without a Developer ID, iOS never), and there is a last-known-good to
 * roll back TO. The pinned-good record is the automatic rollback's own state; a
 * banner raised before that half exists reads canRollback as false and tells the
 * reader to reinstall instead, which is the honest answer until the pin is there.
 */
function canRollBack() {
  const record = config.get().lastKnownGood;
  if (!record || typeof record.version !== 'string') return false;
  // A downgrade rides the same install path electron-updater uses to upgrade, so
  // where a platform can install (Windows NSIS, Linux AppImage) it can roll back;
  // macOS without a Developer ID and iOS cannot, and there canInstall is false.
  return updatePolicy().canInstall === true;
}

/**
 * The running build kept failing to come up: say so on the notice surface, and
 * offer the rollback where one is possible. The verdict was read at launch
 * (bootHealth), before this launch's own attempt was written, so this is about
 * the build we are running rather than about this launch.
 *
 * Raised after the window exists so there is a surface to raise it on. It is not
 * dismiss-clearing: the condition is true until a good build comes up, so a
 * dismissed banner should come back next launch rather than being marked handled.
 */
function raiseBrokenBuildBanner() {
  const rollback = canRollBack();
  const verdict = bootHealth();
  const banner = bootstrapHealth.brokenBuildBanner(verdict, { canRollback: rollback });
  if (!banner) {
    clearNotice(BROKEN_BUILD);
    return;
  }
  // The crash loop is worth a report of its own: bootAttempts and the stage it
  // died at are exactly what the collector needs to see a bad build across the
  // fleet, and they carry nothing identifying.
  issueReporter.report('bootFailure', { bootAttempts: verdict.attempts, stage: verdict.stage });
  setNotice(BROKEN_BUILD, {
    tone: noticeStore.ERROR,
    message: banner.message,
    detail: noticeStore.sentence(banner.detail),
    // Where a rollback is possible the banner offers it; where it is not, the
    // reader is pointed at the release page to reinstall by hand.
    action: rollback
      ? { label: 'Roll back to the last version that worked', command: 'update-rollback' }
      : { label: 'Open release page', command: 'update-release-page' },
  });
}

/**
 * Roll the crash-looping build back to the last version that came up cleanly.
 *
 * Three moves, and each is load-bearing:
 *   1. Suppress the running (broken) build with reason 'broken', reusing the
 *      update-suppression lane as the do-not-refetch half: without this the next
 *      scheduled check would offer the broken build straight back, because on our
 *      channel a newly published build can rank HIGHER than the good one.
 *   2. Turn on allowDowngrade, because the target is an OLDER version and
 *      electron-updater refuses a downgrade by default.
 *   3. Check the feed: the updater compares the newest published build against
 *      the running one and, with allowDowngrade set and the broken build
 *      suppressed, downloads the good build to install over it.
 *
 * The pinned good version is what the suppression protects: it is not itself
 * suppressed, so the check that would otherwise refuse a downgrade is allowed to
 * offer it. Only reachable where canRollBack() held, so the platform can install
 * and a good version is pinned.
 */
/**
 * Start the rollback on its own when the running build is in a crash loop and a
 * rollback is possible, so a build that cannot come up does not depend on the
 * reader finding the button.
 *
 * Guarded so it fires at most once per broken build: if the running build is
 * already suppressed with reason 'broken' (we tried to roll it back on a previous
 * launch and it is still what is installed), the automatic attempt is not
 * repeated. The banner still offers the manual retry in that case, because a
 * repeated automatic download every launch is worse than one that stops and asks.
 */
function maybeAutoRollBack() {
  const plan = bootstrapHealth.rollbackPlan({
    version: app.getVersion(),
    verdict: bootHealth(),
    lastKnownGood: config.get().lastKnownGood || null,
    canInstall: updatePolicy().canInstall === true,
    suppression: suppressedUpdate(),
    auto: true,
  });
  if (!plan.rollBack) {
    if (plan.skip === 'already-tried') console.log('[claw-desktop] rollback: already attempted for this build; leaving the manual offer up');
    return;
  }
  rollBackToLastKnownGood();
}

function rollBackToLastKnownGood() {
  if (!canRollBack()) {
    console.warn('[claw-desktop] rollback: asked for, but this install cannot roll back');
    return;
  }
  const good = config.get().lastKnownGood;
  const broken = app.getVersion();
  // Do-not-refetch half: the broken build is held down so a later check cannot
  // offer it back over the good one we are about to install.
  suppressUpdate(broken, 'broken');
  config.update({ rollback: { from: broken, to: good.version, at: Date.now() } });
  console.log(`[claw-desktop] rollback: ${broken} -> ${good.version} (last-known-good)`);
  issueReporter.report('rollback', { rolledBackFrom: broken, rolledBackTo: good.version });
  if (updater) {
    updater.allowDowngrade = true;
    // The same path a normal update takes, but pointed downhill: the check finds
    // the good build on the feed and, with allowDowngrade on and the broken build
    // suppressed, treats it as installable.
    void checkForUpdates('rollback');
  }
}

/**
 * Record that this version's transfer ended without arriving, so that no check
 * starts it again by itself.
 *
 * `reason` is 'cleared' when the reader ended it and 'stalled' when it produced
 * nothing for the whole stall window. Both are honest, neither is a failure, and
 * About's status line keeps them apart because they mean different things to the
 * person reading it.
 */
function suppressUpdate(version, reason) {
  if (!version) return;
  config.update({ updateSuppression: { version, reason, at: Date.now() } });
  console.log(`[claw-desktop] updates: ${version} will not be fetched on its own again (${reason})`);
}

/**
 * Drop the record, because what it described has stopped being true: the reader
 * took the offer up, the transfer arrived after all, or the feed is offering a
 * different release. Passing a version clears only that version, so a stale
 * record for an older release can never suppress a newer one.
 */
function clearUpdateSuppression(version = null) {
  const record = suppressedUpdate();
  if (!record) return false;
  if (version !== null && record.version !== version) return false;
  config.update({ updateSuppression: null });
  return true;
}

function updatePolicy() {
  return updates.policy({
    platform: process.platform,
    packaged: app.isPackaged,
    // Supplied here rather than defaulted inside the policy, which is now shared
    // core and reads nothing ambient by design. The same fact the policy used to
    // pick up for itself, from the one place that can see the environment.
    appImage: Boolean(process.env.APPIMAGE),
    autoUpdate: config.get().autoUpdate !== false,
  });
}

/**
 * Track the automatic-updates preference on an already-running updater.
 *
 * Only `autoDownload` moves. Whether to *check* is deliberately not re-read:
 * turning the preference off leaves the scheduled check running, which is what
 * lets the app still say a release exists and offer to fetch it on the spot.
 * Restarting the app is not required for the toggle to take effect, and an
 * update already downloaded before it was switched off stays installable, * throwing away 130MB somebody already waited for would be a strange reading of
 * "stop downloading updates".
 */
function applyUpdatePreference() {
  if (!updater) return;
  const plan = updatePolicy();
  updater.autoDownload = plan.autoDownload;
  notifyAboutChanged();
}

/**
 * Wire up update checking, if this build can do anything useful about one.
 *
 * Required late rather than at the top of the file: it is the app's only runtime
 * dependency, and a source run has no use for it at all.
 */
function initUpdates() {
  const plan = updatePolicy();
  console.log(`[claw-desktop] updates: ${plan.action} (${plan.reason})`);
  if (!plan.check) return;

  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  updater.autoDownload = plan.autoDownload;
  // Same channel only: a dev build follows dev releases, a stable build follows
  // stable ones, and neither is ever offered the other. One flag does both
  // directions -- see allowPrerelease() in updates.js for why.
  updater.allowPrerelease = updates.allowPrerelease(app.getVersion());
  // Installing behind the user's back on quit is the wrong default for an app
  // they close to the tray dozens of times a day; the restart is offered.
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: () => {}, warn: () => {}, error: (m) => console.error(`[claw-desktop] updater: ${m}`), debug: () => {} };

  // The plan is re-read on every event rather than captured here: the
  // automatic-updates preference can change while the app runs, and a handler
  // holding the plan from startup would keep acting on the old answer.
  updater.on('update-available', (info) => onUpdateAvailable(info));
  updater.on('download-progress', (info) => onDownloadProgress(info));
  updater.on('update-downloaded', (info) => onUpdateDownloaded(info));
  // The other half of a cancel, and the reason it is not an error: the library
  // emits `update-cancelled` and deliberately does NOT dispatch `error` for a
  // CancellationError, so the two ends of a deliberate clear agree that nothing
  // went wrong. Nothing is raised here; the state is only tidied.
  updater.on('update-cancelled', () => {
    stopStallWatch();
    downloadCancelToken = null;
    downloadCardRaised = false;
    downloadVersion = null;
    downloadQuiet = false;
  });
  updater.on('error', (err) => {
    // Never unprompted. A machine that is offline, or behind a proxy, or hitting
    // a rate limit must not interrupt whatever the user was doing to say so.
    console.error(`[claw-desktop] update check failed: ${err && err.message}`);
    // The last outcome was a failure; a manual re-press re-presents that rather
    // than flashing, and the live re-check may then replace it with a better answer.
    setLastCheck('check failed', { outcome: updates.FAILED, version: null });
    // A failing update lane is a report worth having, especially during a
    // rollback: the scrubbed error names what broke without naming the machine.
    issueReporter.report('updateFailure', { errorName: err && err.name, errorMessage: err && err.message, stack: err && err.stack });
    // ★ Settled for EVERY trigger, before the manual-check gate below. A download
    // that dies has a card of its own on the bar already, so leaving it there at
    // whatever percent it reached is not the silence this handler is for -- it is
    // the app going quiet in the middle of a sentence it started. The gate below is
    // about a CHECK nobody asked about, which says nothing because a card was never
    // raised; this one only ever acts on a card that was.
    settleFailedDownload(err);
    if (!pendingManualCheck) return;
    pendingManualCheck = false;
    // The one exception to the line above, and the point of the shared
    // composition: someone who pressed the button is owed an answer even when
    // the answer is that the check could not finish.
    raiseAnswer(updates.checkAnswer({
      outcome: updates.FAILED,
      trigger: 'manual',
      current: app.getVersion(),
      error: (err && err.message) || err,
    }));
  });
  // ★ "Nothing available" is not the dependency's answer to trust on its own.
  // electron-updater decides this itself, with `semver.gt(latest, current)`
  // inside its isUpdateAvailable, and that ranks the build and commit tail: the
  // part of our version after the release, whose BASIS has changed, so a newly
  // published build can carry a LOWER number than the installed one. Ranked,
  // that inversion reads as "the installed build is ahead" and the update is
  // reported as not available, which is exactly how builds stopped arriving
  // while the number on About appeared to go backwards.
  //
  // The candidate it hands us here is still the newest published build on our
  // channel: its GitHubProvider takes the first entry belonging to the channel
  // in the feed's own order, which cannot invert. So the one owner of the rule
  // re-decides from that candidate, rather than this file growing a second
  // comparison of its own.
  updater.on('update-not-available', (info) => {
    const offered = info && typeof info.version === 'string' ? info.version : null;
    if (offered && updates.isNewerBuild(offered, app.getVersion())) {
      pendingManualCheck = false;
      // This raises the same card, from a background check, for a release the
      // updater's own comparison refused -- so a version whose transfer the reader
      // already ended must not come back through this door either.
      const record = suppressedUpdate();
      if (record && record.version === offered) {
        setLastCheck(`${offered} available`);
        return;
      }
      if (record) clearUpdateSuppression();
      offerRefusedByUpdater(offered);
      return;
    }
    // Cache the outcome so a later manual press can re-present "up to date" at once
    // rather than flashing while a fresh check runs. version is null: there is no
    // release to name.
    setLastCheck('up to date', { outcome: updates.CURRENT, version: null });
    if (!pendingManualCheck) return;
    pendingManualCheck = false;
    raiseAnswer(updates.checkAnswer({
      outcome: updates.CURRENT,
      trigger: 'manual',
      current: app.getVersion(),
    }));
  });

  const every = updates.checkIntervalMs(app.getVersion());
  console.log(`[claw-desktop] updates: checking every ${Math.round(every / 60000)} min`);
  setTimeout(() => void checkForUpdates('startup'), UPDATE_FIRST_CHECK_MS);
  updateTimer = setInterval(() => void checkForUpdates('scheduled'), every);
}

let pendingManualCheck = false;
// The version an 'update-available' offered, held for the notice's action to
// act on. A notice cannot carry a callback across IPC -- it names a command and
// main looks it up -- so what the command operates on has to live here.
let offeredUpdate = null;

// One id for every answer to a manual check, so a second check replaces the
// first rather than stacking a second "up to date" underneath it.
const UPDATE_ANSWER = 'update-answer';
// Long enough to read without hunting for it, short enough that an answer to a
// question nobody is still asking takes itself away. Only ever used for a reply
// to something the user pressed; a real problem has no timeout.
const ANSWER_TTL_MS = 9000;

// ★ The minimum-visible-duration floor, keyed by notice id, so any TRANSIENT
// notice (one with a TTL) honours the eighth rule in core/ui/CONVENTIONS.md: a
// state a reader is meant to READ stays on screen the floor (core/ui/motion.js,
// MIN_VISIBLE_MS) before a fresher one may replace it. This is the whole fix for
// "a second press just flashes": a manual re-check re-presents the cached answer
// AT ONCE, and even when the live re-check settles a millisecond later, its
// replacement waits out remainingVisibleMs so the reader sees the state rather
// than a flicker.
//
// Keyed rather than a single pair of variables, because the floor is the design
// language for every transient and not a fact about the update lane: it used to
// be answerShownAt/answerReplaceTimer, one bespoke copy that no other transient
// could reach. `shownAt` holds when the card under an id went up (null when none
// is), and `timer` holds a pending held replacement so two presses in quick
// succession do not stack timers on one card. The phone floors the same way, by
// notice id, in NoticeBoard.raise -- one design, two clients.
const floorState = new Map(); // id -> { shownAt: number|null, timer: Timeout|null }

function floorFor(id) {
  let s = floorState.get(id);
  if (!s) { s = { shownAt: null, timer: null }; floorState.set(id, s); }
  return s;
}

/**
 * Raise a TRANSIENT notice under `id`, holding whatever is on screen there for the
 * minimum-visible floor before a genuinely different answer replaces it.
 *
 * The generalization of the update lane's old raiseAnswer, so the floor is one
 * mechanism every transient shares rather than a rule the update card alone obeys.
 * `wouldChange` gates the hold on there being genuinely new content: a
 * same-content re-raise the store swallows changes nothing on screen, so it never
 * restarts the clock and is never held. A caller passes the notice body, the ttl,
 * whether the raise is an announce (the reader having asked), and an optional
 * `after` run once the raise actually lands (the update lane refreshes About).
 *
 * @returns {boolean} whether something new was put on screen now (false when held)
 */
function raiseFloored(id, notice, { ttlMs = 0, announce = false, after = null } = {}) {
  const state = floorFor(id);
  const current = notices.get(id);
  const wouldChange = !current || current.message !== notice.message
    || current.detail !== notice.detail || current.tone !== notice.tone;
  const remaining = state.shownAt === null ? 0 : remainingVisibleMs(state.shownAt, MIN_VISIBLE_MS);
  if (wouldChange && remaining > 0) {
    // A newer answer, but the one on screen has not been up long enough. Hold the
    // fresher answer until the floor is met, replacing any earlier pending hold so
    // two presses in quick succession do not stack timers on one card.
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const timer = setTimeout(() => {
      state.timer = null;
      raiseFloored(id, notice, { ttlMs, announce, after });
    }, remaining);
    if (typeof timer.unref === 'function') timer.unref();
    state.timer = timer;
    return false;
  }
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  const changed = setNotice(id, notice, { ttlMs, announce });
  // Only a raise that actually put something new on screen resets the visible
  // clock; a re-raise of the identical card leaves the reader looking at the same
  // thing, so its floor keeps counting from when it first appeared.
  if (changed || state.shownAt === null) state.shownAt = Date.now();
  if (after) after();
  return changed;
}

/**
 * A floored transient left the bar (its TTL fired, or a better answer superseded
 * it): reset its visible clock and any pending held replacement, so a fresh raise
 * re-presents at once rather than being held against a card that is no longer
 * there. Called from clearNotice.
 */
function resetFloor(id) {
  const state = floorState.get(id);
  if (!state) return;
  state.shownAt = null;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

/**
 * Raise the answer a check owes the person who pressed the button.
 *
 * The sentence itself is composed in `core/updates.js` (`checkAnswer`), because
 * both clients answer the same question and the phone has to say the same thing
 * about the same outcome. What stays here is everything that is a fact about
 * THIS surface: the id every answer shares so a second check replaces the first,
 * the tone the notice model draws it in, and the lifetime.
 *
 * `null` is a legitimate answer and not a failure: the shared composition
 * returns null for a background check that found nothing, which is the silence a
 * scheduled check must keep. Returning early rather than raising something empty
 * is what makes "never silently do nothing" true only for a check a person
 * asked for, which is the only case it is owed in.
 */
function raiseAnswer(answer, ttlMs = ANSWER_TTL_MS) {
  if (!answer) return;
  // The update answer is a transient state, so it goes through the shared floor
  // (raiseFloored) rather than a copy of the hold logic: the bug this fixes is a
  // manual re-check re-presenting a cached answer at once (presentCachedAnswer)
  // and the live re-check settling a moment later, which without the floor
  // replaces the first answer before the eye settles. `announce` is true because
  // this is always the reply to a press. The `after` runs on the raise that
  // actually lands and refreshes the About box, which is the one place that
  // guarantees the pressed-there card stops saying "Checking...": every ending of
  // a manual check either calls setLastCheck (which notifies) or lands here, and
  // the ending that only lands here is the one where the build cannot check at
  // all. Measured 2026-09-16 by scripts/test-notice-layers.js.
  raiseFloored(
    UPDATE_ANSWER,
    { tone: answer.tone, message: answer.message, detail: answer.detail },
    { ttlMs, announce: true, after: notifyAboutChanged },
  );
}

/**
 * Re-present the last completed check's answer from cache, at once.
 *
 * ★ This is what a manual press shows the INSTANT it is pressed, before the live
 * re-check has run: the reported fault was that a second press "just flashes and
 * returns quickly", because nothing was on screen until the network answered and
 * then the answer settled too fast to read. With the answer cached from the last
 * completed check (lastCheck), a press re-raises it immediately, and raiseAnswer
 * floors how long it stays, so the reader sees a held answer rather than a flash.
 * The live re-check then runs behind it (checkForUpdates) and only replaces this if
 * it has genuinely newer news, which is again floored.
 *
 * Returns whether it presented anything: false when no check has finished this run
 * (a cold first press), where there is nothing cached and the live check is the
 * only answer, exactly as before.
 *
 * It composes the sentence through the SAME shared updates.checkAnswer a live
 * answer uses, so the cached card and a live one cannot say different things about
 * one outcome. A cached AVAILABLE re-derives the policy so its wording is right for
 * this build now.
 */
function presentCachedAnswer() {
  if (!lastCheck.outcome) return false;
  const plan = updatePolicy();
  const answer = updates.checkAnswer({
    outcome: lastCheck.outcome,
    trigger: 'manual',
    version: lastCheck.version,
    current: app.getVersion(),
    action: plan.action,
    reason: plan.reason,
  });
  if (!answer) return false;
  raiseAnswer(answer);
  return true;
}

/**
 * The banner half of a refused certificate.
 *
 * The decision itself cannot be a banner: it needs two fingerprints side by
 * side and two answers, and a notice offers one action by design, because a
 * notice that needs two buttons is a question and a question is a dialog. So
 * the banner carries the alarm and the tab carries the comparison.
 *
 * This is what lets the certificate section live behind a tab at all. It used
 * to sit above everything on the Settings page, on the reasoning that a
 * decision filed under a heading is a decision nobody makes, and that reasoning
 * was right while the page was the only place it could be said.
 *
 * One notice however many hosts are waiting, because the id is fixed. A per-host
 * id would stack the banner without limit, which is the thing the ceiling test
 * in test/notices.test.js exists to prevent.
 */
function refreshCertNotice() {
  const offers = certs.pendingOffers();
  if (!offers.length) {
    clearNotice('cert-offer');
    return;
  }

  const changed = offers.filter((o) => o.changed);
  const only = offers.length === 1 ? offers[0] : null;
  // A first sighting on a :18789 address is routine. A fingerprint that moved
  // on a host already trusted is the one worth alarming about, and the two must
  // not look alike.
  const alarming = changed.length > 0;

  let message;
  if (only && only.changed) message = `The certificate for ${only.host} has changed since it was trusted.`;
  else if (only) message = `${only.host} is using a certificate this app cannot verify.`;
  else if (alarming) message = `${offers.length} certificates need review, ${changed.length} of them changed.`;
  else message = `${offers.length} certificates need review.`;

  setNotice('cert-offer', {
    tone: alarming ? noticeStore.ERROR : noticeStore.WARN,
    message,
    detail: alarming
      ? 'The connection stays refused until you decide. Expected if the gateway was reinstalled; worth a hard look if not.'
      : 'The connection stays refused until you decide. Normal for a gateway reached on its own :18789 listener.',
    action: { label: 'Review', command: 'certificates' },
  });
}

/**
 * Record how a check ended, and push it to an About box that is on screen.
 *
 * `result` is the one-line summary About shows ("up to date", "1.0.1 available").
 * `outcome` and `version` are the machine facts a manual press re-presents the
 * answer from (see presentCachedAnswer and lastCheck): passing them here is what
 * keeps the human line and the cache in step, so About and a re-raised card can
 * never disagree about what the last check found. They default to leaving the
 * cached facts untouched, so the one caller that only has a summary (a refused
 * build's "X available" side-note) does not blank them.
 */
function setLastCheck(result, { outcome = lastCheck.outcome, version = lastCheck.version } = {}) {
  lastCheck = { at: Date.now(), result, outcome, version, current: app.getVersion() };
  notifyAboutChanged();
}

async function checkForUpdates(trigger = 'manual') {
  if (!updater) {
    // A build with no updater is the one case where pressing the button used to
    // be answered by a sentence written here. It comes from the shared
    // composition now, so the phone says the same thing about the same outcome
    // and this is one owner rather than two sentences that drift.
    raiseAnswer(updates.checkAnswer({
      outcome: updates.UNAVAILABLE,
      trigger,
      current: app.getVersion(),
      reason: updatePolicy().reason,
    }));
    return;
  }
  pendingManualCheck = updates.shouldReportNoUpdate(trigger);
  lastTrigger = trigger;
  // ★ A manual press re-presents the last completed check's answer AT ONCE, from
  // cache, so the reader sees a held state immediately rather than a card that
  // flashes while the network is asked afresh. This is the whole of "cache between
  // checks so a manual click always has the info to present": the live re-check
  // below still runs, and only replaces this when it has newer news, floored by the
  // minimum-visible duration in raiseAnswer. A cold first press has nothing cached,
  // so presentCachedAnswer is a no-op and the live check is the only answer, as
  // before. Only the manual lane does this: an interval check that finds a version
  // already seen must stay quiet (announcesFound / shouldReportNoUpdate), which is
  // the identity rule from PR #37, so it never re-presents from cache.
  if (updates.presentsCachedAnswer(trigger, lastCheck.outcome)) presentCachedAnswer();
  // Set by onUpdateAvailable, below, when the plan declines this version.
  declinedFetch = false;
  try {
    const result = await updater.checkForUpdates();
    // The download a check starts on its own carries the token `checkForUpdates`
    // just handed back, so this is the cancel handle for it. Kept rather than
    // discarded so that clearing the card can give up the transfer too.
    if (result && result.cancellationToken) downloadCancelToken = result.cancellationToken;
    // ★ A transfer this build declined is given up the moment its handle exists,
    // because a check has ALREADY told the library to fetch by the time we are
    // asked about it (autoDownload), and leaving 130MB arriving behind a card the
    // reader told us to stop showing is not what ending a transfer means.
    if (declinedFetch) declineFetchedTransfer();
    // ★ And the promise it returns is attached to here rather than left dangling.
    // It is the download itself, and until now nothing in this app awaited it: a
    // failed auto-download rejected into the void, which Electron reports as an
    // unhandled rejection. `error` is already handled above with the message a
    // person can read, so this catch only stops the second, uglier report.
    if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
  } catch {
    // Deliberately silent. electron-updater emits 'error' *and* rejects for the
    // same failure, so logging here too prints every update failure twice, which
    // is exactly what a first run against a repo with no releases did.
    // This catch exists only to stop the rejection going unhandled.
  }
}

/**
 * The newest published build, which electron-updater's own comparison refused.
 *
 * It is offered, not downloaded, and the difference is the dependency's rather
 * than ours: `downloadUpdate()` acts on the update the updater decided was
 * available, and it decided otherwise, so handing the refused version back to it
 * is not something this build can do. Telling the person and pointing at the
 * release is the honest version of the offer, and it is the same shape the
 * platforms that cannot install for themselves already get.
 *
 * The wording comes from the shared composition, so the sentence is the one
 * every other surface says about an available release, with the client's own
 * last line appended (see `pointer` in core/updates.js).
 */
function offerRefusedByUpdater(version) {
  const plan = updatePolicy();
  setLastCheck(`${version} available`);
  const { message, detail } = updates.checkAnswer({
    outcome: updates.AVAILABLE,
    version,
    current: app.getVersion(),
    action: plan.action,
    reason: plan.reason,
    pointer: 'The automatic updater cannot order the build number after the release, so install this one from the release page.',
  });
  // A better answer to the same question supersedes the answer to a manual check.
  clearNotice(UPDATE_ANSWER);
  setNotice('update-available', {
    tone: noticeStore.INFO,
    message,
    detail,
    action: { label: 'Open release page', command: 'update-release-page' },
  }, { announce: updates.announcesFound(lastTrigger) });
}

/**
 * A new version exists and this build is not fetching it by itself.
 *
 * A notice rather than a dialog, and it is the case that shows why: a new
 * release is not urgent, it is not an error, and it is true until acted on. As a
 * dialog it stole focus from whatever was being typed, got dismissed, and left
 * nothing on screen, so the app knew about a waiting update and had no way to
 * say so until the next six-hourly check came round.
 *
 * "Later" is the dismiss button every notice already has. What is left is one
 * offer, which is the shape a notice takes.
 */
function onUpdateAvailable(info) {
  const plan = updatePolicy();
  pendingManualCheck = false;
  offeredUpdate = info;
  // Cache the found release so a later manual press re-presents "an update is
  // available" from this record at once, rather than waiting on the network to
  // rediscover it.
  setLastCheck(`${info.version} available`, { outcome: updates.AVAILABLE, version: info.version });

  // ★ A check a person PRESSED is a question, and the answer belongs on screen:
  // the card it finds comes back even when that same card was read already,
  // because reading a notice was never a promise not to be told again. The
  // background check is the other half and stays quiet, leaving a read card where
  // it was (see announcesFound in core/updates.js). What announcing MEANS for
  // read state belongs to the store; this owns only which trigger is a person.
  const announce = updates.announcesFound(lastTrigger);

  // ★ What this check may fetch, and what it says while it does. One owner for the
  // decision, shared with the phone (updates.fetchPlan), because the rule is about
  // a READER rather than about this surface: nobody asked for this transfer, so it
  // says nothing until it has evidence of movement, and a version whose transfer
  // already ended here is not started again by itself at all.
  const record = suppressedUpdate();
  const suppressedVersion = record && record.version === info.version ? record.version : null;
  // A different release supersedes whatever the reader ended: the record is about
  // ONE transfer of ONE version, so it is dropped here rather than left to suppress
  // a build nobody has ever been offered.
  if (record && !suppressedVersion) clearUpdateSuppression();

  const fetch = updates.fetchPlan({
    action: plan.action,
    version: info.version,
    suppressedVersion,
    trigger: lastTrigger,
  });
  // The library has already started this transfer on its own (autoDownload), so
  // declining it means giving up the handle checkForUpdates() is about to return.
  // Only the suppressed BACKGROUND check declines: a press is an ask.
  declinedFetch = !fetch.fetch && plan.action === updates.INSTALL;

  // ★ The wording is composed BEFORE the branches below, because two of them tell
  // the reader the same news and must say it in the same words.
  //
  // The sentence the desktop puts in its banner is the one the phone puts in its
  // own. `checkAnswer` always answers for an available outcome: it gates one
  // direction only, the background check that found nothing, which is why there is
  // no fallback here.
  const { message, detail } = updates.checkAnswer({
    outcome: updates.AVAILABLE,
    version: info.version,
    current: app.getVersion(),
    action: plan.action,
    reason: plan.reason,
  });

  if (fetch.fetch) {
    // The answer to any manual check is superseded by this, which is a better
    // answer to the same question.
    clearNotice(UPDATE_ANSWER);
    // ★ AN AVAILABLE RELEASE IS NEWS, AND A QUIET TRANSFER IS NOT A QUIET
    // AVAILABILITY. These are two different cards and the background rule below
    // belongs to only one of them: "say nothing until there is evidence of
    // MOVEMENT" is about the progress card, whose whole content is how far a
    // transfer has got, and a card at zero percent is a claim with nothing behind
    // it. That a release EXISTS needs no evidence at all -- the check just read it
    // off the feed -- and it is the one thing a reader can act on. Suppressing it
    // with the transfer is how the app ends up telling nobody about an update
    // until they ask, which is worse than the card this rule was written for.
    //
    // The card carries no bar and no action, because the transfer is already
    // under way: it names the version and stops. The first progress event replaces
    // it with the progress card (one id, one card), and a transfer that produces
    // nothing leaves this sentence standing rather than a bar that never moved.
    if (fetch.quiet) {
      setNotice('update-available', { tone: noticeStore.INFO, message, detail });
    }
    // A quiet attempt draws ITSELF the moment it has something true to say; see
    // beginUpdateDownload and onDownloadProgress.
    beginUpdateDownload(info.version, { quiet: fetch.quiet, announce });
    return;
  }

  // No card and no fetch: this version's transfer ended here already, and it was
  // the reader who ended it. The silence is the point -- a card for it is the
  // dismissal undone by a relaunch -- and About's status line is where the state
  // is written down rather than re-announced (see statusLine).
  if (!fetch.offer) return;

  // The offer comes from the same decision, because which of the two is TRUE
  // depends on the policy action: a build that can install offers to fetch, while
  // one that cannot must point at the release page, where a button would do
  // nothing.
  // The answer to any manual check is superseded by this, which is a better
  // answer to the same question.
  clearNotice(UPDATE_ANSWER);
  setNotice('update-available', {
    tone: noticeStore.INFO,
    message,
    detail,
    action: fetch.offer === updates.OFFER_INSTALL
      ? { label: 'Download and install', command: 'update-download' }
      : { label: 'Open release page', command: 'update-release-page' },
  }, { announce });
}

/** The offer taken up: fetch it now, without touching the standing preference. */
async function downloadOfferedUpdate() {
  if (!updater || !offeredUpdate) return;
  const version = offeredUpdate.version;
  // Taking the offer up is the reader asking for this transfer by hand, which is
  // the one event that ends a suppression: the record says "not on your own".
  clearUpdateSuppression(version);
  // Straight to downloadUpdate rather than flipping autoDownload: this is a
  // one-off yes to this version, not a change to the preference.
  beginUpdateDownload(version);
  setLastCheck(`downloading ${version}`);
  try {
    // The token if we hold one, so this transfer is cancellable too. The library
    // defaults to a fresh one otherwise, which is the case where an abandoned
    // download really is only abandoned in the UI.
    await updater.downloadUpdate(downloadCancelToken || undefined);
  } catch (err) {
    // A cancel is not a failure. If the reader cleared this attempt, the transfer
    // rejecting is the intended end of it and a failure card here would be exactly
    // the resurrected card the clear was for.
    if (downloadAttempt === clearedAttempt) return;
    // The 'error' event above has already settled the card with the same news, so
    // this only covers the rejections that arrive without one.
    if (downloadCardRaised) settleFailedDownload(err);
    else setLastCheck('download failed');
  }
}

/**
 * The notice shown while an update is arriving.
 *
 * One shape, raised from two places: a build that downloads on its own (Windows,
 * and a macOS signed with a Developer ID) and the manual offer being taken up.
 * Both put the same thing on screen, because from this side of it something is
 * arriving either way and the only question the notice answers is how far it
 * has got.
 *
 * ★ Dismissible, and its X CLEARS rather than reads (`dismissClears`). It used to
 * refuse the X, on the reasoning that the ready notice replaces it within seconds
 * so a bar that reappeared on the next whole percent would be worse than one with
 * no control at all. That reasoning was right about the reappearing and wrong
 * about the remedy, and the remedy is what Abi hit on 2026-09-17: a download that
 * dies or never moves during a background check leaves this card on screen at 0%
 * with no X, excluded from "Mark all read" as well, and there is then NOTHING on
 * the bar that can take it away. A card with no way out is the one people learn to
 * ignore, so the control is here and the reappearing is fixed where it belongs:
 * the raise is dropped for an attempt the reader has cleared (see
 * `abandonUpdateDownload`).
 *
 * The wording comes from shared core (`downloadingMessage`), which also decides
 * whether the offered number is above the one running: a build numbered below the
 * running one is not an upgrade for being half downloaded either.
 */
function downloadingNotice(version, info) {
  const { message, detail } = updates.downloadingMessage({
    version,
    current: app.getVersion(),
    transfer: updates.transferDetail(info),
  });
  return {
    tone: noticeStore.INFO,
    message,
    detail,
    // The X is offered, and it means "stop reporting this" rather than "I have
    // seen this", which is what makes it leave the store rather than go read.
    dismissible: true,
    dismissClears: true,
    progress: updates.downloadProgress(info),
  };
}

/** The notice shown when a download has produced nothing for the stall window. */
function stalledNotice(version) {
  const { message, detail } = updates.stalledMessage({
    version,
    current: app.getVersion(),
    stallMs: updates.STALL_MS,
  });
  return {
    tone: noticeStore.WARN,
    message,
    detail,
    // No progress bar. The bar is the thing that was lying: it drew a position for
    // a transfer that has not moved, and leaving it on screen at whatever percent
    // it stopped at is the same fault one state over.
    dismissible: true,
    dismissClears: true,
    // The one action a notice may offer, and the honest one: nothing here can
    // restart a transfer this app did not start, and the release page is always
    // reachable. Retry is deliberately NOT offered as a second control, because the
    // library's own download is the only handle this build has on one (see
    // abandonUpdateDownload) and a button that quietly did nothing would be this
    // same bug in a new place.
    action: { label: 'Open release page', command: 'update-release-page' },
  };
}

// The whole percent last drawn. A number rather than nullable, because the
// first event of a download is the one that has to be allowed through.
let lastProgressPercent = 0;

/*
 * The download phase, as state.
 *
 * ★ `downloadAttempt` is what makes an abandoned card stay abandoned. Every event
 * the updater emits belongs to the attempt that was current when it was emitted,
 * and an attempt the reader has cleared is one this app has stopped reporting on:
 * the transfer may genuinely still be running (see abandonUpdateDownload), and the
 * one thing that must not happen is the next chunk sliding the card back onto the
 * bar as though the reader had never touched it.
 *
 * A NEW attempt is a new generation, so an offer raised by a later check -- or by
 * the reader taking up a later offer -- comes back normally. That is the whole
 * "must not immediately re-offer itself" rule: not this attempt, again, now.
 */
let downloadAttempt = 0;
let clearedAttempt = -1;
let downloadVersion = null;
let downloadStartedAt = 0;
// ★ Whether this attempt is one nobody asked for. A quiet attempt raises no card
// until a progress event gives it something true to say, and stays off the bar
// entirely if it never moves: see beginUpdateDownload and onDownloadStall.
let downloadQuiet = false;
// The last evidence of MOVEMENT: the attempt starting, or any progress event. The
// stall window is measured from here rather than from downloadStartedAt, which is
// what lets a slow download run as long as it likes without being cut off.
let downloadMovedAt = 0;
let downloadWatchdog = null;
// Whether a card for an arriving update is on the bar, so a late failure can tell
// "settle the card I already raised" from "report something nobody asked about".
let downloadCardRaised = false;

/** Stop the stall watchdog, if one is armed. */
function stopStallWatch() {
  if (!downloadWatchdog) return;
  clearTimeout(downloadWatchdog);
  downloadWatchdog = null;
}

/**
 * Arm (or re-arm) the stall watchdog.
 *
 * Re-armed on every progress event, so what it measures is silence rather than
 * elapsed time, and `updates.stallRemaining` decides how much of the window is
 * left so a late timer re-arms for the remainder instead of restarting it.
 */
function armStallWatch() {
  stopStallWatch();
  const remaining = updates.stallRemaining(Date.now() - downloadMovedAt);
  downloadWatchdog = setTimeout(onDownloadStall, Math.max(1000, remaining));
  // Never a reason to hold the process open: quitting with a download in flight
  // must not wait on a timer whose only job is to change a card.
  if (typeof downloadWatchdog.unref === 'function') downloadWatchdog.unref();
}

/**
 * The transfer has said nothing for the window: say so, and stop calling it progress.
 *
 * This is the fix for the bar that sat at 0%. It cancels NOTHING, which is the
 * point: a download that is merely slow is indistinguishable from a dead one until
 * something arrives, so the state it moves to says what is known ("nothing has
 * arrived for 45 seconds, it has not been cancelled") and offers what is actually
 * actionable, rather than cutting off a transfer that was going to finish.
 */
function onDownloadStall() {
  downloadWatchdog = null;
  if (downloadAttempt === clearedAttempt) return;
  if (!downloadCardRaised) {
    // ★ A background fetch that produced nothing at all. Nothing was ever shown,
    // so there is nothing to take away and nothing to announce: what is recorded
    // is that this version's transfer did not move here, which is what stops the
    // next launch (and the next check) from starting it again only to sit at a
    // card that never changes.
    if (downloadQuiet) suppressUpdate(downloadVersion, 'stalled');
    return;
  }
  const percent = lastProgressPercent;
  console.warn(`[claw-desktop] update download stalled at ${percent}% after ${Math.round(updates.STALL_MS / 1000)}s with no progress event`);
  showUpdateNotice(stalledNotice(downloadVersion || 'the update'));
}

/**
 * Raise the update card, unless the reader has cleared the attempt it belongs to.
 *
 * Every raise of this id goes through here for that reason: one raise that skipped
 * the gate would put the abandoned card back for the next chunk of a transfer the
 * reader already told the app to stop reporting on.
 */
function showUpdateNotice(notice, { announce = false } = {}) {
  if (downloadAttempt === clearedAttempt) {
    downloadCardRaised = false;
    return;
  }
  downloadCardRaised = true;
  setNotice('update-available', notice, { announce });
}

/**
 * Start a download's notice, and let the next percent through.
 *
 * ★ `quiet` is the background fetch, and it is the reported bug's fix. A card
 * that says "Downloading X" with a bar at zero is a claim about movement made
 * before any movement has happened; for a transfer the reader never asked for,
 * that claim is drawn from nothing but having asked the feed for the file. So a
 * quiet attempt arms everything the loud one does -- the state machine, the stall
 * window -- and raises NOTHING until a progress event arrives, at which point the
 * card it draws has evidence behind it. If nothing ever arrives, no card was ever
 * raised to lie about it, and onDownloadStall records that instead of announcing
 * it. Only the press path raises at zero, because a person who asked is owed the
 * card immediately.
 */
function beginUpdateDownload(version, { quiet = false, announce = false } = {}) {
  downloadAttempt += 1;
  downloadVersion = version;
  downloadStartedAt = Date.now();
  downloadMovedAt = downloadStartedAt;
  lastProgressPercent = 0;
  downloadQuiet = quiet;
  if (quiet) downloadCardRaised = false;
  else showUpdateNotice(downloadingNotice(version, { percent: 0 }), { announce });
  armStallWatch();
}

/**
 * Give up a transfer this build declined to make. See fetchPlan() in
 * core/updates.js for when that is, and checkForUpdates() for why the decision
 * and the cancel are two steps: the handle the library hands back does not exist
 * yet at the moment the offer arrives.
 *
 * A failed cancel is not reported to the reader: the attempt was never shown to
 * them, so there is no card to settle and nothing they could do about it.
 */
function declineFetchedTransfer() {
  declinedFetch = false;
  const token = downloadCancelToken;
  downloadCancelToken = null;
  if (!token) return;
  try {
    token.cancel();
    console.log('[claw-desktop] update download given up: this version is not fetched on its own');
  } catch (err) {
    console.warn(`[claw-desktop] could not give up the declined update download: ${err && err.message}`);
  }
}

/**
 * The reader cleared the card: give up the transfer as well as the card.
 *
 * ★ WHETHER A DOWNLOAD CAN REALLY BE CANCELLED, answered plainly because the
 * question decides what this function is allowed to claim.
 *
 * electron-updater has no `cancel()`. The only handle it exposes is the
 * `CancellationToken` that `checkForUpdates()` returns, which is the token the
 * download it starts on its own was given (`doCheckForUpdates` passes it straight
 * to `downloadUpdate`), and which `downloadUpdate()` also accepts as an argument.
 * So: a transfer this app started, or a check that started one, CAN be cancelled,
 * and is -- the transport behind it observes the token and aborts. What cannot be
 * cancelled is the library's native hand-off on macOS, where Squirrel.Mac is asked
 * to fetch the already-downloaded zip from a loopback proxy; that step has no token
 * and no cancel, and there it really is abandonment in the UI only.
 *
 * Either way the UI half is identical, and it is the half this function has to get
 * right: the attempt is marked cleared BEFORE the token is cancelled, because a
 * cancel makes the library emit back into these very handlers, and the promise it
 * settles with must land on an attempt nobody is reporting rather than raising a
 * failure card for something the reader deliberately ended.
 */
function abandonUpdateDownload() {
  stopStallWatch();
  // ★ The version is read BEFORE the state is cleared, because the record below
  // is written in its name and there is nothing to name once this has run.
  const version = downloadVersion || (offeredUpdate && offeredUpdate.version) || null;
  clearedAttempt = downloadAttempt;
  downloadCardRaised = false;
  downloadVersion = null;
  downloadMovedAt = 0;
  downloadQuiet = false;
  // ★ Written to disk, not only done to the screen. This card is raised again by
  // a check that runs on every launch, so a clear that lived only in memory was
  // undone by quitting and reopening the app -- which is the reported bug.
  suppressUpdate(version, 'cleared');

  const token = downloadCancelToken;
  downloadCancelToken = null;
  if (!token) return;
  try {
    token.cancel();
    console.log('[claw-desktop] update download cancelled at the reader\'s request');
  } catch (err) {
    // Already settled, which is the ordinary case for a download that finished
    // between the card being drawn and the X being pressed.
    console.warn(`[claw-desktop] could not cancel the update download: ${err && err.message}`);
  }
}

/**
 * Give up on a download the library itself reported as failed.
 *
 * Called from the updater's `error` handler for EVERY trigger, which is the other
 * half of the stuck card. A check failure is still silent when nobody pressed
 * anything -- that rule is unchanged and is about not interrupting someone to
 * report a flaky network -- but a download that dies is a different thing
 * entirely: the app has ALREADY put a card on the screen saying it is fetching
 * this build, so leaving that card up at its last percent is not silence, it is a
 * report that has stopped being true. Settling it is the app finishing the
 * sentence it started, not a new interruption.
 */
function settleFailedDownload(err) {
  stopStallWatch();
  downloadCancelToken = null;
  downloadQuiet = false;
  if (!downloadCardRaised) return;
  if (downloadAttempt === clearedAttempt) return;
  const version = downloadVersion || (offeredUpdate && offeredUpdate.version) || 'the update';
  downloadCardRaised = false;
  downloadVersion = null;
  setNotice('update-available', {
    tone: noticeStore.WARN,
    message: `Could not download ${chrome.APP_NAME} ${version}.`,
    detail: `${noticeStore.sentence((err && err.message) || err)} The next check will try again.`,
    action: { label: 'Open release page', command: 'update-release-page' },
  });
}

/**
 * How far the download has got.
 *
 * Throttled to whole percents, because electron-updater fires this several
 * times a second and every raise re-renders a card in another process. The
 * store would also report each one as a change, since the detail text moves
 * with the byte count, so without this a 130MB download sends hundreds of
 * renders to say one thing.
 */
function onDownloadProgress(info) {
  // An abandoned attempt is not reported on. The transfer may still be running
  // (abandonUpdateDownload says which half can be cancelled), and the one thing
  // that must not happen is this card sliding back onto the bar for a chunk the
  // reader asked not to watch.
  if (downloadAttempt === clearedAttempt) return;

  // ★ Movement is recorded BEFORE the whole-percent throttle, and that ordering is
  // the whole "stalled versus slow" answer. electron-updater reports a float
  // percent per chunk, so a slow transfer can spend a long time between two whole
  // percents while moving perfectly well; counting only the throttled raises would
  // call that a stall. Every event is evidence, and the watchdog is re-armed on
  // every one of them, so the window measures silence rather than elapsed time.
  downloadMovedAt = Date.now();
  armStallWatch();

  const percent = Math.round(Number(info && info.percent) || 0);
  if (percent === lastProgressPercent) return;
  lastProgressPercent = percent;
  const version = downloadVersion || (offeredUpdate && offeredUpdate.version) || 'the update';
  // A late event puts the card back to progress, because that is what it is: the
  // stall card says nothing arrived for the window, and something just did.
  showUpdateNotice(downloadingNotice(version, info));
}

function onUpdateDownloaded(info) {
  stopStallWatch();
  downloadCancelToken = null;
  downloadCardRaised = false;
  downloadVersion = null;
  downloadQuiet = false;
  // The transfer ARRIVED, so anything a record said about it not arriving has
  // stopped being true. Cleared rather than left to rot: a suppression is about
  // one transfer, and this one is finished.
  clearUpdateSuppression(info.version);
  updateReady = info.version;
  offeredUpdate = info;
  lastProgressPercent = 0;
  clearNotice(UPDATE_ANSWER);
  setLastCheck(`${info.version} downloaded, install to apply`);
  buildTray(); // so "Install update" appears in the tray as well
  // ★ The clear does NOT survive a completion, and that is deliberate rather than
  // an oversight. Clearing a card says "stop reporting THIS transfer", and a
  // finished download is a different condition with a different offer behind it
  // (there is now something on disk worth restarting into). What is never restored
  // is a progress card for a transfer the reader stopped watching -- the phase they
  // actually dismissed.
  clearedAttempt = -1;
  // Dismissible, by Abi's call on 2026-09-15. It used to refuse the X, on the
  // reasoning that it was the only route to a restart that had already been
  // paid for. It is not the only route: the tray and the menu bar both carry
  // the same offer for as long as updateReady is set, and reading a notice has
  // never cleared the condition behind it, so the app still knows the update is
  // sitting on disk. A card with no way out is the one people learn to ignore,
  // which costs more than the restart it was protecting.
  setNotice('update-available', {
    tone: noticeStore.OK,
    message: `${chrome.APP_NAME} ${info.version} is ready.`,
    detail: 'Install it now, or keep working and install it later.',
    action: { label: 'Install update', command: 'update-restart' },
  });
}

/** Take the restart. */
function restartForUpdate() {
  if (!updater || !updateReady) return;
  quitting = true;
  // isSilent false so the installer's progress is visible; isForceRunAfter so
  // the app comes back rather than leaving the user staring at a closed window.
  updater.quitAndInstall(false, true);
}

/**
 * What the About box shows, gathered in one place so the page and any future
 * caller cannot disagree about it.
 *
 * Every line is something someone gets asked for when reporting a problem and
 * cannot look up for themselves: which build this is, what it does about new
 * versions and when it last looked, and the runtime a rendering bug would be
 * blamed on. The Control UI this build targets is on that list for the same
 * reason, and it is the one line here that is not about this app: we wrap
 * someone else's product, so "which version of it" is the first thing a
 * rendering bug report has to answer.
 */
// The names people read for a platform, in the one place About formats its own
// facts. `process.platform` is a machine token; About is where a human reads it.
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function aboutState() {
  const plan = updatePolicy();
  return {
    version: app.getVersion(),
    build: buildInfo.describe(app.getVersion(), buildStamp),
    channel: updates.channelOf(app.getVersion()) || 'stable',
    updateStatus: updates.statusLine({
      action: plan.action,
      reason: plan.reason,
      channel: updates.channelOf(app.getVersion()),
      checkedAt: lastCheck.at,
      result: lastCheck.result,
      // A version this app has been told not to fetch on its own is a state the
      // reader has to be able to FIND, or the silence reads as the app having
      // forgotten the release. This box is where someone goes to ask.
      suppressed: suppressedUpdate(),
    }),
    // The About box is where someone goes to ask "is it even updating?", so it
    // has to be able to answer "no, and here is the switch" as well as "yes".
    autoUpdate: config.get().autoUpdate !== false,
    canInstall: plan.canInstall,
    capabilityReason: plan.capabilityReason,
    checking: pendingManualCheck,
    updateReady,
    // The facts the page draws, formatted here rather than in the page, because
    // the page is sandboxed and cannot require the modules that know the rules,
    // and because what this client runs on is this client's to describe: the
    // phone's About renders its own list from its own host. A `{ label, value }`
    // per row, all strings. See renderFacts in core/ui/about.js.
    //
    // The build stamp, the runtime and the config path used to be a raw string
    // in the settings footer; that footer is now the way into this page, so its
    // diagnostic detail lives here instead. The commit and build date ride on the
    // header `build` line above (buildInfo.describe), and these rows carry the
    // rest. The config path is read at runtime from the real environment rather
    // than hardcoded, which is the whole reason it cannot live in a committed
    // file: config.path() answers where this install actually keeps it.
    facts: [
      { label: 'Version', value: app.getVersion() },
      { label: 'Channel', value: updates.channelOf(app.getVersion()) || 'stable' },
      { label: 'Electron', value: `${process.versions.electron} · Chromium ${process.versions.chrome}` },
      // The version comes from the same helper the client-context block sends, so
      // what About shows and what an agent is told cannot disagree. Deliberately
      // not os.release(): on macOS that is the Darwin kernel, which read as
      // "macOS 25.6.0" on a machine running 26.6.2 (measured 2026-09-17).
      { label: 'Platform', value: `${PLATFORM_NAMES[process.platform] || process.platform} ${promptMetadata.osRelease()} ${process.arch}` },
      { label: 'Config', value: config.path() },
    ],
    // The Control UI this build targets, and the two fields the shared page
    // composes its line from. Passed as the pin's own fields rather than as a
    // finished string, because the page draws this row for both clients and one
    // sentence in one place is what keeps the desktop's About and the phone's
    // About from describing the same revision two ways. See controlUILine in
    // core/ui/about.js.
    controlUI: {
      version: upstreamReference.upstream.version,
      commit: upstreamReference.upstream.commit,
    },
    releasesUrl: RELEASES_URL,
  };
}

/**
 * Push a fresh About state into the box if it happens to be open.
 *
 * Without this, clicking "Check for updates" from inside About would leave the
 * status line it is sitting under saying "no check yet this run", the one
 * question the box exists to answer, answered wrongly, immediately after the
 * user did the thing that changed it.
 */
function notifyAboutChanged() {
  const view = overlayViews.get('about');
  if (view && !view.webContents.isDestroyed()) view.webContents.send('app:about-changed');
}

/**
 * Tell the app's own pages that `currentState()` has moved under them.
 *
 * Settings renders from a snapshot it fetched when it opened, so without this a
 * certificate refused *while it is on screen*, which is exactly what happens
 * when you press Reconnect from inside it, would not appear until it was
 * closed and reopened.
 */
function notifyStateChanged() {
  for (const view of overlayViews.values()) {
    if (!view.webContents.isDestroyed()) view.webContents.send('app:state-changed');
  }
  // The cover is the one page whose entire content is the connection, so it is
  // the one that must never miss this. Left out, it renders once at whatever
  // the phase was when it loaded and keeps saying it, which reads as an app
  // stuck connecting long after the attempt stopped.
  if (loadingView && !loadingView.webContents.isDestroyed()) loadingView.webContents.send('app:state-changed');
  if (settingsIsPage && page()) page().send('app:state-changed');
}

/**
 * The About box, as one of the app's own overlay pages.
 *
 * Reachable from the menu bar and from the tray. The tray matters more than it
 * looks: Windows runs with `autoHideMenuBar`, so the menu bar is behind an Alt
 * press that nobody discovers, which is exactly how a build with a working
 * "Check for updates…" can still read as having none.
 */
function showAbout() {
  showMainWindow();
  openOverlay('about');
}

/**
 * Every command the menu bar and the tray can run, defined once.
 *
 * One definition per command, so a label or a behaviour cannot differ between
 * the places it appears, which is half of what keeps the platforms identical.
 * src/menus.js arranges them; see the note at the top of that file for the
 * differences the operating systems impose and why nothing of ours hides behind
 * one.
 */
function menuCommands() {
  return {
    about: { label: `About ${chrome.APP_NAME}`, click: () => showAbout() },
    checkUpdates: { label: 'Check for updates…', click: () => { void checkForUpdates('manual'); } },
    releaseNotes: { label: 'Release notes', click: () => { void shell.openExternal(RELEASES_URL); } },
    settings: { label: 'Settings…', click: () => openSettings() },
    reload: {
      label: 'Reload',
      click: () => {
        // Marked before the reload so the socket the outgoing document closes is
        // read as this app's own doing rather than as the gateway going away; see
        // `pageReloading` and the drop handler.
        pageReloading = true;
        if (settingsIsPage) loadActiveGateway();
        else page()?.reload();
      },
    },
    // Browsers pass `ignoreCache` here and this deliberately does not, because the
    // payload is not what Reload is for. Reload is the browser's own command and
    // keeps its meaning; the two ways the Control UI is brought current are the
    // freshness the load above forces and the clear below, which is the one the
    // menu documents as the escape hatch when the interface looks wrong anyway.
    reconnect: { label: 'Reconnect to gateway', click: () => loadActiveGateway() },
    clearCache: { label: 'Clear cache and reload', click: () => { void clearCacheAndReload(); } },
    quit: { label: `Quit ${chrome.APP_NAME}`, click: () => { quitting = true; app.quit(); } },
    zoomIn: { label: 'Zoom In', click: () => setZoom(0.5) },
    zoomOut: { label: 'Zoom Out', click: () => setZoom(-0.5) },
    actualSize: { label: 'Actual Size', click: () => setZoom(0, 0) },
    devTools: { label: 'Toggle Developer Tools', click: () => page()?.toggleDevTools() },
  };
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus.template({
    platform: process.platform,
    // chrome.APP_NAME, not app.name: app.name is pinned to the keychain
    // identity above, which is deliberately not the name on the menu.
    appName: chrome.APP_NAME,
    commands: menuCommands(),
  })));
}

/* ------------------------------------------------------------------ tray */

function buildTray() {
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip(chrome.APP_NAME);
    tray.on('click', () => (process.platform === 'darwin' ? tray.popUpContextMenu() : toggleMainWindow()));
    tray.on('double-click', showMainWindow);
  }
  const cfg = config.get();
  // The same command objects the menu bar uses, so a label or a behaviour cannot
  // differ between the two places someone might reach for it.
  const cmd = menuCommands();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${chrome.APP_NAME}`, click: showMainWindow },
    // Only once there is genuinely something to install. A permanently present
    // "Install update" that usually does nothing teaches people to ignore it,
    // which is the opposite of what it is for.
    ...(updateReady ? [{
      label: `Install update to ${updateReady}`,
      click: () => { quitting = true; updater.quitAndInstall(false, true); },
    }] : []),
    // The tray copies bring the window forward first. Reloading something
    // nobody can see is not what anyone means by clicking these from a tray.
    { ...cmd.reconnect, click: () => { showMainWindow(); loadActiveGateway(); } },
    { ...cmd.clearCache, click: () => { showMainWindow(); void clearCacheAndReload(); } },
    { type: 'separator' },
    {
      label: 'Gateway',
      submenu: cfg.gateways.map((g) => ({
        label: g.label || g.url,
        type: 'radio',
        checked: g.id === cfg.activeGatewayId,
        click: () => switchGateway(g.id),
      })),
    },
    cmd.settings,
    // On the tray as well as the menu bar, because Windows hides the menu bar
    // behind an Alt press: a build that updates itself perfectly still looks
    // like one with no updater anywhere in it.
    cmd.checkUpdates,
    cmd.about,
    { type: 'separator' },
    cmd.quit,
  ]));
}

function switchGateway(id) {
  config.update({ activeGatewayId: id });
  buildTray();
  showMainWindow();
  loadActiveGateway();
}

/* ------------------------------------------------------- shortcut / startup */

function registerShortcut() {
  globalShortcut.unregisterAll();
  const result = attemptShortcut();
  // An ongoing condition rather than an event: the shortcut stays dead until
  // the accelerator is changed or whatever owns it lets go. Saving Settings
  // runs this again, so a fixed one clears itself.
  if (result.ok) clearNotice('shortcut');
  else {
    setNotice('shortcut', {
      tone: noticeStore.WARN,
      message: 'The global shortcut is not active.',
      detail: `${config.get().globalShortcut} could not be registered. ${noticeStore.sentence(result.error)}`,
      // The fix is a field on Settings, so the notice takes you to it rather than
      // telling you to go: every notice here must be actionable, or it is a
      // paragraph charging rent on the top of the window.
      action: { label: 'Open Settings', command: 'settings' },
    });
  }
  return result;
}

function attemptShortcut() {
  const accel = config.get().globalShortcut;
  if (!accel) return { ok: true };
  try {
    const ok = globalShortcut.register(accel, toggleMainWindow);
    return { ok, error: ok ? null : 'Another application already owns that shortcut.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Apply the login-item setting and put a failure on the banner.
 *
 * Worth a banner rather than a line in a log because it fails *silently and
 * later*: the checkbox stays ticked, and the only symptom is the app not being
 * there after the next reboot -- by which time nothing connects the two.
 */
function reportLaunchAtLogin() {
  const result = applyLaunchAtLogin();
  if (result.ok) clearNotice('login-item');
  else {
    setNotice('login-item', {
      tone: noticeStore.WARN,
      message: `${chrome.APP_NAME} will not open at login.`,
      detail: `${noticeStore.sentence(result.error)} The setting is saved, but the system refused it.`,
      action: { label: 'Open Settings', command: 'settings' },
    });
  }
  return result;
}

function applyLaunchAtLogin() {
  const { launchAtLogin, startHidden } = config.get();

  // Linux takes a different route to the same setting. app.setLoginItemSettings
  // is `@platform darwin,win32`; on Linux it neither works nor throws, so the
  // checkbox would stay ticked and nothing would ever launch. autostart.js
  // writes the XDG entry every desktop environment reads instead.
  if (process.platform === 'linux') {
    const r = autostart.apply({ enabled: launchAtLogin, hidden: startHidden });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // Only touch the login item when something needs to change. An unpackaged dev
  // run has no registerable app bundle, so calling this unconditionally makes
  // macOS log "Unable to set login item: Operation not permitted" on every start.
  let current = false;
  try {
    current = app.getLoginItemSettings().openAtLogin;
  } catch { /* unsupported on this platform */ }
  if (current === launchAtLogin) return { ok: true };
  try {
    app.setLoginItemSettings({ openAtLogin: launchAtLogin, openAsHidden: startHidden, args: startHidden ? ['--hidden'] : [] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------- gateway test */

// Reachability probe for the settings screen. Deliberately does NOT grant trust:
// when the TLS chain is rejected we retry with verification off purely to read
// back the fingerprint, and report it so the user can compare it to the prompt.
/* ------------------------------------------------- is this a gateway at all? */

// Whether an address is an OpenClaw gateway, asked BEFORE a web view is pointed
// at it.
//
// Answering is not identifying, and this app used to conflate the two: any reply
// under 500 was "Reachable", and the connect path went further and loaded the
// address unconditionally. So a typo that landed on a captive portal, a router's
// admin page, or a different service on the same host was painted behind the
// app's own chrome, and the reader was left to work out from the page itself that
// it was not their gateway. Measured on 2026-09-16: `http://127.0.0.1:1/` failed
// correctly while a stranger's page on a reachable port was accepted whole.
//
// The rule and the sentences are core/gateway-identity.js's, which both clients
// read, so this file only makes the requests and hands over what came back. What
// it is and is not is the spec's to say, and the short version is that it is a
// correctness boundary rather than a security one: it authenticates nothing and
// does not defend against a host that means to impersonate OpenClaw.

/** How many redirects the document request follows before the answer is taken as final. */
const PROBE_REDIRECTS = 3;

const REDIRECT_CODES = [301, 302, 303, 307, 308];

// The TLS failures that mean "a gateway on its own listener", which is the one
// failure worth asking about twice: a gateway on :18789 presents a self-signed
// certificate by design, so the second attempt is how the fingerprint is read at
// all. Anything else is the host not answering and is reported as such.
const TLS_REFUSALS = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'];

/**
 * One GET, following a bounded number of redirects, reading at most the window the
 * identity rule searches.
 *
 * The body is read rather than discarded because the required signal lives IN it:
 * a header is the cheapest thing on the wire to copy, and OpenClaw's own marker on
 * `<html>` is what actually proves the payload. The read is bounded by the spec's
 * window so an address that streams forever cannot hold the probe open, and the
 * marker sits on the opening tag of every build measured.
 *
 * @returns {Promise<{status?: number, contentType?: string, headers?: object, body?: string, fingerprint?: string|null, error?: string, tlsRefused?: string}>}
 */
function probeRequest(target, rejectUnauthorized, redirectsLeft = PROBE_REDIRECTS) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(target);
    } catch {
      return resolve({ error: 'That is not a valid URL.' });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized,
        timeout: 8000,
        servername: url.hostname,
        headers: { accept: 'text/html,application/json;q=0.9' },
      },
      (res) => {
        let fingerprint = null;
        if (!rejectUnauthorized && res.socket.getPeerCertificate) {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.fingerprint256) fingerprint = `sha256/${Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64')}`;
        }
        // A redirect is followed rather than judged, because the answer worth
        // identifying is what the reader would actually be shown: a gateway
        // mounted behind a proxy that bounces `/` to `/chat/main` is a real
        // gateway, and refusing it on the strength of its 301 would be exactly the
        // too-strict failure this check has to avoid.
        if (REDIRECT_CODES.includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            return resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', headers: res.headers, body: '', fingerprint });
          }
          return resolve(probeRequest(next, rejectUnauthorized, redirectsLeft - 1));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size >= gatewayIdentity.MAX_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8').slice(0, gatewayIdentity.MAX_BYTES),
          fingerprint,
        }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Timed out after 8s. Is the gateway running, and are you on the tailnet?' });
    });
    req.on('error', (err) => {
      if (rejectUnauthorized && TLS_REFUSALS.includes(err.code)) return resolve({ tlsRefused: err.code, error: `${err.code}: ${err.message}` });
      resolve({ error: `${err.code || 'Error'}: ${err.message}` });
    });
    req.end();
  });
}

/**
 * Everything the identity rule needs about one address.
 *
 * Two requests at most, and the second is the health marker and is allowed to
 * fail: it SUGGESTS a gateway-shaped service and cannot accept one on its own, so
 * a gateway that does not answer it loses nothing. The document request is the one
 * that decides, and it is made strict first and lenient second so that a gateway
 * on its own self-signed listener is still identified rather than refused.
 *
 * @param {string} rawUrl the address as configured
 * @returns {Promise<object>} the `observed` object core/gateway-identity.js classifies, plus `fingerprint`
 */
async function probeGateway(rawUrl) {
  const targets = gatewayIdentity.probeTargets(rawUrl);
  if (!targets.document) return { document: null, health: null, headers: {}, error: 'That is not a valid URL.' };

  let document = await probeRequest(targets.document, true);
  let fingerprint = null;
  if (document.tlsRefused) {
    fingerprint = null;
    const lenient = await probeRequest(targets.document, false);
    fingerprint = lenient.fingerprint || null;
    document = lenient;
  }
  if (document.error && !document.status) {
    return { document: null, health: null, headers: {}, error: document.error, fingerprint };
  }

  let health = null;
  for (const candidate of targets.health) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await probeRequest(candidate, true);
    if (answer.status) { health = answer; break; }
  }

  return {
    document: { status: document.status, contentType: document.contentType, body: document.body },
    health: health ? { status: health.status, contentType: health.contentType, body: health.body } : null,
    headers: document.headers || {},
    fingerprint,
  };
}

/**
 * The verdict for an address, in the shape the settings page and the connect path
 * both read.
 *
 * `identity` is carried alongside `ok` rather than folded into it, because the two
 * accepted strengths are not the same claim and the caller may want to say which
 * one ran. `ok: true` with `identity.strength === 'corroborated'` means the payload
 * never identified itself directly and the address was accepted on its health
 * marker and headers, which is the weaker evidence and is worded that way.
 */
async function testGateway(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, status: null, message: 'That is not a valid URL.', fingerprint: null };
  }
  if (!/^https?:$/.test(target.protocol)) {
    return { ok: false, status: null, message: 'Use an http:// or https:// URL.', fingerprint: null };
  }

  const observed = await probeGateway(rawUrl);
  const verdict = gatewayIdentity.identify(observed);

  // The certificate note survives the identity check rather than being replaced
  // by it: a self-signed listener is still the routine state of a gateway on its
  // own port, and the reader still needs to be told they will be asked to trust
  // it once on connect.
  const message = observed.fingerprint && verdict.ok
    ? `${verdict.message} Its certificate is self-signed, so you will be asked to trust it once on connect.`
    : verdict.message;

  return {
    ok: verdict.ok,
    status: verdict.status,
    message,
    fingerprint: observed.fingerprint || null,
    identity: { accepted: verdict.ok, strength: verdict.strength, evidence: verdict.evidence },
  };
}

/* ------------------------------------------- refusing an address before loading */

// What has already been identified in this run, per gateway, so the check does
// not run again on every retry.
//
// The pairing cadence reissues the connect every few seconds while a device waits
// for approval, and a probe on each of those beats would be two extra requests per
// beat against a gateway that is already busy being approved. Keyed by the
// gateway's id AND its URL, so editing an address re-probes it and switching
// between two gateways does not reuse one's answer for the other's.
const identifiedGateways = new Map();

function identityKey(gw) {
  return `${gw.id} ${gw.url}`;
}

/**
 * Whether this gateway has already been identified in this run, and as what.
 *
 * Exported through the module scope rather than written per call site so the
 * connect path, the retry cadence and the settings button cannot disagree about
 * what is already known.
 */
function knownIdentity(gw) {
  return identifiedGateways.get(identityKey(gw)) || null;
}

/**
 * Identify a gateway before the web view is pointed at it, and refuse it when the
 * address is not an OpenClaw payload.
 *
 * This is the half that matters, because "Test connection" is a button someone
 * presses and this is every connect. The reader is told plainly what the address
 * answered and that nothing was loaded, rather than being shown whatever it serves:
 * that is the whole difference between this and the behaviour it replaces.
 *
 * A failure here is NOT a connection failure and is deliberately not dressed as
 * one. `connection` reports whether the gateway answered, and an address that is
 * not a gateway at all is a different sentence with a different next step (check
 * the address, or add one that is running OpenClaw), so it goes out as its own
 * notice.
 *
 * @returns {Promise<boolean>} true when the reader may be sent to the address
 */
async function identifyBeforeConnect(gw) {
  const known = knownIdentity(gw);
  if (known) return known.accepted;

  // The row reports the attempt while the address is being identified, because a
  // probe is a network round trip and an 8s timeout on a host that is not there
  // would otherwise be eight seconds of silence where the app used to say
  // something. The reducer is used rather than a literal so an attempt issued
  // while a device waits for approval still HOLDS the pending phase.
  setConnection({
    gatewayId: gw.id,
    phase: connectionState.nextPhase(connection.phase, { type: 'connect' }),
    error: null,
  });

  const observed = await probeGateway(gw.url);
  const verdict = gatewayIdentity.identify(observed);
  // * ONLY AN ACCEPTANCE IS REMEMBERED. A refusal is a statement about the moment
  // rather than about the address: a gateway that is restarting answers nothing,
  // and one mid-upgrade answers the wrong thing. Remembering it made every later
  // attempt short-circuit at knownIdentity and return false WITHOUT a probe, so
  // pressing Try again did nothing at all until the process restarted -- Abi,
  // 2026-09-20: "the loading and try again pages seem to never work or I need to
  // restart the app before things will recover". The retry IS the moment to ask
  // again, so only the acceptance is kept, and a refusal clears any earlier one.
  if (verdict.ok) identifiedGateways.set(identityKey(gw), { accepted: true, strength: verdict.strength, message: verdict.message });
  else identifiedGateways.delete(identityKey(gw));

  if (verdict.ok) {
    // The weaker acceptance is logged where a support question would look, and it
    // is the only place the two strengths are told apart in the field.
    if (verdict.strength === gatewayIdentity.CORROBORATED) {
      console.warn(`[claw-desktop] ${gw.url} answers like an OpenClaw gateway but did not identify itself as one; accepted on its health marker and headers`);
    }
    return true;
  }

  console.warn(`[claw-desktop] refusing to load ${gw.url}: ${verdict.message}`);
  // FAILED rather than a new phase, because the connection really did not
  // establish: the row's own words (Cannot connect) are true, and the banner
  // carries the sentence that says why and what to do about it.
  setConnection({ gatewayId: gw.id, phase: connectionState.FAILED, error: null });
  setNotice('connection', {
    tone: 'error',
    message: `${gw.label || 'That address'} is not an OpenClaw gateway`,
    detail: verdict.message,
    action: { label: 'Open Settings', command: 'settings' },
  });
  return false;
}

/** Forget an address's verdict, so the next connect identifies it again. */
function forgetIdentity(gw) {
  if (gw) identifiedGateways.delete(identityKey(gw));
}


/* -------------------------------------------------------------------- IPC */

/** The host a gateway's URL points at, for matching a certificate offer to it. */
function gatewayHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function currentState() {
  const cfg = config.get();
  const offers = certs.pendingOffers();
  return {
    // Each gateway carries only whether a credential is set, never its value --
    // plus how its own connection is going, so the row that failed is the row
    // that says so. Formatted here because the page is sandboxed and cannot
    // require src/connection.js.
    gateways: cfg.gateways.map((g) => ({
      ...g,
      credentials: secrets.summary(g.id),
      status: connectionState.status({
        isActive: g.id === cfg.activeGatewayId,
        phase: g.id === connection.gatewayId ? connection.phase : connectionState.IDLE,
        error: g.id === connection.gatewayId ? connection.error : null,
        certOffer: offers.find((o) => o.host === gatewayHost(g.url)) || null,
      }),
    })),
    activeGatewayId: cfg.activeGatewayId,
    // The active connection as one field, for the loading cover, which asks
    // "still trying, or stopped?" and has no gateway row to read it out of.
    //
    // The milestone travels as the stage plus the wall-clock time it landed,
    // not as a percentage. The cover animates between stages on its own frame
    // clock; pushing a number would mean an IPC message per frame to move a
    // progress bar.
    connection: {
      gatewayId: connection.gatewayId,
      phase: connection.phase,
      milestone: connection.milestone,
      milestoneAt: connection.milestoneAt,
    },
    // Which client this is, and the split of the settings surface that belongs
    // to it. The page filters with these rather than each host doing it: the
    // spec is handed over as it stands, so there is one owner of the split and
    // the page is not a second one. See core/spec/settings.json.
    client: 'desktop',
    surface: settingsSpec,
    // What this build is running on, pre-formatted, for the line under the page.
    // The phone answers the same question with its iOS version, so the page
    // prints it rather than knowing what Electron is.
    runtime: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    // The product name, for the one line Settings prints about itself. The
    // page is sandboxed, so it cannot read core/naming.js the way this file
    // does, and this is the same arrangement as every other formatted value it
    // is handed.
    appName: product,
    secretsAvailable: secrets.available(),
    frameless: chrome.enabled(),
    secretsError: secrets.unavailableReason(),
    settings: {
      globalShortcut: cfg.globalShortcut,
      closeToTray: cfg.closeToTray,
      launchAtLogin: cfg.launchAtLogin,
      startHidden: cfg.startHidden,
      autoUpdate: cfg.autoUpdate !== false,
      promptMetadata: cfg.promptMetadata === true,
    },
    // Why the automatic-updates toggle is unavailable, where it is. A build
    // that could never install one has nothing to switch on, and saying so
    // beats a checkbox that silently does nothing.
    updates: (() => {
      const plan = updatePolicy();
      return { canInstall: plan.canInstall, reason: plan.capabilityReason };
    })(),
    trustedCerts: cfg.trustedCerts,
    // Certificates refused this session and waiting for a decision. This is
    // where the prompt went: Settings shows them, the error page points here.
    certOffers: offers,
    // The phase itself, not just the per-gateway badge. Settings uses it to
    // decide whether it is on screen because something failed -- which a
    // certificate warning would not tell it, since that is a warn, not an err.
    connection: { gatewayId: connection.gatewayId, phase: connection.phase, error: connection.error },
    platform: process.platform,
    // Pre-formatted rather than sent as parts: the settings page is sandboxed
    // and cannot require src/build-info.js, so formatting it there would mean a
    // second copy of the rules that would drift.
    build: buildInfo.describe(app.getVersion(), buildStamp),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    configPath: config.path(),
  };
}

function registerIpc() {
  ipcMain.handle('app:state', () => currentState());
  ipcMain.handle('app:test-gateway', (_e, url) => testGateway(url));
  // The same clear-and-reload the File menu and the tray offer, reached from the
  // About box rather than a second implementation of it: one path, so the two
  // cannot come to mean different things. It returns what it cleared, because the
  // reader pressed a button about their caches and is owed the effect rather than
  // a spinner.
  ipcMain.handle('app:clear-cache-and-reload', () => clearCacheAndReload());
  // The entry that was created, handed back so the page can store the credential
  // typed into the SAME form against the id this app just assigned. Without it
  // there is nothing to write a token to until the gateway has been reloaded
  // through Edit, which is exactly the second trip this replaces: one press
  // creates the gateway and keeps everything the form was given.
  ipcMain.handle('app:add-gateway', (_e, entry) => {
    const created = config.addGateway(entry);
    buildTray();
    return { ...currentState(), added: created };
  });
  ipcMain.handle('app:update-gateway', (_e, id, patch) => {
    config.updateGateway(id, patch || {});
    buildTray();
    // Headers are matched by origin, so a changed URL changes which requests
    // they belong to.
    applyHeaders(session.defaultSession);
    return currentState();
  });
  ipcMain.handle('app:remove-gateway', (_e, id) => {
    // Drop the credentials, but deliberately leave the origin's site data alone:
    // it holds the paired device identity, and wiping it would make a re-added
    // gateway look like a brand-new device and raise a fresh login alert. Use
    // the gateway's own `openclaw devices revoke` to actually sever a device.
    secrets.forget(id);
    config.removeGateway(id);
    buildTray();
    applyHeaders(session.defaultSession);
    return currentState();
  });
  // Token and password are applied at connect time, so no session work here.
  // Save before reading state back: currentState() reports the stored summary.
  ipcMain.handle('app:set-credentials', (_e, id, patch) => {
    const saved = secrets.set(id, patch || {});
    return { ...currentState(), saved };
  });
  ipcMain.handle('app:add-header', (_e, id, name, value) => {
    const res = secrets.addHeader(id, name, value);
    if (res.ok) applyHeaders(session.defaultSession);
    return { ...currentState(), saved: res };
  });
  ipcMain.handle('app:remove-header', (_e, id, name) => {
    const res = secrets.removeHeader(id, name);
    if (res.ok) applyHeaders(session.defaultSession);
    return { ...currentState(), saved: res };
  });
  ipcMain.handle('app:trust-cert', (_e, host) => {
    const offer = certs.trust(String(host));
    // Reconnecting is the whole point of having trusted it, and the failed load
    // that produced the offer left the window on the error page, so without
    // this the reward for making the decision is a page that still says the
    // connection failed.
    const gw = config.activeGateway();
    let activeHost = null;
    try { activeHost = gw ? new URL(gw.url).host : null; } catch { /* unparseable url, no reconnect */ }
    if (offer && offer.host === activeHost) loadActiveGateway();
    // The offer is answered, so the banner about it goes. clearNotice only when
    // this was the last one waiting; refreshCertNotice decides that.
    refreshCertNotice();
    return { ...currentState(), trusted: Boolean(offer) };
  });
  ipcMain.handle('app:dismiss-cert-offer', (_e, host) => {
    certs.dismiss(String(host));
    refreshCertNotice();
    return currentState();
  });
  ipcMain.handle('app:forget-cert', (_e, host) => {
    const cfg = config.get();
    const trustedCerts = { ...cfg.trustedCerts };
    delete trustedCerts[host];
    config.update({ trustedCerts });
    return currentState();
  });
  // Connect starts the connection and nothing else. Closing Settings here used
  // to be part of it, which meant the page vanished the instant you pressed the
  // button and the next thing you saw was either the Control UI or a failure, // with no moment in between that said which was coming. The connect runs
  // behind the page instead, the row reports it, and leaving is a second,
  // deliberate press once there is something to leave for.
  ipcMain.handle('app:connect', (_e, id) => {
    switchGateway(id);
    return currentState();
  });
  ipcMain.handle('app:save-settings', (_e, patch) => {
    config.update(patch);
    const shortcut = registerShortcut();
    const login = reportLaunchAtLogin();
    // Takes effect now rather than on the next launch: a preference that needs
    // a restart to mean anything is one the user cannot tell they have set.
    applyUpdatePreference();
    installPromptMetadata(page());
    buildTray();
    return { ...currentState(), shortcut, login };
  });
  ipcMain.handle('app:open-settings', () => { openSettings(); });
  ipcMain.handle('app:close-settings', () => { closeSettings(); });
  // The settings page's "Go to the Control UI": close OUR surface, then press the
  // Control UI's own footer control so the reader lands on the Control UI's
  // settings rather than on whatever the page happened to be showing. One
  // command, because both halves belong to one action, and the pressing itself is
  // the shared affordance script's job so the phone does the same thing with the
  // same bytes. Fail-soft but loud: a footer control that is not there leaves the
  // reader on the page and says so in the app's own stdout, rather than silently
  // doing nothing.
  ipcMain.handle('app:open-control-ui-settings', () => { openControlUiSettings(); });
  // The About page, reached from inside Settings rather than from the menu bar.
  // showAbout() is the same overlay path the menu and tray already open, so this
  // adds a route to About without a second way of opening it: About shown over
  // Settings stacks on top, and closeOverlay hands focus back to Settings when it
  // goes. It is the desktop's half of the shared `openAbout` settings command.
  ipcMain.handle('app:settings-open-about', () => { showAbout(); });

  // The app's own dialogs. `app:message` is what a freshly loaded message page
  // asks for; there is no push, so a page that reloads for any reason comes
  // back showing the same thing rather than an empty card.
  ipcMain.handle('app:close-overlay', (_e, name) => { closeOverlay(String(name)); });
  ipcMain.handle('app:about', () => aboutState());
  // The pairing screen's own read, and the report channel the injected observer
  // uses. The report is checked against the live gateway page rather than trusted
  // from wherever it arrived; see handlePairingReport.
  ipcMain.handle('app:pairing', () => pairingSnapshot());
  ipcMain.on('pairing:report', handlePairingReport);
  ipcMain.handle('app:check-updates', () => { void checkForUpdates('manual'); });
  ipcMain.handle('app:open-releases', () => shell.openExternal(RELEASES_URL));
  // The banner. It reports the height it needs rather than being given one: the
  // view swallows clicks over its whole rect, so main cannot guess at it.
  // What the banner draws, which is only what has not been acknowledged.
  ipcMain.handle('app:notices', () => notices.unread());
  ipcMain.handle('app:banner-bounds', (_e, bounds) => {
    // The card cluster's box, reported by ui/banner.js. Bounded like the sweep's,
    // so a page that reported nonsense could not size a view over the whole
    // window. Width is capped at the widest a card is allowed to be (see
    // banner.css --notice-card-max plus the cluster's own insets); the ceiling
    // here is generous of that so a future wider card is not clipped.
    const width = Math.max(0, Math.min(560, Math.ceil(Number(bounds && bounds.width) || 0)));
    const height = Math.max(0, Math.min(600, Math.ceil(Number(bounds && bounds.height) || 0)));
    // * A report of cards with NO width is a measurement taken in a viewport too
    // small to measure in, and it must not be adopted. The page reports {0, 0} when
    // the cluster is empty, and that is a real answer; a zero WIDTH with a height is
    // the cluster clamped by a view that has not been laid out yet, and adopting it
    // is what made the collapse one-way: the view became 0 wide, the page could
    // never report anything else out of it, and only a restart recovered the banner
    // (Abi, 2026-09-20: "I need to restart the app before things will recover"). So
    // the previous size stands until a measurement taken in a real viewport arrives.
    if (width === 0 && height > 0) return;
    if (width === bannerSize.width && height === bannerSize.height) return;
    bannerSize = { width, height };
    layoutViews();
  });
  // The sweep's own size, reported by core/ui/sweep.js. Bounded like the bar's, so
  // a page that reported nonsense could not size a view over the whole window.
  ipcMain.handle('app:sweep-bounds', (_e, bounds) => {
    const width = Math.max(0, Math.min(400, Math.ceil(Number(bounds && bounds.width) || 0)));
    const height = Math.max(0, Math.min(200, Math.ceil(Number(bounds && bounds.height) || 0)));
    if (width === sweepSize.width && height === sweepSize.height) return;
    sweepSize = { width, height };
    layoutViews();
  });
  // ★ The store decides what the X MEANS, and this is the only place a surface's
  // dismissal arrives, so it is the only place that decision has to be right. Most
  // cards are read: "I have seen this", not "this is fixed", and the two used to be
  // the same button, which is how waving away a refused shortcut deleted the app's
  // own knowledge that it was refused. A card that says `dismissClears` means the
  // other thing -- the reader is ending the condition rather than acknowledging it
  // -- and the download card is the one that does.
  ipcMain.handle('app:dismiss-notice', (_e, id) => {
    const key = String(id);
    const notice = notices.get(key);
    // ★ Giving up the transfer happens BEFORE the store is touched, so that the
    // library's own reaction to a cancel (an 'update-cancelled' event, and a
    // rejected download promise) arrives at an attempt the app has already stopped
    // reporting on. The other order races: the cancel can emit inside this tick,
    // and a raise from it would land on a store that still thinks the card is live.
    if (notice && notice.dismissClears) abandonUpdateDownload();
    if (notices.dismiss(key)) refreshBanner();
  });
  // Closing the bar is the same act aimed at everything on it, and it READS each
  // notice rather than clearing it: nothing on the bar is left behind, and no
  // condition's fate is decided. A card whose X means clearing keeps that X as its
  // only way out, so a sweep silences the download card for the run and leaves its
  // transfer running. The store owns both halves (see markAllRead in
  // core/notices.js).
  ipcMain.handle('app:mark-notices-read', () => {
    if (notices.markAllRead()) refreshBanner();
  });
  // Everything still true, read or not. The banner asks for unread; Settings
  // asks for this, because "how many things are broken" is not the same question
  // as "how many things have you not been told about".
  ipcMain.handle('app:live-notices', () => notices.list());
  // The same failures the banner showed, after the banner let them go. Paired
  // into rows here rather than in the page, because pairing a raise with its
  // clear has a rule in it and the page should not be the place that rule lives.
  ipcMain.handle('app:notice-history', () => noticeLog().sessions());
  // Opening the folder is offered because the files outlive the page's view of
  // them: Settings shows what is still on disk, and three months of JSON Lines
  // is a thing to grep, not to scroll.
  ipcMain.handle('app:open-notice-log', () => shell.openPath(noticeLog().dir));
  // A notice's one offer. A lookup rather than a dispatch, so a page can only
  // ever reach a command that was written here, the renderer names it, it does
  // not describe it, and an unknown name is nothing rather than an error.
  ipcMain.handle('app:notice-action', (_e, command) => {
    const commands = {
      settings: () => openSettings(),
      // Straight to the tab holding the two fingerprints and the two answers.
      certificates: () => openSettings({ tab: 'certificates' }),
      reconnect: () => loadActiveGateway(),
      'update-download': () => { void downloadOfferedUpdate(); },
      'update-release-page': () => {
        // The offered release's own notes, not the list: this notice is about one
        // version, so the link that answers it is that version's page. The URL
        // shape is shared with the phone, which puts the same link behind its own
        // Release notes button.
        void shell.openExternal(releaseNotesUrl(repo, offeredUpdate && offeredUpdate.version));
      },
      'update-restart': () => restartForUpdate(),
      'update-rollback': () => rollBackToLastKnownGood(),
    };
    const run = commands[String(command)];
    if (run) run();
  });
  // The loading cover's Try again, which is the same act as the menu's
  // Reconnect and goes to the same place.
  ipcMain.handle('app:reconnect', () => { loadActiveGateway(); });
  // What the cover asks for on load. There is a push too, but the first value
  // has to be pulled: the page can finish loading between two ticks, and a bar
  // that starts at zero and jumps on the next tick is worse than one that opens
  // where the load actually is.
  ipcMain.handle('app:progress', () => progressNow());

  // Synchronous, and only because the caller is a sandboxed preload that cannot
  // require src/chrome.js. Serving the list from its one owner beats keeping a
  // second copy in the preload that silently drifts the first time it changes.
  ipcMain.on('chrome:token-spec', (event) => { event.returnValue = chrome.THEME_TOKENS; });

  // Sent by the preload of every window, including remote gateway pages. Only
  // the main window drives the app's colours: a popup showing a different page
  // must not repaint the window the user is actually looking at.
  ipcMain.on('chrome:theme', (event, report) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== page()) return;
    // A report we cannot resolve is STATED. Refusing it is right, a
    // partly-applied theme being worse than none, but the refusal used to be
    // silent and the app simply carried on with whatever palette it already had,
    // which is indistinguishable from the report never arriving: reported
    // 2026-09-17 as the settings surface "using the default dark", from a build
    // whose report was fine and whose token LIST was short. See themeRefusal().
    if (chrome.themeRefusal(report)) {
      console.warn(`[claw-desktop] theme: refusing this report because ${chrome.themeRefusal(report)}; our surfaces keep the ${currentTheme.mode} palette in force`);
      return;
    }
    // The app's theme comes from the Control UI, never from one of our own
    // pages. Without this the first run, where the settings page *is* the main
    // window's content, would have the app take its colours from the very
    // stylesheet it is supposed to be theming, and the settings page would end
    // up quoting itself back.
    if (!/^https?:/.test(event.sender.getURL())) return;
    adoptTheme(chrome.themeFromReport(report));
  });
}

/* ------------------------------------------------------------------ startup */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    // First thing, before any later step can crash the boot: judge the build we
    // are running on the marker previous launches left, then write a fresh
    // attempt for this launch. bootHealth() carries the verdict for the banner
    // and the automatic rollback.
    beginBootAttempt();

    // The issue reporter, wired before anything can crash: it installs the
    // process error handlers and the crash reporter, and it decides the channel
    // from the running version (null from channelOf means stable).
    issueReporter.init({
      config,
      channel: () => updates.channelOf(app.getVersion()) || 'stable',
    });

    if (process.platform === 'win32') app.setAppUserModelId('com.azuretek.claw-desktop');

    // The default session only ever serves our own file:// pages; the gateway
    // itself loads in a per-gateway partition configured by createMainWindow.
    chrome.applyTheme(currentTheme);
    configureSession(session.defaultSession, null);
    // No prompt: a refused certificate becomes an offer waiting in Settings,
    // and the failed load becomes the app's own error page pointing at it.
    certs.install(app, {
      onOffer: (offer) => {
        console.warn(`[claw-desktop] refused ${offer.changed ? 'CHANGED' : 'untrusted'} certificate for ${offer.host} (${offer.fingerprint})`);
        refreshCertNotice();
        notifyStateChanged();
      },
    });

    if (!secrets.available()) {
      console.warn(`[claw-desktop] ${secrets.unavailableReason()}`);
      // True for the whole run and the reason saving a token appears to do
      // nothing, so it belongs on screen rather than in a log nobody reads.
      setNotice('secrets', {
        tone: noticeStore.WARN,
        message: 'Gateway credentials cannot be saved on this machine.',
        detail: noticeStore.sentence(secrets.unavailableReason()),
        // Where the token and password fields live, so the reader can see what
        // still works instead of only being told what does not.
        action: { label: 'Open Settings', command: 'settings' },
      });
    }
    registerIpc();
    buildMenu();
    buildTray();
    reportLaunchAtLogin();

    const shortcut = registerShortcut();
    if (!shortcut.ok) console.warn(`[claw-desktop] global shortcut not registered: ${shortcut.error}`);

    initUpdates();

    if (process.argv.includes('--hidden')) config.update({ startHidden: true });

    // Before the first load, not after: clearing a service worker out from
    // under a page it is already controlling leaves that page on the old
    // bundle until something reloads it.
    await clearOnAppUpgrade().catch((err) => console.warn(`[claw-desktop] cache clear failed: ${err.message}`));

    reachBootStage('window-create');
    createMainWindow();

    // The window exists, so there is a surface for it: if the build we are
    // running kept failing to come up, say so and, where a rollback is possible,
    // start it automatically. The banner stays up either way, so the reader sees
    // what happened and can retry from it if the automatic attempt did not take.
    raiseBrokenBuildBanner();
    maybeAutoRollBack();

    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => { quitting = true; persistBounds(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (updateTimer) clearInterval(updateTimer);
  });

  app.on('window-all-closed', () => {
    // With close-to-tray on, the window hides rather than closing, so reaching
    // here means the user genuinely closed everything.
    if (process.platform !== 'darwin' && !config.get().closeToTray) app.quit();
  });
}
