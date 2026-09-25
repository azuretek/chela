// A message typed while a reply is running must reach the gateway exactly once,
// and must never sit stuck in the page's queue on a live connection.
//
//   OPENCLAW_SEED_TOKEN=... CLAW_QUEUE_GATEWAY=https://host npx electron scripts/test-queued-send.js --shots DIR
//
// Opt-in and live: it drives a real gateway and costs one real agent reply.
//
// Delivery is judged from the GATEWAY'S OWN RECORD of the session, read with a
// chat.history request over the page's own authenticated socket, never from
// what the page renders: the client draws a queued message optimistically from
// its own store, and after a reload the rendered transcript gave a false
// negative for a reply that existed. Every message must appear in that record
// EXACTLY ONCE as a user turn, and must have been answered. The second
// judgement is the client's own persisted queue, which must be empty once the
// run has ended: an item left in a waiting state is what blocks every later
// message (measured 2026-09-25 on a real session, where a message the gateway
// had already answered sat in waiting-reconnect and the message behind it was
// never attempted).
//
// Every WebSocket frame the page sends or receives is logged to frames.jsonl
// beside the screenshots, with any credential-shaped field redacted, so a
// failing run shows which receipt the queue was waiting for.
//
// Exits 0 only if every message is in the gateway record exactly once, the
// session goes idle with a reply after the last message, no queued message sat
// in waiting-reconnect, unconfirmed or failed for longer than 8 seconds on a
// socket that never closed, no stored queue item is left, and the page is still
// on its composer.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, webContents } from 'electron';
import secrets from '../src/secrets.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg('--shots', null);
const GATEWAY = process.env.CLAW_QUEUE_GATEWAY;
const TOKEN = process.env.OPENCLAW_SEED_TOKEN;
if (!GATEWAY || !TOKEN) { console.error('need CLAW_QUEUE_GATEWAY and OPENCLAW_SEED_TOKEN'); process.exit(2); }
delete process.env.OPENCLAW_SEED_TOKEN;

const TMP = process.env.CLAW_QUEUE_PROFILE || path.join(os.tmpdir(), 'claw-queue-profile');
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(os.tmpdir(), 'claw-queue-' + process.pid + '.log');
const record = (line) => { const l = new Date().toISOString() + ' ' + line; fs.appendFileSync(LOG, l + '\n'); console.log(l); };
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// WebSocket frames, logged from the moment each page exists. A frame is parsed,
// any credential-shaped field is replaced, and long strings are cut, so the file
// can be read and shared without carrying a secret.
const FRAMES = path.join(SHOTS || os.tmpdir(), SHOTS ? 'frames.jsonl' : 'claw-queue-frames-' + process.pid + '.jsonl');
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
const historyReplies = [];
const onFrame = (dir, payload) => {
  let msg;
  try { msg = JSON.parse(payload); } catch { fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir, unparsed: String(payload).length }) + '\n'); return; }
  if (dir === 'out' && msg && msg.type === 'req') methodById.set(msg.id, msg.method);
  const method = msg && msg.type === 'res' ? methodById.get(msg.id) : undefined;
  if (method === 'chat.history' && msg.ok && msg.payload) historyReplies.push({ t: Date.now(), payload: msg.payload });
  fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir, ...(method ? { method } : {}), frame: redact(msg) }) + '\n');
};
app.on('web-contents-created', (_e, wc) => {
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { record('note frame logger attach failed: ' + e.message); return; }
  wc.debugger.on('message', (_ev, method, params) => {
    if (method === 'Network.webSocketFrameSent') onFrame('out', params.response && params.response.payloadData);
    else if (method === 'Network.webSocketFrameReceived') onFrame('in', params.response && params.response.payloadData);
    else if (method === 'Network.webSocketClosed') { socketsClosedAt.push(Date.now()); fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir: 'closed' }) + '\n'); }
    else if (method === 'Network.webSocketCreated') socketsCreatedAt.push(Date.now()), fs.appendFileSync(FRAMES, JSON.stringify({ t: Date.now(), dir: 'created', url: String(params.url || '').replace(/[?#].*$/, '') }) + '\n');
  });
  wc.debugger.sendCommand('Network.enable').catch((e) => record('note Network.enable failed: ' + e.message));
});

const RUN = Date.now().toString(36);
const SESSION = process.env.CLAW_QUEUE_SESSION || ('agent:main:dashboard:queue-proof-' + RUN);
const LONG_COUNT = Number(process.env.CLAW_QUEUE_LONG_COUNT || 400);
// A row may sit in a settling state for a moment; longer than this on a live
// socket is the stuck row the reader sees.
const STUCK_LIMIT_MS = Number(process.env.CLAW_QUEUE_STUCK_MS || 8000);
const CHAT_URL = GATEWAY.replace(/\/$/, '') + '/chat?session=' + encodeURIComponent(SESSION);
const GW_ID = 'queue-proof';
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  gateways: [{ id: GW_ID, label: 'queue proof', url: CHAT_URL }],
  activeGatewayId: GW_ID,
}, null, 2));

