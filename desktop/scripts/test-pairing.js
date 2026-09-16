// Prove device pairing end to end, on screen, against a real gateway.
//
// Why this exists. `npm test` proves the reducer, the parser and the wiring hold
// still; it cannot prove the observer actually RUNS in the gateway page, which is
// exactly the fault that shipped: the script was registered, the log said so, and
// the page kept a native `WebSocket` with nothing to report a refusal. A green
// suite is not evidence that a page was injected.
//
// So this runs the real app against a real gateway and asks for the screen. It
// needs a gateway it may approve and revoke devices on, which must never be a
// live one, so it refuses to run without an explicit opt-in and it refuses any
// gateway that is not the throwaway port it was pointed at:
//
//   CLAW_TEST_GATEWAY_URL=http://127.0.0.1:8799/ \
//   CLAW_TEST_GATEWAY_TOKEN=<from the throwaway gateway's own config> \
//   CLAW_TEST_ALLOW_DEVICE_REVOKE=1 \
//   npx electron scripts/test-pairing.js --user-data-dir <fresh dir> [--shots DIR]
//
// The token arrives in the ENVIRONMENT and is never argv, and it is written into
// the throwaway profile through the app's own credential store, so nothing here
// has to print it. The device commands are left to the caller, not run from here:
// this script only watches and photographs, and it says on stdout every time the
// pairing screen goes up or comes down, which is the evidence a run is judged on.
//
//   --user-data-dir  REQUIRED. An isolated Chromium profile means a fresh device
//                    identity, so the run pairs a test device and cannot touch
//                    the identity of the app the operator actually uses.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, webContents } from 'electron';

const arg = (name) => {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const GATEWAY = process.env.CLAW_TEST_GATEWAY_URL || '';
const TOKEN = process.env.CLAW_TEST_GATEWAY_TOKEN || '';
const SHOTS = arg('shots');

/** The ports a throwaway gateway may run on. Never 18789, never the live one. */
const THROWAWAY_PORTS = new Set(['8799', '8797', '8796']);
const LIVE_PORT = '18789';

/**
 * Whether an address is one a throwaway gateway may be reached on.
 *
 * Loopback is the usual case, but not the only one that matters: a gateway bound
 * to loopback is AUTO-APPROVED for a loopback Control UI client that presents a
 * device identity, so a run against 127.0.0.1 never sees a pairing request at
 * all. Reaching the same gateway over its tailnet address (100.64.0.0/10) or its
 * LAN address makes the peer a non-loopback one, which is what puts the device
 * through the approval it is being tested for. Anything public is still refused:
 * this script revokes a device, and the only gateway it may do that on is one
 * this machine is running for the test.
 */
function isThrowawayAddress(hostname) {
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function refuse(message) {
  console.error(`REFUSED: ${message}`);
  app.exit(2);
}

if (!arg('user-data-dir')) {
  refuse('pass --user-data-dir: this run needs an isolated profile with its own device identity');
}
if (!GATEWAY || !TOKEN) {
  refuse('set CLAW_TEST_GATEWAY_URL and CLAW_TEST_GATEWAY_TOKEN (a throwaway gateway, never the live one)');
}
{
  const url = new URL(GATEWAY);
  if (!isThrowawayAddress(url.hostname) || url.port === LIVE_PORT || !THROWAWAY_PORTS.has(url.port)) {
    refuse(`${GATEWAY} is not a throwaway gateway; this script pairs, approves and revokes devices and must never be pointed at a live one`);
  }
}
if (process.env.CLAW_TEST_ALLOW_DEVICE_REVOKE !== '1') {
  refuse('set CLAW_TEST_ALLOW_DEVICE_REVOKE=1 to acknowledge that the caller will revoke a device on this gateway');
}

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The profile main.js will use, pinned BOTH ways, which is what the other
// harnesses here do and for the reason dump-overlays.js records: main.js decides
// whether a run is isolated from the `--user-data-dir` SWITCH, and on a run
// without it, it migrates the real profile and calls setPath over this one. A
// harness that sets only the path therefore runs on the real profile. Measured
// the hard way on this very harness: without the switch the app read a blank
// config from Electron's default userData and sat on its first-run settings
// page, and its credential write went to that directory rather than this one.
const PROFILE = arg('user-data-dir');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'throwaway', label: 'Throwaway gateway', url: GATEWAY }],
  activeGatewayId: 'throwaway',
}, null, 2)}\n`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const overlay = (name) => live().find((wc) => wc.getURL().includes(`${name}.html`));
const gatewayPage = () => live().find((wc) => wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')));

let shotSeq = 0;
async function shoot(wc, name) {
  if (!SHOTS || !wc) return;
  shotSeq += 1;
  try {
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${String(shotSeq).padStart(2, '0')}-${name}.png`), image.toPNG());
    console.log(`SHOT ${shotSeq} ${name}.png`);
  } catch (err) {
    console.log(`SHOT ${name}: failed (${err.message})`);
  }
}

