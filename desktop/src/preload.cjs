'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// This preload is attached to the same window that later loads the remote
// Control UI, so gate the bridge on the page being one of *our* local pages.
// Remote gateway content gets no API surface at all, it is a website, and it
// should not be able to rewrite gateway settings or read pinned fingerprints.
const isLocalPage = location.protocol === 'file:';

// The App-settings affordance runs in the REMOTE gateway page's main world (see
// core/app-settings-affordance.js), which gets no other bridge: it is a website.
// The one thing it may do is ask this app to open its own settings surface, and
// that is the whole of what is exposed here. `open` is a single named call to an
// IPC that runs openSettings() in main; there is no state to read and nothing to
// write, so a hostile gateway calling it can do no more than a user pressing the
// footer control could. The injected script reads `window.__clawAppSettings` and
// merges its own config onto it, so exposing `open` here before the script runs
// is what wires the desktop's half of the bridge.
contextBridge.exposeInMainWorld('__clawAppSettings', {
  open: () => { ipcRenderer.invoke('app:open-settings'); },
});

/* The device-pairing observer's report, and the second of exactly two things the
   remote gateway page may say to this app.

   The observer (core/spec/pairing.json) watches the page's own WebSocket and
   reports a pairing refusal, which is the one connection state this app cannot
   learn from the navigation delegate: the page's HTML loaded, so the socket
   close is an event inside the page. It prefers a host message handler, which
   Electron has none of, so `desktop/src/pairing.js` defines the global it falls
   back to as a live channel pointing here.

   One direction, no reply, and the payload is narrowed to the shared contract in
   main (a kind the spec names, a reason it knows, an id that passes its pattern)
   before anything is shown. The worst a hostile page can do with it is make this
   app show its own pairing screen, which is a page it cannot read, write or
   navigate away from, and which offers nothing but a retry. The report is also
   ignored unless it comes from the gateway page itself; see the sender check on
   the handler in src/main.js. */
contextBridge.exposeInMainWorld('__clawPairingReport', (payload) => {
  try {
    ipcRenderer.send('pairing:report', typeof payload === 'string' ? payload : '');
  } catch { /* nothing to report it to; the page is on its own */ }
});

/* The observer itself, injected into the gateway page's MAIN world at document
   start, which is the one moment early enough to wrap `WebSocket` before the
   page opens its gateway socket.

   Why here and not from the main process. `webContents.executeJavaScript` runs
   once the document already exists, and CDP's
   `Page.addScriptToEvaluateOnNewDocument` cannot be relied on at all from there:
   measured on this app, a registration fired before the first navigation is
   queued until the renderer exists and lands after the document it was meant to
   precede, and one that does resolve is scoped to the renderer it was sent to,
   so it missed even a plain reload. Both left the page holding a native
   `WebSocket` with nothing to report a refusal.

   `webFrame.executeJavaScript` from the preload has neither problem: the preload
   is already running before the page has a document, and this evaluates in the
   page's main world (measured: the injected marker lands before the document's
   first script, with the bridge below already visible to it). It is not subject
   to the page's CSP, because it evaluates rather than inserting a script element.
   The other direction is still closed: the isolated world cannot see this call,
   and the page gains no function it can invoke.

   The bytes come from main over a SYNCHRONOUS channel, because the ordering is
   the whole point: an async read would resolve a tick later, after the page's
   own first script. Two short strings, once per document.

   Fail-soft and LOUD: a document that could not be injected says so to main,
   which logs it in the app's own stdout, because a silent non-installation is
   exactly how this shipped broken once. */
if (!isLocalPage) {
  let report = { ok: false, error: 'no script from main' };
  try {
    const sources = ipcRenderer.sendSync('pairing:script') || [];
    for (const source of sources) webFrame.executeJavaScript(source);
    report = { ok: true, error: '' };
  } catch (err) {
    report = { ok: false, error: (err && err.message) || String(err) };
  }
  try { ipcRenderer.send('pairing:injected', report); } catch { /* nothing left to report it to */ }
}