app.whenReady().then(() => {
  secrets.set(GW_ID, { token: TOKEN });
  record('seeded a throwaway profile at ' + path.basename(TMP) + ', session ' + SESSION);
});
await import('../src/main.js');

const gatewayPage = () => webContents.getAllWebContents()
  .filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY))
  .pop();

const DEEP = 'function deep(root, out) { out = out || []; for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) deep(el.shadowRoot, out); } return out; }';
async function evalPage(src, ms = 8000) {
  try {
    const wc = gatewayPage();
    if (!wc) return null;
    return await Promise.race([wc.executeJavaScript('(() => { ' + DEEP + ' ' + src + ' })()').catch(() => null), delay(ms).then(() => null)]);
  } catch { return null; }
}

// Every queue the page has persisted, wherever it keeps it. Both stores are
// walked and any queue array is collected, because the Control UI's storage
// layout is not an API and moving it must not silently empty this test.
const STORE_WALK = [
  'const found = [];',
  'const walk = (node, at) => {',
  '  if (!node || typeof node !== "object") return;',
  '  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, at + "[" + i + "]")); return; }',
  '  for (const k of Object.keys(node)) {',
  '    if (k === "queue" && Array.isArray(node[k])) {',
  '      found.push({ at: at, items: node[k].map((q) => ({',
  '        text: String((q && q.text) || "").slice(0, 70),',
  '        sendState: q && q.sendState, sendAttempts: q && q.sendAttempts,',
  '        sendRunId: q && q.sendRunId, queueMode: q && q.queueMode,',
  '      })) });',
  '    } else walk(node[k], at + "." + k);',
  '  }',
  '};',
  'const stores = [["session", sessionStorage], ["local", localStorage]];',
  'for (const pair of stores) {',
  '  const where = pair[0]; const store = pair[1];',
  '  for (let i = 0; i < store.length; i++) {',
  '    const key = store.key(i); const raw = store.getItem(key);',
  '    if (!raw || raw.indexOf(String.fromCharCode(34) + "queue" + String.fromCharCode(34)) === -1) continue;',
  '    let parsed; try { parsed = JSON.parse(raw); } catch (e) { continue; }',
  '    const before = found.length;',
  '    walk(parsed, where + ":" + key.slice(0, 40));',
  '    for (const f of found.slice(before)) f.key = key.slice(0, 80);',
  '  }',
  '}',
  'return JSON.stringify(found);',
].join('\n');

const storedQueues = () => evalPage(STORE_WALK);
const storedItems = async () => {
  const raw = await storedQueues();
  let queues = [];
  try { queues = JSON.parse(String(raw)); } catch { return null; }
  return queues.flatMap((q) => (q.items || []).map((i) => ({ ...i, where: q.where || q.at, key: q.key })));
};
const pageText = () => evalPage('return String(document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300);');
const composerPresent = () => evalPage('return deep(document).some(e => e.tagName === "TEXTAREA" && e.offsetParent !== null);');

async function cdpShot(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const r = await Promise.race([wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }), delay(8000).then(() => null)]);
    return r && r.data ? Buffer.from(r.data, 'base64') : null;
  } catch (e) { record('note cdp shot failed: ' + e.message); return null; }
}
async function shot(name) {
  if (!SHOTS) return;
  for (const wc of webContents.getAllWebContents().filter((w) => !w.isDestroyed())) {
    let url = ''; try { url = wc.getURL(); } catch { continue; }
    const kind = url.startsWith(GATEWAY) ? 'gateway' : (/loading\.html/.test(url) ? 'cover' : null);
    if (!kind) continue;
    const png = await cdpShot(wc);
    if (!png) { record('note shot ' + name + '-' + kind + ' came back empty'); continue; }
    fs.writeFileSync(path.join(SHOTS, name + '-' + kind + '.png'), png);
    record('shot ' + name + '-' + kind + ' (' + png.length + ' bytes)');
  }
}

async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await delay(1000);
  }
  record('TIMEOUT waiting for ' + label);
  return null;
}