/** What is on screen right now, in the terms this run is judged on. */
async function observe() {
  const pairing = overlay('pairing');
  const state = {
    pairingScreen: Boolean(pairing),
    text: '',
    requestId: null,
    command: null,
    gatewayPageUrl: gatewayPage()?.getURL() || null,
  };
  if (pairing) {
    try {
      const read = await pairing.executeJavaScript(
        '({ text: document.body.innerText.replace(/\\s+/g, " ").trim(),'
        + ' requestId: (document.querySelector(".fact__value") || {}).textContent || null,'
        + ' command: (document.getElementById("command") || {}).textContent || null })',
      );
      state.text = read.text;
      state.requestId = read.requestId ? read.requestId.trim() : null;
      state.command = read.command ? read.command.trim() : null;
    } catch (err) {
      state.text = `<unreadable: ${err.message}>`;
    }
  }
  return state;
}

// Every change in the visible state, printed as it happens: the sequence in this
// log IS the evidence, so it is not written once at the end.
let last = null;
async function watch() {
  const now = await observe();
  const key = JSON.stringify(now);
  if (key !== last) {
    last = key;
    if (now.pairingScreen) {
      console.log(`PAIRING SCREEN UP  requestId=${now.requestId} command="${now.command}"`);
      console.log(`SCREEN TEXT: ${now.text}`);
      await shoot(overlay('pairing'), 'pairing-screen');
    } else if (now.gatewayPageUrl) {
      console.log(`PAIRING SCREEN DOWN (gateway page ${now.gatewayPageUrl})`);
      await shoot(gatewayPage(), 'gateway-page');
    }
  }
}

// A read-only view of the same state over HTTP, so a caller driving the
// approve/revoke steps can ask what is on screen between them without reading
// the log. Bound to loopback and never given the token.
const probePort = Number(arg('probe-port') || 8798);

/** Wire up the watch loop and the probe surface, once the app is up. */
async function startWatching() {
  setInterval(() => { watch().catch(() => {}); }, 500);

  http.createServer((req, res) => {
    observe().then((state) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  }).listen(probePort, '127.0.0.1', () => {
    console.log(`WATCHING ${GATEWAY} (probe on http://127.0.0.1:${probePort}/)`);
  });

  console.log(`PROFILE ${PROFILE}`);
  console.log(`HOST ${os.hostname()}`);
  await delay(1000);
  await watch();
}

// Everything after this point runs from a `then`, never from a top-level await:
// Electron defers its `ready` event until the main module has finished
// evaluating, so `await app.whenReady()` at module scope waits on a promise whose
// trigger waits on the module. Measured here, it prints nothing and hangs
// forever, which is what the first version of this harness did.
app.whenReady().then(async () => {
  // Both of these are re-asserted rather than trusted: main.js calls app.setName()
  // as it loads, and the profile path is what decides whether this run touches
  // an identity that is not its own.
  app.setPath('userData', PROFILE);
  const effective = app.getPath('userData');
  console.log(`USERDATA ${effective}`);
  if (fs.realpathSync(effective) !== fs.realpathSync(PROFILE)) {
    refuse(`this run's profile is not the one asked for (${effective}); refusing to pair a device from an unisolated profile`);
  }

  // The credential goes in through the app's own store, which is the only path
  // the app itself uses; the settings page writes the same place, write-only.
  const secrets = await import('../src/secrets.js');
  const stored = secrets.set('throwaway', { token: TOKEN });
  if (!stored.ok) refuse(`could not store the gateway credential: ${stored.error}`);

  // Imported after the profile and credentials exist, because main.js reads both
  // during startup.
  await import('../src/main.js');

  // And once more after the import, then read back through the app's own config
  // module: a run whose active gateway is not the throwaway one would otherwise
  // load a live gateway, which is the one thing this whole script must not do.
  app.setPath('userData', PROFILE);
  const configModule = await import('../src/config.js');
  configModule.setUserDataDir(PROFILE);
  const active = configModule.default.activeGateway();
  if (!active || active.url !== GATEWAY) {
    refuse(`this run's active gateway is ${active ? active.url : 'none'}, not ${GATEWAY}; a gateway this script may revoke on is the only one it may use`);
  }
  console.log(`GATEWAY (active) ${active.url}`);

  await startWatching();
});