if (isLocalPage) {
  contextBridge.exposeInMainWorld('clawDesktop', {
    getState: () => ipcRenderer.invoke('app:state'),
    testGateway: (url) => ipcRenderer.invoke('app:test-gateway', url),
    addGateway: (entry) => ipcRenderer.invoke('app:add-gateway', entry),
    updateGateway: (id, patch) => ipcRenderer.invoke('app:update-gateway', id, patch),
    removeGateway: (id) => ipcRenderer.invoke('app:remove-gateway', id),
    // Write-only by design: there is no getCredentials. The settings page can
    // set or clear a credential and learn whether one exists, never read it.
    setCredentials: (id, patch) => ipcRenderer.invoke('app:set-credentials', id, patch),
    addHeader: (id, name, value) => ipcRenderer.invoke('app:add-header', id, name, value),
    removeHeader: (id, name) => ipcRenderer.invoke('app:remove-header', id, name),
    // A refused certificate is decided here rather than in a prompt. See the
    // note at the top of src/certs.js for why there is no prompt.
    trustCert: (host) => ipcRenderer.invoke('app:trust-cert', host),
    dismissCertOffer: (host) => ipcRenderer.invoke('app:dismiss-cert-offer', host),
    forgetCert: (host) => ipcRenderer.invoke('app:forget-cert', host),
    connect: (id) => ipcRenderer.invoke('app:connect', id),
    saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
    closeSettings: () => ipcRenderer.invoke('app:close-settings'),

    /* The app's own pages, in place of native ones. See the overlay section in
       src/main.js for why nothing here is a dialog.showMessageBox. */
    closeOverlay: (name) => ipcRenderer.invoke('app:close-overlay', name),
    about: () => ipcRenderer.invoke('app:about'),
    checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
    openReleases: () => ipcRenderer.invoke('app:open-releases'),
    // The listener is wrapped rather than handed the raw event: a renderer
    // given `event` gets `event.sender`, and with it a way back into IPC that
    // the bridge is supposed to be the only door to.
    onAboutChanged: (fn) => ipcRenderer.on('app:about-changed', () => fn()),
    onStateChanged: (fn) => ipcRenderer.on('app:state-changed', () => fn()),

    /* The banner: conditions that stay until they are fixed. `bannerHeight` is
       the page telling main how tall to make its view, see ui/banner.js. */
    // Unread only: the banner draws what has not been acknowledged. Everything
    // still true, read or not, is liveNotices.
    notices: () => ipcRenderer.invoke('app:notices'),
    liveNotices: () => ipcRenderer.invoke('app:live-notices'),
    bannerHeight: (height) => ipcRenderer.invoke('app:banner-height', height),
    // Marks read rather than clearing. The condition carries on; the app just
    // stops saying so.
    dismissNotice: (id) => ipcRenderer.invoke('app:dismiss-notice', id),
    markNoticesRead: () => ipcRenderer.invoke('app:mark-notices-read'),
    // A notice's one offer, by name. Main runs only the commands it recognises,
    // so the page can ask for what it was offered and nothing else.
    noticeAction: (command) => ipcRenderer.invoke('app:notice-action', command),
    onNoticesChanged: (fn) => ipcRenderer.on('app:notices-changed', () => fn()),
    // The same failures after the banner has let them go. Read-only on purpose:
    // a page can ask what happened and has no way to write a line or delete one,
    // so the record cannot be edited by the thing displaying it.
    noticeHistory: () => ipcRenderer.invoke('app:notice-history'),
    openNoticeLog: () => ipcRenderer.invoke('app:open-notice-log'),
    // The loading cover, shown while connecting and after a failure. The bar and
    // its line are computed in main and pushed, see the progress section in
    // src/main.js for why the page is not given the curve to run itself.
    reconnect: () => ipcRenderer.invoke('app:reconnect'),
    progress: () => ipcRenderer.invoke('app:progress'),
    onProgress: (fn) => ipcRenderer.on('app:progress', (_event, value) => fn(value)),

    /* The pairing screen. The page renders what main already parsed and
       narrowed through core/pairing.js, so the screen holds no rule of its own
       about what counts as pairing, and a second client that renders the same
       page gets the same answer from its own host. */
    pairing: () => ipcRenderer.invoke('app:pairing'),
    onPairingChanged: (fn) => ipcRenderer.on('app:pairing-changed', () => fn()),

  });

  /* The settings page's own door, and the desktop's half of a contract the
       iOS client implements too.

       core/ui/settings.js is loaded by both clients, so it cannot call
       `clawDesktop.invoke('app:state')`, which only exists here. It calls
       `invoke(command, args)` and `on(event, handler)` instead, and this is the
       desktop's implementation of that: one table from the shared vocabulary to
       the channels above, all of which already existed. Names, not callbacks,
       because the same page runs against a WKScriptMessageHandler on the phone
       and a name is the only thing both can carry.

       Unknown command is an error rather than nothing. The notice-action lookup
       in src/main.js resolves an unknown name to nothing on purpose, because a
       renderer must not be able to invent commands; this is the other case, a
       page asking for a command its own client was supposed to implement, and a
       silent `undefined` there is a button that does nothing.

       Its own global rather than one more property of the bridge above, which is
       where it was first written and where it did nothing: the shared page reads
       `window.clawSettings` and nothing else, so a nested object is simply
       absent, and a page whose host is absent throws while loading and renders
       nothing at all. That is the whole page, tabs included, with no error on
       screen to say why. Measured 2026-09-15. */
  contextBridge.exposeInMainWorld('clawSettings', {
      invoke: (command, args = []) => {
        const table = {
          state: () => ipcRenderer.invoke('app:state'),
          testGateway: ([url]) => ipcRenderer.invoke('app:test-gateway', url),
          addGateway: ([entry]) => ipcRenderer.invoke('app:add-gateway', entry),
          updateGateway: ([id, patch]) => ipcRenderer.invoke('app:update-gateway', id, patch),
          removeGateway: ([id]) => ipcRenderer.invoke('app:remove-gateway', id),
          setCredentials: ([id, patch]) => ipcRenderer.invoke('app:set-credentials', id, patch),
          addHeader: ([id, name, value]) => ipcRenderer.invoke('app:add-header', id, name, value),
          removeHeader: ([id, name]) => ipcRenderer.invoke('app:remove-header', id, name),
          trustCert: ([host]) => ipcRenderer.invoke('app:trust-cert', host),
          dismissCertOffer: ([host]) => ipcRenderer.invoke('app:dismiss-cert-offer', host),
          forgetCert: ([host]) => ipcRenderer.invoke('app:forget-cert', host),
          connect: ([id]) => ipcRenderer.invoke('app:connect', id),
          saveSettings: ([patch]) => ipcRenderer.invoke('app:save-settings', patch),
          closeSettings: () => ipcRenderer.invoke('app:close-settings'),
          // Opens the app's own About page over whatever is on screen, the same
          // overlay the menu bar and tray open. It is About's one way in on a
          // build with no reachable menu bar (the Windows desktop hides its
          // behind Alt), and the desktop's half of a command iOS answers too.
          openAbout: () => ipcRenderer.invoke('app:settings-open-about'),
          liveNotices: () => ipcRenderer.invoke('app:live-notices'),
          noticeHistory: () => ipcRenderer.invoke('app:notice-history'),
          openNoticeLog: () => ipcRenderer.invoke('app:open-notice-log'),
        };
        const run = table[String(command)];
        if (!run) return Promise.reject(new Error(`clawSettings: no such command on this client: ${command}`));
        return run(args);
      },
      on: (event, fn) => {
        const table = {
          state: () => ipcRenderer.on('app:state-changed', () => fn()),
          notices: () => ipcRenderer.on('app:notices-changed', () => fn()),
        };
        const run = table[String(event)];
        if (!run) throw new Error(`clawSettings: no such event on this client: ${event}`);
        return run();
      },
  });
}

