// The settings surface's colours, measured in the real app against a palette the
// Control UI publishes.
//
//   npx electron scripts/test-settings-theme.js --appearance light|dark [--shots DIR]
//   npx electron scripts/test-settings-theme.js --case none
//   npx electron scripts/test-settings-theme.js --case switch
//
// WHY THIS EXISTS, and it is the second time this page's colours have gone wrong.
// The settings page draws from ONE palette: the Control UI's, resolved live. It
// declares ui.css's own copy of the Control UI's DEFAULT palette only so that a
// page with no gateway behind it is still styled, and every one of those names is
// supposed to be overridden by the live theme. The override is not by name
// matching: the report is filtered through an ALLOWLIST (core/spec/tokens.json's
// \`live\` list, sanitizeTokens in src/chrome.js), so a palette name the list does
// not carry CANNOT reach our pages however the Control UI defines it. The page
// then wears two palettes at once and nothing anywhere says so, because both
// values are perfectly good colours.
//
// That is what was reported on 2026-09-17 in the shape the reader sees: "the
// settings page somehow lost its theme, it's using the default dark". The build
// being run was from before \`--card\` and \`--bg-elevated\` were added to the list,
// and those two are the surfaces the settings GROUPS are drawn on, so every group
// was ui.css's default-dark card inside a window wearing the reader's palette.
//
// So this harness measures the PAGE, not the files: it serves a palette the app
// resolves, opens the real settings surface, and requires every colour ui.css
// declares to come back as the value the Control UI published. Drop a name from
// the live list and this fails with the value the page actually wore; a diff of
// the two files cannot fail, which is why the file-level guard
// (core/test/live-tokens.test.js) was not enough on its own.
//
// The third claim is the other half of the same fault. When NOTHING resolves, the
// app falls back to ui.css's own palette, and that has to be a stated, deliberate
// fallback rather than an accident: \`--case none\` serves a page with no palette at
// all and requires the app to say so.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPEARANCE = flag('appearance', 'light');
if (!['light', 'dark'].includes(APPEARANCE)) throw new Error(`unknown appearance ${APPEARANCE}`);
const CASE = flag('case', 'palette');
if (!['palette', 'none', 'switch'].includes(CASE)) throw new Error(`unknown case ${CASE}`);
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const REPO = path.join(import.meta.dirname, '..', '..');
const UI_DIR = path.join(REPO, 'core', 'ui');
const SPEC = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'tokens.json'), 'utf8'));
const UI_CSS = fs.readFileSync(path.join(UI_DIR, 'ui.css'), 'utf8');

/** The names a client may take from a running Control UI, by kind. One owner. */
const LIVE = new Map(SPEC.live.tokens.map(([name, kind]) => [name, kind]));
/** The names ui.css deliberately owns instead, with the reason. One owner. */
const OURS = new Map((SPEC.live.ours || []).map((entry) => [entry.name, entry.reason]));

/** Every \`--name: value;\` declared inside one rule of the stylesheet. */
function declaredIn(css, from) {
  const start = css.indexOf(from);
  if (start === -1) return [];
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out = [];
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.push([match[1], match[2].trim()]);
  return out;
}

/** Whether a declaration's value is a colour rather than a length or a font. */
const isColour = (value) => /#|rgba?\(|color-mix\(|\btransparent\b/i.test(value);

/** The two palette blocks: the dark fallback, and the light one in its media query. */
const DARK_BLOCK = declaredIn(UI_CSS, ':root {');
const LIGHT_AT = UI_CSS.indexOf('@media (prefers-color-scheme: light)');
const LIGHT_BLOCK = LIGHT_AT === -1 ? [] : declaredIn(UI_CSS.slice(LIGHT_AT), ':root {');

/**
 * What the Control UI publishes for each name, generated rather than typed.
 *
 * Generated so that the palette cannot accidentally BE ui.css's own: every value
 * is derived from the name's index, which means a surface that quietly kept the
 * stylesheet's fallback comes back as a different colour rather than as a match,
 * and the failure names the name. Distinct per appearance for the same reason,
 * and because a run has to be able to tell one from the other.
 */
