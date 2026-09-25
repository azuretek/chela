// Approves pairing requests from test clients only, for a bounded time, and logs
// every device it approved so the run can remove them afterwards.
//
//   node scripts/repro/approve-test-devices.mjs --ip 100.64.0.10 --minutes 30 --log approved.txt
//   node scripts/repro/approve-test-devices.mjs --remove --log approved.txt [--apply]
//
// Runs where the openclaw CLI reaches the gateway. A request is approved only if
// it comes from --ip AND its client id is one of --clients (default: the
// Control UI and the iOS app). Anything else is left pending and logged as
// skipped. --remove reads the log and removes each approved device that is
// still paired from that same address; it is a dry run unless --apply is given.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const IP = arg('--ip', null);
const LOG = arg('--log', 'approved-test-devices.txt');
const CLIENTS = new Set(String(arg('--clients', 'openclaw-control-ui,openclaw-ios')).split(','));
const MINUTES = Number(arg('--minutes', 30));
const cli = (args) => execFileSync('openclaw', args, { encoding: 'utf8', timeout: 60000 });
const list = () => { const raw = cli(['devices', 'list', '--json']); return JSON.parse(raw.slice(raw.indexOf('{'))); };
const note = (line) => { const l = new Date().toISOString() + ' ' + line; fs.appendFileSync(LOG, l + '\n'); console.log(l); };

if (process.argv.includes('--remove')) {
  const apply = process.argv.includes('--apply');
  const ids = [...new Set((fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').map((l) => (l.match(/APPROVED device=([0-9a-f]+) ip=(\S+)/) || []).slice(1)).filter((m) => m.length))];
  const paired = new Map((list().paired || []).map((d) => [d.deviceId, d]));
  for (const [id, ip] of ids) {
    const d = paired.get(id);
    if (!d) { console.log('absent  ' + id.slice(0, 12)); continue; }
    if (d.remoteIp !== ip) { console.log('REFUSE  ' + id.slice(0, 12) + ' now seen from ' + d.remoteIp); continue; }
    if (!apply) { console.log('would remove ' + id.slice(0, 12) + ' ' + d.clientId); continue; }
    cli(['devices', 'remove', id]);
    console.log('removed ' + id.slice(0, 12));
  }
  if (apply) {
    const still = new Set((list().paired || []).map((d) => d.deviceId));
    const left = ids.filter(([id]) => still.has(id));
    console.log(left.length ? 'STILL PAIRED: ' + left.map(([id]) => id.slice(0, 12)).join(' ') : 'verified: none of the logged devices is paired');
    process.exit(left.length ? 1 : 0);
  }
  process.exit(0);
}

if (!IP) { console.error('need --ip, the address the test client connects from'); process.exit(2); }
const until = Date.now() + MINUTES * 60000;
const seen = new Set();
note('approving ' + [...CLIENTS].join(',') + ' from ' + IP + ' until ' + new Date(until).toISOString());
while (Date.now() < until) {
  let pending = [];
  try { pending = list().pending || []; } catch (e) { note('list failed: ' + e.message.split('\n')[0]); }
  for (const p of pending) {
    const req = p.requestId || p.id;
    if (!req || seen.has(req)) continue;
    seen.add(req);
    if (p.remoteIp !== IP || !CLIENTS.has(p.clientId)) { note('SKIPPED request from ' + p.remoteIp + ' client=' + p.clientId); continue; }
    try { cli(['devices', 'approve', req]); note('APPROVED device=' + p.deviceId + ' ip=' + p.remoteIp + ' client=' + p.clientId + ' platform=' + p.platform); }
    catch (e) { note('approve failed for ' + String(p.deviceId).slice(0, 12) + ': ' + e.message.split('\n')[0]); }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
note('bound reached, stopping');
