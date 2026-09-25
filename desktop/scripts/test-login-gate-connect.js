// Measure what the reader sees after pressing Connect on the Control UI's OWN
// login gate, its "Gateway unreachable" screen.
//
// The report (Abi, 2026-09-25): pressing Connect there "just hangs there for a
// while, we should do the load page there until the UI renders". The claim is
// about what is on screen DURING the connect, so it is measured by sampling the
// app's own view stack from the press to the end, not by where it ended.
//
//   npx electron scripts/test-login-gate-connect.js --case connect|refused [--record DIR]
//
//   connect   the gate is on screen, the gateway answers the press after a delay.
//             The loading cover must be up within a moment of the press, stay up
//             while the gate is still in the document, and lift once it has gone.
//   refused   the gate is on screen and the press is refused again. The cover must
//             come up and land on its failed state, never back on the gate.
//
// It needs a REAL gateway, because the gate is the real Control UI's: the page is
// served through a proxy of this script's own, in front of the gateway named by
// --upstream (default 127.0.0.1:18995), which can refuse or delay the page's
// socket while it still serves the document. That is how the gate is reached: a
// reconnect of ours loads the page, the page's socket is refused, and the page
// draws its gate. The proxy is this app's alone, so nothing else on the host is
// rerouted. The gateway's Control UI must allow the proxy's origin
// (http://127.0.0.1:18996) in gateway.controlUi.allowedOrigins.
//
// --record writes one PNG per sample of whichever view is on top (the cover sits
// above the page, which is the z-order main.js keeps), so the frames can be put
// together into a recording of the press.
//
// Pinned BOTH ways through the --user-data-dir switch as well as the path, for the
// reason scripts/test-connection-failure.js records.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createLoginGateProxy, upstreamAnswers } from './lib/login-gate-proxy.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CASE = (arg('case', 'connect') || '').toLowerCase();
if (!['connect', 'refused'].includes(CASE)) {
  console.error('--case must be connect or refused, not ' + CASE);
  process.exit(2);
}
const RECORD = arg('record');
if (RECORD) fs.mkdirSync(RECORD, { recursive: true });
const [UP_HOST, UP_PORT] = (arg('upstream', '127.0.0.1:18995')).split(':');
const PORT = 18996;
const BASE = 'http://127.0.0.1:' + PORT;
const CONNECT_DELAY_MS = 3000;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-login-gate-' + CASE + '-'));

const { app, webContents } = await import('electron');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  gateways: [{ id: 'gate', label: 'Login gate test', url: BASE + '/' }],
  activeGatewayId: 'gate',
}, null, 2) + '\n');

const proxy = createLoginGateProxy({ upstreamHost: UP_HOST, upstreamPort: Number(UP_PORT) });
if (!(await upstreamAnswers(UP_HOST, Number(UP_PORT)))) {
  console.error('SKIP no gateway answering at ' + UP_HOST + ':' + UP_PORT + '; start one (openclaw gateway run) and allow ' + BASE);
  process.exit(3);
}
await proxy.listen(PORT);
await import('../src/main.js');

/* ------------------------------------------------------------------ helpers */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}
setTimeout(() => { console.error('FAIL harness: still running after 120s'); app.exit(1); }, 120000).unref();

const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const pageWc = () => live().find((wc) => wc.getURL().startsWith(BASE)) || null;
const coverWc = () => live().find((wc) => wc.getURL().includes('loading.html')) || null;
const GATE_PROBE = "(function(){return JSON.stringify({gate:!!document.querySelector('openclaw-login-gate'),failure:!!document.querySelector('.login-gate__failure'),text:((document.body&&document.body.innerText)||'').length})})()";

/** What is on top, by the app's own stacking: the cover over the page. */
async function sample() {
  const cover = coverWc();
  const page = pageWc();
  let coverTitle = null;
  let gate = null;
  if (cover) { try { coverTitle = await cover.executeJavaScript("document.getElementById('title').textContent", true); } catch { coverTitle = '?'; } }
  if (page) { try { gate = JSON.parse(await page.executeJavaScript(GATE_PROBE, true)); } catch { gate = null; } }
  return { cover: coverTitle, gate: gate ? gate.gate : null, failure: gate ? gate.failure : null, text: gate ? gate.text : 0 };
}