function publishedValue(name, kind, index) {
  if (kind === 'color' || (!kind && isColour((DARK_BLOCK.find(([n]) => n === name) || [])[1] || '#'))) {
    // Opaque, six digits, warm in light and cool in dark, and different for every
    // name: rgb() is what a computed colour comes back as on both sides.
    const base = APPEARANCE === 'light' ? [238, 232, 224] : [26, 24, 36];
    const r = (base[0] + index * 3) % 256;
    const g = (base[1] + index * 5) % 256;
    const b = (base[2] + index * 7) % 256;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  if (kind === 'length') return `${8 + index}px`;
  if (kind === 'font') return `Stub Font ${index}, sans-serif`;
  return `0 ${index}px ${index}px rgba(1, 2, 3, 0.5)`;
}

/**
 * The names this run compares, each with the value the surface must resolve to.
 *
 * Both directions matter. A name ui.css declares as a palette fallback is a name
 * the page can be WRONG about, so each one is compared: one the live list carries
 * must come back as the published value, and one that is neither live nor stated
 * as ours must TOO, because that is precisely the broken state this harness is
 * for: ui.css declares a palette colour nobody has decided the owner of.
 */
const COMPARED = [];
{
  // The light block wins where a name is in both: this run measures ONE
  // appearance, and the stylesheet's own value for that appearance is what a name
  // we own has to resolve to.
  const declared = new Map([...DARK_BLOCK, ...LIGHT_BLOCK]);
  for (const [name, value] of declared) {
    // A value built from another token (\`var()\`, \`color-mix()\`) is derived rather
    // than literal, which only matters for a name we own: it resolves per
    // appearance and cannot be compared as text.
    const kind = LIVE.get(name) || (/(var|color-mix)\(/.test(value) ? 'derived' : (isColour(value) ? 'color' : 'length'));
    const isColourish = kind === 'color' || kind === 'derived' || /shadow/i.test(name);
    if (kind !== 'color' && !isColourish && !LIVE.has(name)) continue;
    if (!isColour(value) && kind !== 'shadow') continue;
    COMPARED.push({
      name,
      kind,
      ours: OURS.has(name),
      published: publishedValue(name, kind === 'derived' ? 'color' : kind, COMPARED.length),
      declared: value,
    });
  }
  // And every live name ui.css happens not to declare, so a name added to one
  // list and not the other is visible rather than silent.
  for (const [name, kind] of LIVE) {
    if (declared.has(name)) continue;
    COMPARED.push({
      name, kind, ours: false, published: publishedValue(name, kind, COMPARED.length), declared: null,
    });
  }
}

const published = Object.fromEntries(COMPARED.map((c) => [c.name, c.published]));

/** Hex to the rgb() string a computed colour comes back as. */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const PORT = 19210;
const PORT_B = 19211;
const ADDRESS = `http://127.0.0.1:${PORT}/`;
const ADDRESS_B = `http://127.0.0.1:${PORT_B}/`;

/**
 * A gateway that answers like a Control UI, carrying a palette.
 *
 * The payload marker is what identifies it (core/spec/gateway-identity.json), so
 * the app will actually connect and load it. The palette is declared in the two
 * places the Control UI declares its own: a :root block, and the attribute the app
 * reads the appearance from.
 */
const PAGE = CASE === 'none'
  ? `<!doctype html><html data-openclaw-control-ui-build-id="stub-1">
<head><meta charset="utf-8"><title>Stub Control UI</title></head>
<body><h1>Stub Control UI</h1><script>window.__clawHash = location.hash;</script></body></html>`
  : `<!doctype html><html data-openclaw-control-ui-build-id="stub-1" data-theme-mode="${APPEARANCE}" data-theme="stub">
<head><meta charset="utf-8"><title>Stub Control UI</title>
<style>
  :root { color-scheme: ${APPEARANCE}; ${Object.entries(published).map(([k, v]) => `${k}: ${v};`).join(' ')} }
  body { background: var(--bg); color: var(--text); }
</style></head>
<body><h1>Stub Control UI</h1><script>window.__clawHash = location.hash;</script></body></html>`;

// The app's own log lines, captured rather than printed into the harness's own
// output: the stated fallback IS one of the claims, so it has to be readable here.
const lines = [];
for (const level of ['log', 'warn']) {
  const original = console[level];
  console[level] = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original(...args);
  };
}

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-settings-theme-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const serverB = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(PAGE);
});
if (CASE === 'switch') await new Promise((resolve) => serverB.listen(PORT_B, '127.0.0.1', resolve));