/* --------------------------------------------------------- theme reporting */

// Runs for remote pages too, and deliberately so: this reads colours OUT of the
// page and sends them to the main process. It adds nothing to `window`, so the
// gate above still holds, the page cannot call this, only be measured by it.
//
// Worth stating the trust boundary plainly: a hostile gateway could report any
// colour it liked and repaint our caption strip. That is the whole blast radius
// main parses every value into `#rrggbb` before it reaches an Electron API
// (see chrome.js `normalizeColor`), so the worst case is an ugly title bar.

// Ask the page to resolve `var(--bg)` for us rather than reading the custom
// property directly. `getComputedStyle().getPropertyValue('--bg')` hands back
// the raw token exactly as authored, so a theme written in `oklch()` would
// arrive as a string nothing in the main process can parse. Assigning it to a
// real property and reading the *computed* value makes the engine do the
// conversion, and it always answers in a resolved form.

// Which CSS property each token type is resolved through, and the fallback that
// proves absence. A token the theme does not define makes `var()` fall back, 
// and without a sentinel the property would quietly land on its inherited or
// initial value, which for a colour is a perfectly plausible-looking answer
// that is not the token. Anything coming back equal to the sentinel is dropped.
const RESOLVE = {
  color: { prop: 'color', read: 'color', absent: 'rgb(1, 2, 3)' },
  length: { prop: 'width', read: 'width', absent: '31337px' },
  font: { prop: 'fontFamily', read: 'fontFamily', absent: '__claw_absent__' },
  shadow: { prop: 'boxShadow', read: 'boxShadow', absent: '0px 0px 0px rgb(1, 2, 3)' },
};