async function send(text) {
  const found = await evalPage('const all = deep(document).filter(e => e.tagName === "TEXTAREA" && e.offsetParent !== null); const t = all.find(e => /message|ask|send/i.test(e.placeholder || "")) || all.pop(); if (!t) return "no composer"; t.focus(); t.value = ""; t.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true })); return "focused " + (t.placeholder || "");');
  const wc = gatewayPage();
  if (!wc || wc.isDestroyed() || !String(found).startsWith('focused')) { record('send: ' + found); return false; }
  wc.focus();
  await wc.insertText(text);
  await delay(300);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  record('send ' + JSON.stringify(text) + ': ' + found);
  return true;
}

// The gateway's own record of the session: chat.history, sent over the page's
// own authenticated socket so the test needs no credential of its own. If the
// page ever stops exposing its client, the newest chat.history reply the page
// itself received is used instead, and the check says so.
const HISTORY_SRC = 'const c = deep(document).map((e) => e.client).find((c) => c && typeof c.request === "function"); if (!c) return "NO_CLIENT"; return c.request("chat.history", { sessionKey: ' + JSON.stringify(SESSION) + ', limit: 1000 }).then((r) => JSON.stringify(r)).catch((e) => "ERR " + e.message);';
let recordSource = 'unread';
async function gatewayRecord() {
  const raw = await evalPage(HISTORY_SRC, 20000);
  if (typeof raw === 'string' && raw.startsWith('{')) { recordSource = 'chat.history over the page client'; return JSON.parse(raw); }
  const last = historyReplies[historyReplies.length - 1];
  if (last) { recordSource = 'newest chat.history reply the page received (' + String(raw) + ')'; return last.payload; }
  recordSource = 'none (' + String(raw) + ')';
  return null;
}
const textOf = (m) => {
  const c = m && (m.content !== undefined ? m.content : m.text);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && (p.text || (typeof p.content === 'string' ? p.content : ''))) || '').join(' ');
  return '';
};
// For one marker: how many user turns carry it, how many replies carry it after
// the first such user turn, and whether the gateway still holds it as pending.
const tally = (hist, marker) => {
  const msgs = (hist && hist.messages) || [];
  const users = msgs.map((m, i) => (m && m.role === 'user' && textOf(m).includes(marker) ? i : -1)).filter((i) => i >= 0);
  const firstUser = users.length ? users[0] : Infinity;
  const replies = msgs.filter((m, i) => i > firstUser && m && m.role === 'assistant' && textOf(m).includes(marker)).length;
  const pending = ((hist && hist.pendingInputs && hist.pendingInputs.items) || []).filter((i) => JSON.stringify(i).includes(marker)).map((i) => i.state);
  return { user: users.length, replies, pending };
};
const runActive = (hist) => Boolean(hist && hist.sessionInfo && (hist.sessionInfo.hasActiveRun === true || hist.sessionInfo.status === 'running' || hist.sessionInfo.status === 'queued'));