// The switch case starts on a gateway whose stored appearance is the OTHER one,
// which is the state a reader is in after using the app for a while: the store
// holds the last appearance and the app seeds itself from it before any page
// reports. What it switches to is the palette this run measured.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [
    { id: 'gw-stub', label: 'Stub gateway', url: ADDRESS },
    ...(CASE === 'switch' ? [{ id: 'gw-b', label: 'Second gateway', url: ADDRESS_B }] : []),
  ],
  activeGatewayId: 'gw-stub',
  themeByGateway: CASE === 'switch' ? { 'gw-b': APPEARANCE === 'light' ? 'dark' : 'light' } : {},
}, null, 2)}\n`);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS);

function view(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;
}

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

async function grab(name) {
  if (!SHOTS) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const [width, height] = win.getContentSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return;
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), mine.thumbnail.toPNG());
}

/** Every compared name as the SETTINGS surface resolves it, plus its own surfaces. */
const SURFACE = `(() => {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const group = document.querySelector('#gateways .settings-group') || document.querySelector('.modal');
  const tokens = {};
  for (const name of ${JSON.stringify(COMPARED.map((c) => c.name))}) {
    tokens[name] = root.getPropertyValue(name).trim();
  }
  return {
    colorScheme: root.colorScheme,
    tokens,
    body: body.backgroundColor,
    group: group ? getComputedStyle(group).backgroundColor : null,
    fallbackBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  };
})()`;

/** The appearance the settings surface itself reports, which is the mode in force. */
const MEASURE = (label, measured) => {
  console.log(`     ${label} settings surface: color-scheme=${measured.colorScheme} body=${measured.body} group=${measured.group} --bg=${measured.tokens['--bg']} --card=${measured.tokens['--card']}`);
};

app.whenReady().then(async () => {
  await delay(9000);

  const gatewayView = view(String(PORT));
  check(`${CASE}/${APPEARANCE}: the gateway's page was loaded`, Boolean(gatewayView), 'no view at the stub address');
  if (gatewayView && CASE !== 'none') {
    const served = await gatewayView.executeJavaScript(
      "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()",
    );
    console.log(`note the gateway's own --bg, as served: ${JSON.stringify(served)}`);
  }

  const settings = menuItem('Settings…');
  check(`${CASE}/${APPEARANCE}: the app offers Settings`, Boolean(settings), 'no Settings… item');
  if (settings) settings.click();
  await delay(3000);

  const page = view('settings.html');
  check(`${CASE}/${APPEARANCE}: the settings surface opened`, Boolean(page), 'settings.html never loaded');
  if (!page) { clearTimeout(watchdog); app.exit(1); return; }

  const measured = await page.executeJavaScript(SURFACE);
  MEASURE(`${CASE}/${APPEARANCE}`, measured);
  await grab(`settings-theme-${CASE}-${APPEARANCE}`);

  if (CASE === 'none') {
    // Nothing could be resolved, so the app's own palette is what is on screen. It
    // must still be a whole page, and the app must SAY which palette that is:
    // silence here is indistinguishable from the fault this harness exists for.
    check('the app states that no palette resolved',
      lines.some((l) => /no resolved palette|refusing this report/.test(l)),
      `the app said nothing about it; its lines were: ${JSON.stringify(lines.filter((l) => /theme/.test(l)))}`);
    check('the settings page still paints a background from the fallback palette',
      measured.body === 'rgb(10, 10, 10)', `body is ${measured.body}`);
    check('and it is in the fallback appearance, whole rather than mixed',
      measured.colorScheme === 'dark', `color-scheme is ${measured.colorScheme}`);
    check('with a card surface that is the fallback palette\'s own',
      measured.group === 'rgb(22, 25, 32)', `group is ${measured.group}`);
  } else {
    check(`${CASE}/${APPEARANCE}: the app adopted a palette from the page`,
      lines.some((l) => /^\[claw-desktop\] theme: (light|dark) .*\(\d+ tokens\)$/.test(l)),
      JSON.stringify(lines.filter((l) => /theme/.test(l))));

    // THE guard. Every colour ui.css declares, as the settings surface resolves it.
    //
    // Three kinds of expectation, and each is a different claim:
    //   - a live COLOUR or LENGTH must come back as the published value, exactly;
    //   - a live FONT or SHADOW is normalised differently on each side, so the
    //     claim is that it is no longer the stylesheet's own fallback;
    //   - a name ui.css OWNS is the one thing the app must NOT take from the page,
    //     so it has to differ from what was published.
    // A colour that is neither live nor owned falls through to the first rule and
    // fails, which is the point: ui.css is declaring a palette colour whose owner
    // nobody has decided.
    const wrong = [];
    const flat = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const entry of COMPARED) {
      const got = measured.tokens[entry.name];
      if (entry.ours) {
        if (!got) { wrong.push(`${entry.name} is ours and the page resolved it to nothing`); continue; }
        if (flat(got) === flat(entry.published)) wrong.push(`${entry.name} is ours but the page took the published value ${entry.published}`);
        continue;
      }
      if (entry.kind === 'font' || entry.kind === 'shadow') {
        if (!got || flat(got) === flat(entry.declared)) {
          wrong.push(`${entry.name} is still the stylesheet's own ${entry.declared}, so the published ${entry.published} never reached it`);
        }
        continue;
      }
      const want = rgb(entry.published);
      if (got !== want) {
        wrong.push(`${entry.name} resolved to ${got}, and the Control UI published ${want} (${entry.published})${LIVE.has(entry.name) ? '' : ' — and the name is not in the live list, so no palette can ever reach it'}`);
      }
    }
    check(`${CASE}/${APPEARANCE}: every colour ui.css declares comes from the published palette`,
      wrong.length === 0,
      `${wrong.length} of ${COMPARED.length} wrong:\n      ${wrong.join('\n      ')}`);

    check('the settings page paints its own background from the palette',
      measured.body === rgb(published['--bg']), `body is ${measured.body}, expected ${rgb(published['--bg'])}`);
    check('and its group surfaces from the palette',
      measured.group === rgb(published['--card']), `group is ${measured.group}, expected ${rgb(published['--card'])}`);
    check('the settings page is in the published appearance, not the fallback one',
      measured.colorScheme === APPEARANCE, `color-scheme is ${measured.colorScheme}`);
  }

  if (CASE === 'switch') {
    const pressed = await page.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('#gateways .settings-row')].find((r) => {
        const url = r.querySelector('.url');
        return url && url.textContent.includes('19211');
      });
      if (!row) return { error: 'no row for the second gateway' };
      const button = [...row.querySelectorAll('button')].find((b) => /^(Connect|Reconnect)/.test(b.textContent.trim()));
      if (!button) return { error: 'the row offers no Connect' };
      const label = button.textContent.trim();
      button.click();
      return { label };
    })()`);
    check('the second gateway could be connected to from its row',
      Boolean(pressed) && /^(Connect|Reconnect)$/.test(pressed.label || ''), JSON.stringify(pressed));
    // The load happens off-screen until it finishes, so give the whole sequence.
    await delay(13000);

    const second = view('19211');
    check(`${CASE}/${APPEARANCE}: the second gateway's page was loaded`, Boolean(second), 'no view at the second address');

    const settings2 = menuItem('Settings…');
    if (settings2) settings2.click();
    await delay(3000);
    const after = view('settings.html');
    const measured2 = after ? await after.executeJavaScript(SURFACE) : null;
    MEASURE(`${CASE}/${APPEARANCE} after the switch`, measured2 || {});

    check('the settings surface still wears the palette of the gateway it was switched to',
      Boolean(measured2) && measured2.tokens['--bg'] === rgb(published['--bg']),
      `--bg is ${measured2 && measured2.tokens['--bg']}, expected ${rgb(published['--bg'])}`);
    check('and it is in that gateway\'s appearance rather than the stored one',
      Boolean(measured2) && measured2.colorScheme === APPEARANCE,
      `color-scheme is ${measured2 && measured2.colorScheme}`);
  }

  if (SHOTS) console.log(`note screenshots in ${SHOTS}`);
  clearTimeout(watchdog);
  server.close();
  serverB.close();
  console.log(failed ? 'FAILED' : 'ALL OK');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  server.close();
  serverB.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