// The token list lives in src/chrome.js, which a sandboxed preload cannot
// require. Asking for it once per page keeps a single owner rather than a copy
// here that drifts the first time the list changes.
let tokenSpec = null;
function tokenSpecOnce() {
  if (tokenSpec) return tokenSpec;
  try {
    tokenSpec = ipcRenderer.sendSync('chrome:token-spec') || [];
  } catch {
    tokenSpec = [];
  }
  return tokenSpec;
}

function readTheme() {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;height:0;pointer-events:none;'
    + 'background-color:var(--bg);color:var(--text)';
  root.appendChild(probe);
  const computed = getComputedStyle(probe);

  const report = {
    mode: root.getAttribute('data-theme-mode'),
    surface: computed.backgroundColor,
    symbol: computed.color,
    tokens: {},
  };

  for (const [name, kind] of tokenSpecOnce()) {
    const spec = RESOLVE[kind];
    if (!spec) continue;
    probe.style[spec.prop] = `var(${name}, ${spec.absent})`;
    const value = computed[spec.read];
    probe.style[spec.prop] = '';
    if (value && value !== spec.absent) report.tokens[name] = value;
  }

  probe.remove();
  return report;
}

let lastReport = '';
function reportTheme() {
  try {
    const report = readTheme();
    // The observer fires on our own marker class as well as on real theme
    // changes; skip the repeats so the main process is not repainting a window
    // it already painted.
    const key = JSON.stringify(report);
    if (key === lastReport) return;
    lastReport = key;
    ipcRenderer.send('chrome:theme', report);
  } catch { /* a page we cannot measure keeps whatever colours are current */ }
}

window.addEventListener('DOMContentLoaded', () => {
  reportTheme();
  // The theme picker rewrites `data-theme` in place with no navigation, so
  // there is no load event to hang this off, the attribute IS the event.
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-mode', 'style', 'class'],
  });
});
