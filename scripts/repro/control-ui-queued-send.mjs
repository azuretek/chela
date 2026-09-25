// Reproduces the Control UI queued-send fault in a plain browser, with no Chela
// code in the page: a message typed while a reply is running must reach the
// gateway exactly once and must never sit in a reconnect or failed state on a
// socket that never closed.
//
//   GATEWAY_URL=https://gateway.example OPENCLAW_TOKEN=... \
//     node scripts/repro/control-ui-queued-send.mjs --out DIR [--ui-dist DIR] [--session KEY]
//
// playwright-core must resolve from the working directory (an OpenClaw checkout
// has it), and a Playwright Chromium must be installed (or named by CHROMIUM_PATH). Opt-in and live: it
// costs one real agent reply. A new browser profile is a new device, so the
// gateway must approve its pairing (scripts/repro/approve-test-devices.mjs).
//
// --ui-dist serves a locally built Control UI (the dist/control-ui directory of
// an OpenClaw checkout) in place of the gateway's own, inside this browser only:
// the gateway's HTML is kept, with its asset tags swapped for the build's, and
// any asset the build has is answered from disk. That is how a fix is proved
// against a live gateway without touching the gateway. The gateway admits a
// Control UI only when the build id compiled into it matches its own, so build
// with OPENCLAW_CONTROL_UI_BUILD_ID set to the gateway's (the value of the
// data-openclaw-control-ui-build-id attribute on its /chat page, without the
// trailing 64-hex asset hash); a mismatched build is refused PROTOCOL_MISMATCH.
//
// Writes frames.jsonl (every WebSocket frame, credential-shaped fields
// redacted), screenshots, and result.json into --out. Exits 0 only if every
// message is in the gateway record exactly once, the session ends idle with a
// reply last, no queued row sat in waiting-reconnect, unconfirmed or failed for
// longer than the stuck limit on a live socket, and the stored queue is empty.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const { chromium } = require('playwright-core');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const GATEWAY = (process.env.GATEWAY_URL || '').replace(/\/$/, '');
const TOKEN = process.env.OPENCLAW_TOKEN;
if (!GATEWAY || !TOKEN) { console.error('need GATEWAY_URL and OPENCLAW_TOKEN'); process.exit(2); }
delete process.env.OPENCLAW_TOKEN;
const OUT = arg('--out', null);
if (!OUT) { console.error('need --out DIR'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const UI_DIST = arg('--ui-dist', null);
const RUN = arg('--run', Date.now().toString(36));
const SESSION = arg('--session', 'agent:main:dashboard:queue-repro-' + RUN);
const LONG_COUNT = Number(arg('--long-count', 400));
const STUCK_LIMIT_MS = Number(arg('--stuck-ms', 8000));
const HEADED = process.argv.includes('--headed');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, 'run.log');
const record = (line) => { const l = new Date().toISOString() + ' ' + line; fs.appendFileSync(LOG, l + '\n'); console.log(l); };

const FRAMES = path.join(OUT, 'frames.jsonl');
const SECRET_KEY = /token|auth|signature|secret|password|nonce|cookie|publickey|setupcode|credential/i;
const redact = (v, depth = 0) => {
  if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '...(' + v.length + ' chars)' : v;
  if (!v || typeof v !== 'object' || depth > 14) return v;
  if (Array.isArray(v)) return v.slice(0, 80).map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1);
  return out;
};
const methodById = new Map();
const socketsClosedAt = [];
const socketsCreatedAt = [];
const onFrame = (dir, payload) => {
  let msg;
  try { msg = JSON.parse(payload); } catch { fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir, unparsed: String(payload).length }) + '\n'); return; }
  if (dir === 'out' && msg && msg.type === 'req') methodById.set(msg.id, msg.method);
  const method = msg && msg.type === 'res' ? methodById.get(msg.id) : (msg && msg.method);
  fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir, ...(method ? { method } : {}), frame: redact(msg) }) + '\n');
};

