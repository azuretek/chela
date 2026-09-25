// Reads the gateway's own record of a queued-send repro session and checks that
// each marker reached it exactly once as a user turn, with nothing pending and a
// reply last.
//
//   node scripts/repro/gateway-record.mjs <sessionKey> <run>
//
// Runs where the openclaw CLI reaches the gateway. The markers are the ones the
// repro harnesses send: QLONGRUN<run>, QB<run> and QC<run>.
import { execFileSync } from 'node:child_process';

const [sessionKey, run] = process.argv.slice(2);
if (!sessionKey || !run) { console.error('usage: gateway-record.mjs <sessionKey> <run>'); process.exit(2); }
const raw = execFileSync('openclaw', ['gateway', 'call', 'chat.history', '--json', '--timeout', '30000', '--params', JSON.stringify({ sessionKey, limit: 1000 })], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const h = JSON.parse(raw.slice(raw.indexOf('{')));
const textOf = (m) => { const c = m && (m.content !== undefined ? m.content : m.text); if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join(' '); return ''; };
const msgs = h.messages || [];
let ok = true;
for (const [k, marker] of Object.entries({ A: 'QLONGRUN' + run, B: 'QB' + run, C: 'QC' + run })) {
  const user = msgs.filter((m) => m.role === 'user' && textOf(m).includes(marker)).length;
  const pending = ((h.pendingInputs && h.pendingInputs.items) || []).filter((i) => JSON.stringify(i).includes(marker)).length;
  const pass = user === 1 && pending === 0;
  ok = ok && pass;
  console.log((pass ? 'PASS' : 'FAIL') + ' message ' + k + ' reached the gateway exactly once: user=' + user + ' pending=' + pending);
}
const last = msgs.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-1)[0];
const idle = !(h.sessionInfo && (h.sessionInfo.hasActiveRun === true || h.sessionInfo.status === 'running'));
const tail = Boolean(last && last.role === 'assistant' && idle);
ok = ok && tail;
console.log((tail ? 'PASS' : 'FAIL') + ' the session is idle with a reply after the last message');
console.log(ok ? 'RECORD PASS' : 'RECORD FAIL');
process.exit(ok ? 0 : 1);
