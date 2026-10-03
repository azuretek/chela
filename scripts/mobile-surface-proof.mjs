#!/usr/bin/env node
// Build before boot, then measure real touches, colour, dim and blur sequentially.
// Usage: node scripts/mobile-surface-proof.mjs --out DIR --device UDID
//   --quiet-gate PATH [--deadline-seconds 6300] --apply
// DIR must not exist. all.state is published only after terminal cleanup.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function proof(args) {
  const value = name => args[args.indexOf(name) + 1];
  for (const key of ['--out', '--device', '--quiet-gate']) {
    if (!args.includes(key) || !value(key) || value(key).startsWith('--')) throw Error('missing ' + key);
  }
  const out = path.resolve(value('--out'));
  const device = value('--device');
  const gate = path.resolve(value('--quiet-gate'));
  const seconds = args.includes('--deadline-seconds') ? Number(value('--deadline-seconds')) : 6300;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 6300) throw Error('deadline must be 1..6300 seconds');
  if (existsSync(out)) throw Error('refusing existing output directory: ' + out);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ root, out, device, gate, seconds, order: ['quiet', 'build-for-testing', 'quiet', 'light', 'shutdown', 'quiet', 'dark', 'shutdown', 'terminal marker'] }));
    return;
  }
  if (process.platform !== 'darwin') throw Error('requires macOS');
  const devices = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8', timeout: 30000 });
  if (devices.status !== 0) throw Error('cannot inspect simulator');
  const own = Object.values(JSON.parse(devices.stdout).devices).flat().find(d => d.udid === device);
  if (!own || own.state !== 'Shutdown') throw Error('owned simulator must exist and be Shutdown');
  mkdirSync(out);
  writeFileSync(path.join(out, 'runner.pid'), String(process.pid) + '\n');
  const end = Date.now() + seconds * 1000;
  let active;
  let server;
  let cancelled;
  let stage = 'starting';
  let result = 'done';
  const interrupt = signal => { cancelled = signal; if (active) process.kill(-active.pid, 'SIGTERM'); };
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  async function run(command, argv, label, env = {}, cleanup = false) {
    if (cancelled && !cleanup) throw Error('interrupted ' + cancelled);
    const remaining = cleanup ? 45000 : Math.min(1800000, end - Date.now());
    if (remaining <= 0) throw Error('total deadline exceeded');
    stage = label;
    console.log('START ' + label + ': ' + command + ' ' + argv.join(' '));
    const tee = spawn('tee', [path.join(out, label + '.log')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const teeDone = new Promise((resolve, reject) => { tee.on('error', reject); tee.on('close', code => code === 0 ? resolve() : reject(Error('tee exit ' + code))); });
    const child = spawn(command, argv, { cwd: path.join(root, 'mobile'), env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    child.stdout.pipe(tee.stdin, { end: false }); child.stderr.pipe(tee.stdin, { end: false });
    let expired = false;
    let force;
    const timer = setTimeout(() => {
      expired = true; process.kill(-child.pid, 'SIGTERM');
      force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    }, remaining);
    let code;
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { clearTimeout(timer); clearTimeout(force); active = undefined; tee.stdin.end(); await teeDone; }
    if (code !== 0 || expired) throw Error(label + (expired ? ' deadline exceeded' : ' exit ' + code));
    console.log('END ' + label);
  }
  const quiet = label => run(gate, ['--no-booted-sims', '--timeout', String(Math.max(1, Math.min(1200, Math.floor((end - Date.now()) / 1000))))], label);
  const shutdown = label => run('xcrun', ['simctl', 'shutdown', device], label, {}, true);
  let bootAttempted = false;
  try {
    await quiet('quiet-build');
    await run('xcodegen', ['generate'], 'generate');
    const common = ['-project', 'Chela.xcodeproj', '-scheme', 'Chela', '-derivedDataPath', path.join(out, 'derived-data')];
    await run('nice', ['-n', '10', 'xcodebuild', 'build-for-testing', ...common, '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator'], 'build');
    server = createServer((req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname;
      if (!['/sheet-band.html', '/surface-backdrop.html'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end(readFileSync(path.join(root, 'mobile/ChelaUITests/Fixtures', name.slice(1))));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const appearance of ['light', 'dark']) {
      await quiet('quiet-' + appearance);
      bootAttempted = true;
      await run('xcrun', ['simctl', 'boot', device], 'boot-' + appearance);
      await run('xcrun', ['simctl', 'bootstatus', device, '-b'], 'bootstatus-' + appearance);
      await run('xcrun', ['simctl', 'ui', device, 'appearance', appearance], 'appearance-' + appearance);
      const shots = path.join(out, appearance + '-shots'); mkdirSync(shots);
      await run('nice', ['-n', '10', 'xcodebuild', 'test-without-building', ...common, '-destination', 'id=' + device,
        '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
        '-resultBundlePath', path.join(out, appearance + '.xcresult'), '-collect-test-diagnostics', 'never',
        '-only-testing:ChelaUITests/SheetBandUITests', '-only-testing:ChelaUITests/SurfacesHandoffUITests'], 'test-' + appearance, {
          TEST_RUNNER_CLAW_SHEET_BAND_FIXTURE: base + '/sheet-band.html',
          TEST_RUNNER_CLAW_SHEET_BAND_APPEARANCE: appearance,
          TEST_RUNNER_CLAW_SHEET_BAND_SHOTS: shots,
          TEST_RUNNER_CLAW_SURFACE_FIXTURE: base + '/surface-backdrop.html',
          TEST_RUNNER_CLAW_SURFACE_SHOTS: shots,
        });
      await shutdown('shutdown-' + appearance); bootAttempted = false;
    }
  } catch (error) { result = 'failed: ' + stage + ': ' + error.message; process.exitCode = 1; }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (bootAttempted) {
      try { await shutdown('shutdown-final'); }
      catch (error) { result = 'failed: cleanup: ' + error.message + '; ' + result; process.exitCode = 1; }
    }
    const state = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8', timeout: 30000 });
    let stopped = false;
    try { stopped = state.status === 0 && Object.values(JSON.parse(state.stdout).devices).flat().find(d => d.udid === device)?.state === 'Shutdown'; }
    catch (error) { console.error('cleanup inspection: ' + error.message); }
    if (!stopped) { result = 'failed: owned simulator shutdown unverified; ' + result; process.exitCode = 1; }
    console.log('TERMINAL ' + result);
    writeFileSync(path.join(out, 'all.state.tmp'), result + '\n');
    renameSync(path.join(out, 'all.state.tmp'), path.join(out, 'all.state'));
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  proof(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