// Swap the gateway document's asset tags for the local build's, keeping every
// inline script (the gateway's CSP hashes them) and every attribute it injects.
let distIndex = null;
const ASSET_TAG = /<script\b[^>]*\bsrc="[^"]*assets\/[^"]*"[^>]*>\s*<\/script>|<link\b[^>]*\bhref="[^"]*assets\/[^"]*"[^>]*>/gi;
function swapAssets(html) {
  const gatewayTags = html.match(ASSET_TAG) || [];
  const buildTags = (distIndex.match(ASSET_TAG) || []).map((t) => t.replace(/(src|href)="[^"]*?(assets\/[^"]+)"/i, (_m, a, p) => a + '="/' + p + '"'));
  // The gateway stamps its own build id on <html>, and the page compares it with
  // the id compiled into its scripts: a mismatch reads as a stale document and
  // reloads it, dropping the token. So the stamp is replaced with the build's own.
  const buildStamp = (distIndex.match(/\sdata-[a-z-]*build-id="[^"]*"/i) || [''])[0];
  let out = html.replace(ASSET_TAG, '').replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\sdata-[a-z-]*build-id="[^"]*"/gi, '').replace(/<html\b/i, '<html' + buildStamp));
  out = out.replace(/<\/head>/i, buildTags.join('\n') + '\n</head>');
  record('ui-dist: swapped ' + gatewayTags.length + ' gateway asset tags for ' + buildTags.length + ' from the build');
  return out;
}
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json' };

// CHROMIUM_PATH picks a browser build when the installed Playwright browsers
// do not match this playwright-core version.
// A document answered by route.fulfill has no network address of its own, so
// Chromium's local-network checks treat it as public and block its socket to a
// private-range gateway. Those checks are switched off only for --ui-dist.
const LNA_OFF = ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'];
const browser = await chromium.launch({ headless: !HEADED, ...(UI_DIST ? { args: LNA_OFF } : {}), ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (UI_DIST) {
  distIndex = fs.readFileSync(path.join(UI_DIST, 'index.html'), 'utf8');
  await context.route((url) => url.origin === new URL(GATEWAY).origin, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = url.pathname.match(/assets\/(.+)$/);
    if (m) {
      const file = path.join(UI_DIST, 'assets', path.basename(m[1]));
      if (fs.existsSync(file)) return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' } });
      return route.continue();
    }
    if (req.resourceType() === 'document') {
      const res = await route.fetch();
      const type = res.headers()['content-type'] || '';
      if (!type.includes('text/html')) return route.fulfill({ response: res });
      return route.fulfill({ response: res, body: swapAssets(await res.text()) });
    }
    return route.continue();
  });
}
const page = await context.newPage();
page.on('websocket', (ws) => {
  socketsCreatedAt.push(Date.now());
  fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir: 'created', url: ws.url().replace(/[?#].*$/, '') }) + '\n');
  ws.on('framesent', (f) => onFrame('out', f.payload));
  ws.on('framereceived', (f) => onFrame('in', f.payload));
  ws.on('close', () => { socketsClosedAt.push(Date.now()); fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir: 'closed' }) + '\n'); });
});
page.on('console', (m) => { if (m.type() === 'error') fs.appendFileSync(LOG, 'console.error ' + m.text().slice(0, 300) + '\n'); });
page.on('response', (r) => { if (r.status() >= 400) fs.appendFileSync(LOG, 'http ' + r.status() + ' ' + r.url().replace(/[?#].*$/, '') + '\n'); });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) fs.appendFileSync(LOG, new Date().toISOString() + ' navigated ' + f.url().replace(/[?#].*$/, '') + '\n'); });

const DEEP = 'function deep(root, out) { out = out || []; for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) deep(el.shadowRoot, out); } return out; }';
const evalPage = async (src, ms = 8000) => {
  try { return await Promise.race([page.evaluate('(() => { ' + DEEP + ' ' + src + ' })()'), delay(ms).then(() => null)]); } catch { return null; }
};
const STORE_WALK = [
  'const found = [];',
  'const walk = (node) => {',
  '  if (!node || typeof node !== "object") return;',
  '  if (Array.isArray(node)) { node.forEach(walk); return; }',
  '  for (const k of Object.keys(node)) {',
  '    if (k === "queue" && Array.isArray(node[k])) node[k].forEach((q) => found.push({ text: String((q && q.text) || "").slice(0, 70), sendState: q && q.sendState, sendAttempts: q && q.sendAttempts, sendRunId: q && q.sendRunId }));',
  '    else walk(node[k]);',
  '  }',
  '};',
  'for (const store of [sessionStorage, localStorage]) for (let i = 0; i < store.length; i++) { const raw = store.getItem(store.key(i)); if (!raw || raw.indexOf(String.fromCharCode(34) + "queue" + String.fromCharCode(34)) === -1) continue; try { walk(JSON.parse(raw)); } catch (e) {} }',
  'return JSON.stringify(found);',
].join('\n');
const storedItems = async () => { try { return JSON.parse(String(await evalPage(STORE_WALK))); } catch { return null; } };
const composerPresent = () => evalPage('return deep(document).some(e => e.tagName === "TEXTAREA" && e.offsetParent !== null);');
const shot = async (name) => { try { await page.screenshot({ path: path.join(OUT, name + '.png') }); record('shot ' + name); } catch (e) { record('note shot ' + name + ' failed: ' + e.message); } };
async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await delay(1000); }
  record('TIMEOUT waiting for ' + label);
  return null;
}
async function send(text) {
  const found = await evalPage('const all = deep(document).filter(e => e.tagName === "TEXTAREA" && e.offsetParent !== null); const t = all.find(e => /message|ask|send/i.test(e.placeholder || "")) || all.pop(); if (!t) return "no composer"; t.focus(); return "focused";');
  if (found !== 'focused') { record('send: ' + found); return false; }
  await page.keyboard.insertText(text);
  await delay(300);
  await page.keyboard.press('Enter');
  record('send ' + JSON.stringify(text.slice(0, 60)));
  return true;
}
const HISTORY_SRC = 'const c = deep(document).map((e) => e.client).find((c) => c && typeof c.request === "function"); if (!c) return "NO_CLIENT"; return c.request("chat.history", { sessionKey: ' + JSON.stringify(SESSION) + ', limit: 1000 }).then((r) => JSON.stringify(r)).catch((e) => "ERR " + e.message);';
const gatewayRecord = async () => { const raw = await evalPage(HISTORY_SRC, 20000); return typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : null; };
const textOf = (m) => { const c = m && (m.content !== undefined ? m.content : m.text); if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join(' '); return ''; };
const tally = (hist, marker) => ({
  user: ((hist && hist.messages) || []).filter((m) => m && m.role === 'user' && textOf(m).includes(marker)).length,
  pending: ((hist && hist.pendingInputs && hist.pendingInputs.items) || []).filter((i) => JSON.stringify(i).includes(marker)).map((i) => i.state),
});
const runActive = (hist) => Boolean(hist && hist.sessionInfo && (hist.sessionInfo.hasActiveRun === true || hist.sessionInfo.status === 'running' || hist.sessionInfo.status === 'queued'));

const evidence = { run: RUN, session: SESSION, uiDist: Boolean(UI_DIST), checks: [] };
const check = (name, pass, detail) => { evidence.checks.push({ name, pass: Boolean(pass), detail }); record('CHECK ' + (pass ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); return Boolean(pass); };

let ok = true;
try {
  // The token rides in the fragment, which the page reads and then clears.
  await page.goto(GATEWAY + '/chat?session=' + encodeURIComponent(SESSION) + '#token=' + encodeURIComponent(TOKEN));
  record('opened the Control UI, session ' + SESSION + (UI_DIST ? ', local build' : ', gateway build'));
  // A document can load without the fragment (the page reloads itself once when
  // it replaces a build), and then it asks for the secret on its connect screen.
  // Answer it the way a person would: paste the token into that field and connect.
  let typedSecret = false;
  const answerSecretScreen = async () => {
    if (typedSecret) return;
    const field = page.locator('input[placeholder*="token" i], input[placeholder*="password" i]').first();
    if (!(await field.isVisible().catch(() => false))) return;
    typedSecret = true;
    await field.fill(TOKEN);
    await page.getByRole('button', { name: /^connect$/i }).first().click().catch(() => {});
    record('the page asked for the gateway secret; typed it into its connect screen');
  };
  if (!(await waitFor('the composer (approve the pairing if asked)', async () => { await answerSecretScreen(); return composerPresent(); }, 180000))) { await shot('00-no-composer'); throw new Error('never reached the composer'); }
  const settled = await waitFor('one socket held for 12s', async () => Date.now() - (socketsCreatedAt[socketsCreatedAt.length - 1] || 0) > 12000 && (await composerPresent()) === true, 180000);
  if (!settled) throw new Error('the connection never settled');
  socketsClosedAt.length = 0;
  await shot('01-connected');

  const A = 'QLONGRUN' + RUN, B = 'QB' + RUN, C = 'QC' + RUN;
  await send('Write the whole numbers from 1 to ' + LONG_COUNT + ' as English words, one per line, with nothing else, and then a final line that says exactly ' + A + '.');
  await delay(5000);
  const stuck = new Map();
  let sampling = true;
  const statusTexts = new Set();
  const sampler = (async () => {
    while (sampling) {
      const shown = await evalPage('return deep(document).filter((e) => e.offsetParent !== null && e.children.length === 0 && /reconnect|delivery was confirmed|retry only|not delivered|failed to send/i.test(e.textContent || "")).map((e) => e.textContent.trim().slice(0, 120));');
      for (const t of shown || []) statusTexts.add(t);
      const now = Date.now();
      for (const i of (await storedItems()) || []) {
        if (!/waiting-reconnect|unconfirmed|failed/.test(String(i.sendState || ''))) continue;
        const key = i.sendRunId + ' ' + i.sendState;
        const seen = stuck.get(key) || { text: i.text, sendState: i.sendState, first: now, last: now };
        if (socketsClosedAt.some((t) => t > seen.first)) seen.first = now;
        seen.last = now;
        stuck.set(key, seen);
      }
      await delay(500);
    }
  })();
  await send('Reply with exactly ' + B + ' and nothing else.');
  await delay(2000);
  await shot('02-queued-during-run');
  await send('Reply with exactly ' + C + ' and nothing else.');
  await delay(4000);
  record('queue with two messages typed during the run: ' + JSON.stringify(await storedItems()));
  await shot('03-two-queued');

  const markers = { A, B, C };
  const idle = await waitFor('the gateway to record every message and go idle', async () => {
    const hist = await gatewayRecord();
    if (!hist || runActive(hist)) return null;
    const last = (hist.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-1)[0];
    return Object.values(markers).every((m) => { const t = tally(hist, m); return t.user >= 1 && t.pending.length === 0; }) && last && last.role === 'assistant';
  }, 300000);
  await delay(20000);
  sampling = false;
  await sampler;
  const hist = await gatewayRecord();
  ok = check('the gateway record was read', Boolean(hist), null) && ok;
  for (const [k, m] of Object.entries(markers)) { const t = tally(hist, m); ok = check('message ' + k + ' reached the gateway exactly once', t.user === 1 && t.pending.length === 0, t) && ok; }
  ok = check('the session went idle with a reply after the last message', Boolean(idle), null) && ok;
  const longest = [...stuck.values()].map((v) => ({ ...v, ms: v.last - v.first })).sort((x, y) => y.ms - x.ms);
  evidence.stuckRows = longest;
  evidence.statusTextsShown = [...statusTexts];
  record('status text shown on queued rows: ' + JSON.stringify(evidence.statusTextsShown));
  ok = check('no queued message sat stuck on a live socket longer than ' + STUCK_LIMIT_MS + 'ms', !longest.length || longest[0].ms <= STUCK_LIMIT_MS, { socketsClosed: socketsClosedAt.length, longest: longest.slice(0, 3) }) && ok;
  const after = await storedItems();
  await shot('04-after-run');
  ok = check('no stored queue item is left', (after || []).length === 0, { queued: after }) && ok;
} catch (e) {
  ok = false;
  record('ERROR ' + e.message);
  evidence.error = e.message;
}
evidence.pass = ok;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(evidence, null, 2));
record(ok ? 'RESULT PASS' : 'RESULT FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
