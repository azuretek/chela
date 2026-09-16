// Boot the real app and prove it actually runs, for one instance type.
//
// Why this exists. `npm test` runs under Node against the source tree, so it
// cannot see a fault that only appears once the app is packaged: a module the
// packer never copied, a shared file placed where the relative import does not
// point, an entry Electron refuses to load. Each of those shipped a build that
// passed 296 tests and still opened a fatal "A JavaScript error occurred in the
// main process" dialog. A green unit-test run is not evidence the app starts.
//
// This runs the thing itself and asks for a positive signal, never for the
// absence of an error. The signal is the config file main.js writes at import
// time (`config.get()` runs at top level): if it appears, every static import in
// the graph linked and evaluated, and the app got as far as its own startup. A
// process that stays alive is NOT the signal: the fatal-error dialog keeps the
// process running, which is exactly how a broken build was mistaken for a good
// one. So the check also fails on the error text and on a process that dies
// before the signal.
//
// Instances (--instance):
//   source   the app run from the working tree, the way `npm start` does
//   packed   the unpacked build in dist/, the way a user runs it (asar included)
//
//   node scripts/smoke.js --instance source
//   node scripts/smoke.js --instance packed
//   node scripts/smoke.js --instance packed --app /path/to/"Claw Control UI"
//
// Exits non-zero on the first instance that fails, so CI can gate on it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const instance = arg('instance', 'source');
const signalTimeoutMs = Number(arg('timeout', 30000));
const graceMs = Number(arg('grace', 4000));

// Text a broken main process prints. Any of these means a failed boot even if the
// process is still up, which is the trap that made a dialog look like a success.
const FAILURE_TEXT = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module/,
  /SyntaxError/,
  /A JavaScript error occurred/i,
  /threw an error during load/i,
  /No such module/i,
];

/** The Electron binary and the app argument for one instance. */
function locate() {
  const override = arg('app', null);
  if (instance === 'source') {
    const bin = path.join(DESKTOP, 'node_modules', '.bin', 'electron');
    return { bin, appArg: DESKTOP, label: 'source (working tree)' };
  }
  if (instance !== 'packed') {
    throw new Error(`unknown --instance '${instance}' (want source or packed)`);
  }
  if (override) return { bin: override, appArg: null, label: `packed (${override})` };

  const dist = path.join(DESKTOP, 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error(`no dist/ at ${dist}; run \`npm run pack\` first`);
  }
  // The unpacked build electron-builder writes, per platform.
  const candidates = [];
  for (const entry of fs.readdirSync(dist)) {
    if (/^mac/.test(entry)) candidates.push(path.join(dist, entry, 'Claw Control UI.app', 'Contents', 'MacOS', 'Claw Control UI'));
    if (entry === 'win-unpacked') candidates.push(path.join(dist, entry, 'Claw Control UI.exe'));
    if (entry === 'linux-unpacked') {
      const dir = path.join(dist, entry);
      const files = fs.readdirSync(dir).filter((f) => {
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile() || !(fs.statSync(full).mode & 0o111)) return false;
        // Electron's own helpers are executable too, so name them out rather
        // than pick whichever the directory happens to list first.
        if (/^(chrome-sandbox|chrome_crashpad_handler)$/.test(f)) return false;
        if (/\.(so|pak|bin|dat|json|html|png)$/i.test(f)) return false;
        return true;
      });
      // Prefer the file named after the app, which is what electron-builder
      // produces; fall back to whatever executable is left.
      files.sort((a, b) => Number(/claw/i.test(b)) - Number(/claw/i.test(a)));
      for (const f of files) candidates.push(path.join(dir, f));
    }
  }
  const bin = candidates.find((c) => fs.existsSync(c));
  if (!bin) throw new Error(`no runnable app found under ${dist}; run \`npm run pack\` first`);
  // A packaged app carries its own Electron, so bin IS the app.
  return { bin, appArg: null, label: `packed (${path.relative(DESKTOP, bin)})` };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const { bin, appArg, label } = locate();
  if (!fs.existsSync(bin)) throw new Error(`electron binary not found: ${bin}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-smoke-'));
  const signal = path.join(profile, 'config.json');

  // One `--user-data-dir=<path>` argument, not `--user-data-dir <path>`. Given as
  // two argv entries Electron reads the second as an app path and the switch is
  // ignored, so the app quietly uses the real profile and no signal ever appears
  // in the temp one (measured). The switch goes first so it is never mistaken
  // for the app path.
  //
  // --no-sandbox is opt-in because Chromium's setuid sandbox is unavailable in
  // most containers and on the Linux CI image, where the app aborts with SIGTRAP
  // the moment it starts. Pass it where the sandbox is not set up.
  const noSandbox = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
  const args = [`--user-data-dir=${profile}`, ...noSandbox, ...(appArg ? [appArg] : [])];
  console.log(`smoke[${instance}]: launching ${label}`);
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  let exited = null;
  child.on('exit', (code, signalName) => { exited = { code, signalName }; });

  const deadline = Date.now() + signalTimeoutMs;
  let sawSignal = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(signal)) { sawSignal = true; break; }
    if (exited) break;
    await sleep(250);
  }

  // Let it settle, so a crash just after the signal is still caught, and a
  // dialog that only appears once a window tries to load has a chance to.
  if (sawSignal) await sleep(graceMs);

  const failures = [];
  const matched = FAILURE_TEXT.filter((re) => re.test(output));

  if (!sawSignal) {
    failures.push(exited
      ? `process exited (code ${exited.code}, signal ${exited.signalName}) before writing ${path.basename(signal)}`
      : `no ${path.basename(signal)} within ${signalTimeoutMs}ms`);
  } else if (exited) {
    failures.push(`process exited after boot (code ${exited.code}, signal ${exited.signalName})`);
  }
  for (const re of matched) failures.push(`output matched ${re}`);

  if (!exited) {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  if (failures.length === 0) {
    console.log(`smoke[${instance}]: PASS (booted, wrote ${path.basename(signal)})`);
    fs.rmSync(profile, { recursive: true, force: true });
    return 0;
  }

  console.error(`smoke[${instance}]: FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  const tail = output.trim().split('\n').slice(-15).join('\n');
  if (tail) console.error(`  last output:\n${tail.replace(/^/gm, '    ')}`);
  if (process.env.CLAW_SMOKE_KEEP_PROFILE !== '1') {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return 1;
}

run().then((code) => process.exit(code)).catch((err) => {
  console.error(`smoke[${instance}]: ERROR ${err.message}`);
  process.exit(1);
});