const evidence = { run: RUN, session: SESSION, checks: [] };
const check = (name, pass, detail) => { evidence.checks.push({ name, pass: Boolean(pass), detail }); record('CHECK ' + (pass ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); return Boolean(pass); };

app.whenReady().then(() => delay(500)).then(async () => {
  let ok = true;
  try {
    const ready = await waitFor('the composer', composerPresent, 90000);
    if (!ready) throw new Error('never reached the composer');
    // A fresh profile is approved mid-launch, and the app reconnects while it
    // settles. Start only once the page has held one socket for a while, so a
    // setup reconnect is never read as the product losing a message.
    const settledConnection = await waitFor('one socket held for 12s', async () => {
      const last = socketsCreatedAt[socketsCreatedAt.length - 1] || 0;
      return Date.now() - last > 12000 && (await composerPresent()) === true;
    }, 180000);
    if (!settledConnection) throw new Error('the connection never settled after pairing');
    socketsClosedAt.length = 0;
    await shot('01-connected');
    record('page at connect: ' + await pageText());

    const A = 'QLONGRUN' + RUN, B = 'QB' + RUN, C = 'QC' + RUN;
    // A long run, so the two messages below are typed while it is in flight.
    // A long reply the agent cannot be steered out of: the two messages below land
    // mid-generation, so the gateway holds them as pending inputs for the rest of
    // it, which is the window a stuck row shows in. A tool call is the wrong
    // shape here, because a steered input skips it and settles at once.
    await send('Write the whole numbers from 1 to ' + LONG_COUNT + ' as English words, one per line, with nothing else, and then a final line that says exactly ' + A + '.');
    await delay(5000);
    // Sample the page's stored outbox for the whole scenario. A row counts as
    // stuck while it sits in a settling state on a socket that has not closed.
    const stuck = new Map();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const items = await storedItems();
        const now = Date.now();
        for (const i of items || []) {
          if (!/waiting-reconnect|unconfirmed|failed/.test(String(i.sendState || ''))) continue;
          const key = i.sendRunId + ' ' + i.sendState;
          const seen = stuck.get(key) || { text: i.text, sendState: i.sendState, first: now, last: now };
          if (socketsClosedAt.some((t) => t > seen.first)) { seen.first = now; }
          seen.last = now;
          stuck.set(key, seen);
        }
        await delay(500);
      }
    })();

    // The case: one message typed during the reply, then a second behind it.
    await send('Reply with exactly ' + B + ' and nothing else.');
    await delay(2000);
    await shot('02-queued-during-run');
    record('queue while the run is in flight: ' + JSON.stringify(await storedItems()));
    await send('Reply with exactly ' + C + ' and nothing else.');
    await delay(2000);
    record('queue after the second message: ' + JSON.stringify(await storedItems()));
    await shot('03-two-queued');

    // The run ends, and the queue must drain on its own. Delivery is read from
    // the gateway's record, never from the page.
    const markers = { A, B, C };
    const settled = await waitFor('the gateway to record every message and go idle', async () => {
      const hist = await gatewayRecord();
      if (!hist || runActive(hist)) return null;
      const t = Object.fromEntries(Object.entries(markers).map(([k, m]) => [k, tally(hist, m)]));
      const last = (hist.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-1)[0];
      return Object.values(t).every((x) => x.user >= 1 && x.pending.length === 0) && last && last.role === 'assistant' ? t : null;
    }, 300000);
    record('record source: ' + recordSource);

    // Let anything late land, so a duplicate send is caught rather than raced.
    await delay(20000);
    sampling = false;
    await sampler;
    const hist = await gatewayRecord();
    const final = Object.fromEntries(Object.entries(markers).map(([k, m]) => [k, tally(hist, m)]));
    record('gateway record: ' + JSON.stringify(final) + ' via ' + recordSource);
    evidence.gatewayRecord = { source: recordSource, tally: final, messages: ((hist && hist.messages) || []).length, pendingInputs: hist && hist.pendingInputs };
    evidence.reconcileInstalled = await evalPage('return Boolean(window.__clawOutboxReconcile);');
    evidence.reconcileLog = await evalPage('return window.__clawOutboxReconcile ? window.__clawOutboxReconcile.log : null;');
    record('reconcile script installed: ' + evidence.reconcileInstalled + ' log: ' + JSON.stringify(evidence.reconcileLog));
    ok = check('the gateway record was read', Boolean(hist), { source: recordSource }) && ok;
    for (const [k, x] of Object.entries(final)) {
      ok = check('message ' + k + ' reached the gateway exactly once', x.user === 1 && x.pending.length === 0, x) && ok;
    }
    const lastTurn = ((hist && hist.messages) || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-1)[0];
    ok = check('the session went idle with a reply after the last message', Boolean(settled) && lastTurn && lastTurn.role === 'assistant', null) && ok;
    const longest = [...stuck.values()].map((v) => ({ ...v, ms: v.last - v.first })).sort((x, y) => y.ms - x.ms);
    evidence.stuckRows = longest;
    ok = check('no queued message sat stuck on a live socket longer than ' + STUCK_LIMIT_MS + 'ms', !longest.length || longest[0].ms <= STUCK_LIMIT_MS, { socketsClosed: socketsClosedAt.length, longest: longest.slice(0, 3) }) && ok;

    const after = await storedItems();
    record('queue after the run: ' + JSON.stringify(after));
    await shot('04-after-run');
    ok = check('no stored queue item is left', (after || []).length === 0, { queued: after }) && ok;

    const connected = await composerPresent();
    ok = check('the page is still on the composer at the end', connected, null) && ok;
  } catch (e) {
    ok = false;
    record('ERROR ' + e.message);
    evidence.error = e.message;
  }
  evidence.pass = ok;
  const out = path.join(SHOTS || os.tmpdir(), 'queued-send-result.json');
  try { fs.writeFileSync(out, JSON.stringify(evidence, null, 2)); record('evidence ' + out); } catch (e) { record('note evidence write failed: ' + e.message); }
  record(ok ? 'RESULT PASS' : 'RESULT FAIL');
  record('log ' + LOG + ' frames ' + FRAMES + ' session ' + SESSION);
  app.exit(ok ? 0 : 1);
});
