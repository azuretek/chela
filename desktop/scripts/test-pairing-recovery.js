// Prove a new device recovers from the pairing screen once it is approved, even
// when the Control UI takes longer to load than the pairing retry cadence.
//
//   OPENCLAW_SEED_TOKEN=... CLAW_PAIRING_GATEWAY=https://host \
//     npx electron scripts/test-pairing-recovery.js --shots DIR [--kbps 400] [--latency-ms 150]
//
// Opt-in and live. A fresh profile is a new device, so the gateway sees a
// pairing request; something on the gateway host must approve it (the approver
// in scripts/repro/approve-test-devices.mjs on the Workshop side does, for test
// clients only). The token arrives in the environment, is seeded into the
// throwaway profile through the app's own credential store, and is never printed.
//
// The network of the gateway page, and of nothing else, is throttled through the
// page's own DevTools session, so a cold load of the Control UI takes the few
// seconds it takes on a slow link or a busy laptop. That is the condition the
// loop needs: the pairing retry reloads the page on a fixed beat, and a load that
// has not finished by the next beat is thrown away before its socket opens, so no
// attempt ever gets far enough to be approved.
//
// Exits 0 only if the pairing screen came down after the approval within the
// bound, and no retry beat replaced a page load that had not finished.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, webContents } from 'electron';
import secrets from '../src/secrets.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const SHOTS = arg('--shots', null);
const KBPS = Number(arg('--kbps', 400));
const LATENCY_MS = Number(arg('--latency-ms', 150));
const BOUND_MS = Number(arg('--bound-ms', 120000));
// How long to keep watching once the screen is down: a device that keeps
// reloading after its approval is the loop this also guards against.
const AFTER_MS = Number(arg('--after-ms', 60000));
const GATEWAY = (process.env.CLAW_PAIRING_GATEWAY || '').replace(/\/$/, '');
const TOKEN = process.env.OPENCLAW_SEED_TOKEN;
if (!GATEWAY || !TOKEN) { console.error('need CLAW_PAIRING_GATEWAY and OPENCLAW_SEED_TOKEN'); process.exit(2); }
delete process.env.OPENCLAW_SEED_TOKEN;

const TMP = process.env.CLAW_PAIRING_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'claw-pairing-'));
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const events = [];
const note = (kind, detail) => { events.push({ t: Date.now(), kind, detail }); console.log('[pairing-recovery] ' + since() + ' ' + kind + (detail ? ' ' + detail : '')); };

// The app's own log lines are the evidence of what it decided, so they are read
// rather than re-derived.
for (const level of ['log', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    const line = a.map(String).join(' ');
    if (line.includes('[chela-desktop] pairing: retrying the connect')) note('retry-beat');
    else if (line.includes('gateway refused this device')) note('refused');
    else if (line.includes('device pairing cleared')) note('cleared');
    orig(...a);
  };
}

const isGateway = (url) => typeof url === 'string' && url.startsWith(GATEWAY);
let loading = false;
let replacedLoads = 0;
async function throttle(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Network.enable');
    await wc.debugger.sendCommand('Network.emulateNetworkConditions', { offline: false, latency: LATENCY_MS, downloadThroughput: KBPS * 1024 / 8, uploadThroughput: KBPS * 1024 / 8 });
  } catch (e) { note('note', 'throttle failed: ' + e.message); }
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || !isGateway(details.url)) return;
    if (loading) { replacedLoads += 1; note('load-replaced', 'a new load started before the previous one finished'); }
    loading = true;
    note('load-start');
    void throttle(wc);
  });
  wc.on('did-start-loading', () => { try { if (isGateway(wc.getURL()) || isGateway(wc.getURL() || '')) note('wc-loading', 'wc ' + wc.id); } catch {} });
  wc.on('did-finish-load', () => { if (isGateway(wc.getURL()) && loading) { loading = false; note('load-finished'); } });
  wc.on('did-fail-load', (_ev, code, desc, url, isMain) => { if (isMain && isGateway(url) && loading) { loading = false; note('load-failed', code + ' ' + desc); } });
});

const GW_ID = 'pairing-recovery';
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ gateways: [{ id: GW_ID, label: 'pairing recovery', url: GATEWAY + '/chat' }], activeGatewayId: GW_ID }, null, 2));
app.whenReady().then(() => { secrets.set(GW_ID, { token: TOKEN }); note('seeded', path.basename(TMP) + ', ' + KBPS + ' kbps, ' + LATENCY_MS + ' ms'); });
await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  if (!SHOTS) return;
  for (const wc of webContents.getAllWebContents().filter((w) => !w.isDestroyed())) {
    try {
      const img = await wc.capturePage();
      if (!img.isEmpty()) fs.writeFileSync(path.join(SHOTS, name + '-' + wc.id + '.png'), img.toPNG());
    } catch { /* a view mid-teardown has nothing to capture */ }
  }
}

app.whenReady().then(() => delay(500)).then(async () => {
  let ok = true;
  const deadline = Date.now() + BOUND_MS;
  while (Date.now() < deadline && !events.some((e) => e.kind === 'cleared')) {
    if (events.filter((e) => e.kind === 'refused').length === 1 && !events.some((e) => e.kind === 'shot')) { await delay(1000); await shot('01-pairing-screen'); events.push({ kind: 'shot' }); }
    await delay(500);
  }
  const clearedAt = Date.now();
  await delay(AFTER_MS);
  await shot('02-end');
  const count = (k) => events.filter((e) => e.kind === k).length;
  const cleared = events.find((e) => e.kind === 'cleared');
  const firstRefusal = events.find((e) => e.kind === 'refused');
  const afterClear = (k) => events.filter((e) => e.kind === k && e.t > clearedAt).length;
  const summary = { loadsAfterClear: afterClear('load-start'), retryBeatsAfterClear: afterClear('retry-beat'), refusalsAfterClear: afterClear('refused'), refusals: count('refused'), retryBeats: count('retry-beat'), loadsStarted: count('load-start'), loadsFinished: count('load-finished'), loadsReplacedBeforeFinishing: replacedLoads, clearedAfterMs: cleared && firstRefusal ? cleared.t - firstRefusal.t : null };
  note('summary', JSON.stringify(summary));
  const check = (name, pass, detail) => { note('CHECK ' + (pass ? 'PASS' : 'FAIL'), name + (detail ? ' :: ' + detail : '')); ok = ok && pass; };
  check('the device saw a pairing refusal', count('refused') >= 1, null);
  check('the pairing screen came down after the approval within ' + BOUND_MS + 'ms', Boolean(cleared), String(summary.clearedAfterMs));
  check('no retry replaced a page load that had not finished', replacedLoads === 0, String(replacedLoads));
  check('nothing reloaded the page in the ' + AFTER_MS + 'ms after the screen came down', cleared && summary.loadsAfterClear === 0 && summary.retryBeatsAfterClear === 0, JSON.stringify({ loads: summary.loadsAfterClear, beats: summary.retryBeatsAfterClear }));
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'pairing-recovery.json'), JSON.stringify({ summary, events }, null, 2));
  note(ok ? 'RESULT PASS' : 'RESULT FAIL');
  app.exit(ok ? 0 : 1);
});