async function until(pred, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await sample();
    if (pred(s)) return s;
    await delay(step);
  }
  return null;
}

let frameNo = 0;
async function record(label) {
  if (!RECORD) return;
  const top = coverWc() || pageWc();
  if (!top) return;
  try {
    const image = await top.capturePage();
    if (!image.isEmpty()) {
      frameNo += 1;
      fs.writeFileSync(path.join(RECORD, String(frameNo).padStart(4, '0') + '-' + label + '.png'), image.toPNG());
    }
  } catch { /* a frame we could not take is not a claim */ }
}

/* --------------------------------------------------------------------- run */

app.whenReady().then(async () => {
  const first = await until((s) => s.gate === false && s.text > 0 && s.cover === null, 30000);
  check('the Control UI rendered from the gateway', Boolean(first), 'no rendered page in 30s');

  // Reach the gate: the page's socket is refused, our reconnect loads the page,
  // and the page draws its own "Gateway unreachable".
  proxy.set({ socket: 'refuse' });
  proxy.cut();
  const gated = await until((s) => s.gate === true && s.failure === true && s.cover === null, 20000);
  check('the Control UI login gate is on screen with its failure', Boolean(gated), 'the gate never came up');
  await delay(1500);

  if (CASE === 'connect') proxy.set({ socket: 'pass', delay: CONNECT_DELAY_MS });
  const samples = [];
  const pressedAt = Date.now();
  await record('gate');
  await pageWc().executeJavaScript("document.querySelector('.login-gate__connect').click()", true);
  const windowMs = CASE === 'connect' ? CONNECT_DELAY_MS + 4000 : 6000;
  while (Date.now() - pressedAt < windowMs) {
    const s = await sample();
    s.at = Date.now() - pressedAt;
    samples.push(s);
    await record(s.cover ? 'cover' : (s.gate ? 'gate' : 'ui'));
    await delay(60);
  }
  for (const s of samples) console.log('  +' + String(s.at).padStart(5) + 'ms cover=' + JSON.stringify(s.cover) + ' gate=' + s.gate + ' failure=' + s.failure);

  const firstCover = samples.find((s) => s.cover);
  check('the press puts the loading screen up at once', firstCover && firstCover.at <= 600,
    firstCover ? 'first cover at +' + firstCover.at + 'ms' : 'the loading screen never came up; the gate sat there for the whole connect');
  const afterCover = firstCover ? samples.slice(samples.indexOf(firstCover)) : [];

  if (CASE === 'connect') {
    const bare = afterCover.find((s) => !s.cover && s.gate);
    check('the gate is never shown bare once the cover is up', !bare, bare ? 'gate uncovered at +' + bare.at + 'ms' : '');
    const gone = samples.find((s) => s.gate === false);
    const lifted = afterCover.find((s) => !s.cover);
    check('the cover lifts only once the interface has replaced the gate', lifted && gone && lifted.at >= gone.at,
      'lifted at ' + (lifted ? lifted.at : 'never') + ', gate gone at ' + (gone ? gone.at : 'never'));
    const last = samples[samples.length - 1];
    check('the interface is on screen at the end', last && !last.cover && last.gate === false, JSON.stringify(last));
  } else {
    const landed = afterCover.find((s) => s.cover && s.cover !== 'Connecting…');
    check('a refused connect lands on the failed state', Boolean(landed), 'cover titles: ' + [...new Set(afterCover.map((s) => s.cover))].join(', '));
    const bare = afterCover.find((s) => !s.cover);
    check('and never back on the bare gate', !bare, bare ? 'uncovered at +' + bare.at + 'ms' : '');
  }

  await proxy.close();
  console.log(failed ? 'FAILED' : 'PASSED');
  app.exit(failed ? 1 : 0);
});
