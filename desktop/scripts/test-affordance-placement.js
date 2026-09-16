// Prove where the App-settings affordance actually lands in the Control UI, and
// where "Go to the Control UI settings" actually takes the reader.
//
// Both are claims about another program's DOM, so both are checked against the
// real page rather than read out of the spec: the anchor list can be correct and
// the DOM can have moved, and the failure looks identical in a source read.
//
//   npx electron scripts/test-affordance-placement.js [--gateway URL] [--shots DIR]
//
// Needs a reachable Control UI. By default it points at a throwaway gateway on
// this host, which is what the deliverable was verified against:
//
//   OPENCLAW_STATE_DIR=/tmp/claw-affordance-gw/state \
//   OPENCLAW_CONFIG_PATH=/tmp/claw-affordance-gw/openclaw.json \
//   openclaw gateway --port 19099 --auth none --bind loopback --allow-unconfigured
//
// A throwaway gateway on a spare port with its own state directory, never the
// live one: this needs a Control UI whose footer it can inspect, and the real
// gateway's is behind a credential.
//
// The profile is pinned BOTH ways; main.js decides isolation from the
// `--user-data-dir` SWITCH rather than from the path. See scripts/dump-overlays.js.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const argIndex = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const GATEWAY = argIndex('--gateway', 'http://127.0.0.1:19099/');
const SHOTS = argIndex('--shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const { app, BrowserWindow, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-affordance-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

/** Refuse to run against nothing: a harness that proves nothing is worse than one that fails. */
async function gatewayReachable() {
  return new Promise((resolve) => {
    const req = http.get(GATEWAY, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Control UI', url: GATEWAY }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

if (!await gatewayReachable()) {
  console.error(`FAIL no Control UI at ${GATEWAY}: start the throwaway gateway first (see the header)`);
  process.exit(1);
}

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 120000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

/** The gateway page: the only view whose URL is the gateway. */
function page() {
  return webContents.getAllWebContents().find(
    (wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')),
  ) || null;
}

/** One image of the composited window, which is the only way to see child views. */
async function capture(name) {
  if (!SHOTS) return null;
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return null;
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, mine.thumbnail.toPNG());
  return file;
}

/**
 * Where the injected control is, as the page itself reports it.
 *
 * `closest` answers the question the anchors are about: is this node inside the
 * footer's action row, inside the footer bar, or parked in a corner by the last
 * step of the chain. Read from the DOM rather than inferred from the class list,
 * because the class existing in a stylesheet says nothing about where the node
 * ended up.
 */
const placementQuery = `(() => {
  const node = document.querySelector('[data-claw-app-settings]');
  if (!node) return { placed: false };
  const spec = (window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors) || {};
  const actions = node.closest('.sidebar-footer-actions');
  const bar = node.closest('.sidebar-footer-bar');
  // The sidebar anchor comes from the SPEC the page was installed with, not
  // from a copy here: a hardcoded selector here is a second owner of the same
  // decision, and the one it used to hold was the class-substring match that
  // wrongly caught .settings-sidebar.
  const sidebar = spec.sidebar ? node.closest(spec.sidebar) : null;
  const style = getComputedStyle(node);
  return {
    placed: true,
    inFooterActions: Boolean(actions),
    inFooterBar: Boolean(bar),
    inSidebar: Boolean(sidebar),
    position: style.position,
    left: style.left,
    bottom: style.bottom,
    parent: node.parentElement ? node.parentElement.className : null,
    label: node.getAttribute('aria-label'),
  };
})()`;

app.whenReady().then(async () => {
  // Long enough for the window and the gateway load. The Control UI opens on
  // whatever route its boot picks, which for an unconfigured gateway is the
  // first-run settings flow: a layout with NO main sidebar at all.
  await delay(9000);

  const wc = page();
  check('the Control UI loaded', Boolean(wc), `no view at ${GATEWAY}`);
  if (!wc) { app.exit(1); return; }

  const anchorsHere = await wc.executeJavaScript(`(() => {
    const spec = window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors;
    const out = {};
    for (const key of Object.keys(spec || {})) {
      const node = document.querySelector(spec[key]);
      out[key] = node ? ('MATCH ' + node.tagName.toLowerCase() + '.' + String(node.className).slice(0, 60)) : 'no match';
    }
    out.route = location.pathname + location.search;
    out.footerActionsPresent = Boolean(document.querySelector('.sidebar-footer-actions'));
    return out;
  })()`);
  console.log(`note anchors at ${anchorsHere.route}:`);
  for (const [key, value] of Object.entries(anchorsHere)) if (key !== 'route') console.log(`note   ${key}: ${value}`);

  // The first-run layout has no footer to hold it, so the honest outcome here is
  // the failure the corner step used to make look like success: the placement
  // found nothing, and the client's own route to app settings is what remains.
  // What must NOT happen is the old behaviour, a control parked inside the
  // settings page's own sidebar, which is the wrong place and, worse, permanent.
  const firstRun = await wc.executeJavaScript(placementQuery);
  console.log(`note placement on the first-run layout: ${JSON.stringify(firstRun)}`);
  check('the first-run layout does not park the control in the settings sidebar',
    !firstRun.placed || !/settings-sidebar/.test(String(firstRun.parent || '')), JSON.stringify(firstRun));

  /* ------------------------------------- the layout the app actually shows */

  // The chat layout, which is where a configured client sits and where the
  // Control UI renders the footer this control belongs in. This gateway cannot
  // reach it: the Control UI refuses to leave its first-run model-setup flow
  // without a provider it can actually talk to, and the flow has no main sidebar
  // at all. So the footer MARKUP the running bundle renders is inserted, verbatim
  // from its own template
  // (dist/control-ui/assets/control-ui-boot-shared-*.js), and the assertion is
  // about what the real script does with it: the anchors, the placement and the
  // upgrade are the product's own, and only the host node is the harness's. A
  // control that lands in this row lands in the real one, because the real one is
  // this markup.
  const inserted = await wc.executeJavaScript(`(() => {
    const shell = document.querySelector('.settings-sidebar') || document.body;
    const bar = document.createElement('div');
    bar.className = 'sidebar-footer-bar';
    const actions = document.createElement('span');
    actions.className = 'sidebar-footer-actions';
    const home = document.createElement('button');
    home.type = 'button';
    home.className = 'sidebar-brand__icon sidebar-footer-bar__home';
    home.setAttribute('aria-label', 'Home panel');
    actions.appendChild(home);
    bar.appendChild(actions);
    shell.appendChild(bar);
    return { shell: shell.className, actions: Boolean(document.querySelector('.sidebar-footer-actions')) };
  })()`);
  console.log(`note footer markup inserted into .${inserted.shell} (the bundle's own template); actions present: ${inserted.actions}`);
  await delay(2500);

  const anchorsThere = await wc.executeJavaScript(`(() => {
    const spec = window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors;
    const out = {};
    for (const key of Object.keys(spec || {})) {
      const node = document.querySelector(spec[key]);
      out[key] = node ? ('MATCH ' + node.tagName.toLowerCase() + '.' + String(node.className).slice(0, 60)) : 'no match';
    }
    out.route = location.pathname + location.search;
    return out;
  })()`);
  console.log(`note anchors at ${anchorsThere.route}:`);
  for (const [key, value] of Object.entries(anchorsThere)) if (key !== 'route') console.log(`note   ${key}: ${value}`);

  const where = await wc.executeJavaScript(placementQuery);
  check('the affordance is placed at all', where.placed === true, JSON.stringify(where));
  if (where.placed) {
    check('and it is in the sidebar FOOTER actions row, not a corner',
      where.inFooterActions === true, JSON.stringify(where));
    check('and it is inside the footer bar', where.inFooterBar === true, JSON.stringify(where));
    // The corner step is the one that sets these; a footer placement leaves the
    // stylesheet's own values in place. This is the upgrade step's other half.
    check('and the corner fallback did not fire, or was cleared by the move',
      where.position !== 'absolute', JSON.stringify(where));
    check('and it carries the label the spec names', where.label === 'App settings', String(where.label));
  }
  const shot = await capture('affordance-placement');
  if (shot) console.log(`note shot: ${shot}`);

  /* ------------------------------------- what "Go to Control UI settings" does */

  // The same call both clients make, evaluated in the page it is meant for.
  const before = await wc.executeJavaScript('location.href');
  const pressed = await wc.executeJavaScript(
    "(() => { const c = window.__clawAppSettingsConfig; return c && typeof c.openControlUiSettings === 'function' ? c.openControlUiSettings() : 'no-config'; })()",
  );
  await delay(3000);
  const after = await wc.executeJavaScript('location.href');

  console.log(`note the shared call reported: ${JSON.stringify(pressed)}`);
  console.log(`note url before: ${before}`);
  console.log(`note url after:  ${after}`);

  // The deliverable: the reader lands on the tab the Control UI's OWN settings
  // entry opens, which is `appearance`.
  check('the reader lands on the Control UI settings route', after.includes('/settings/'), after);
  check('and on the APPEARANCE tab, the one its own entry opens',
    await wc.executeJavaScript("location.pathname === '/settings/appearance'"), after);

  const route = await wc.executeJavaScript(
    "(() => { const active = document.querySelector('.settings-sidebar__item--active, [aria-current=\"page\"]'); return { active: active ? (active.textContent || '').trim() : null, path: location.pathname + location.hash }; })()",
  );
  console.log(`note route after: ${JSON.stringify(route)}`);
  check('and the page says so itself', /appearance/i.test(route.path) || /appearance/i.test(String(route.active)), JSON.stringify(route));
  await capture('affordance-control-ui-settings');

  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
