#!/usr/bin/env node
// Local device-pairing driver for the iOS simulator test harness.
//
// Why this exists: the sim test seeds a REVOCABLE setup-code (bootstrap) token
// and drives the app through the real pairing handshake, which needs the pending
// request approved and then the device revoked afterward. The
// "openclaw devices approve|revoke" CLI does that over an operator connection to
// the running gateway, which on this fleet authenticates with the shared,
// tier-one gateway token. This harness must NOT touch that token: approving and
// removing a device-pairing entry are local state-DB writes, exactly what the
// device-pair extension's own library functions do, so this calls those
// directly. No gateway connection, no shared token. The gateway re-reads the
// pairing store on every connect (getPairedDevice per connect in the message
// handler), so an approval written here is seen on the app's next reconnect beat
// and a removal likewise drops it.
//
//   pair-local.mjs list-json                 print {pending:[],paired:[]} as JSON
//   pair-local.mjs approve-latest            approve the most recent pending request, print its deviceId+publicKey
//   pair-local.mjs remove-by-pubkey <pk>     remove the paired device whose publicKey is exactly <pk>
//
// SAFETY: removal is only ever by an EXACT publicKey the caller pins from the
// device this run created. A match by clientId or platform would risk the
// household's real iPhone, which shares clientId "openclaw-ios"; a public key is
// unique to the keypair the simulator minted on this fresh install.

const DIST = process.env.OPENCLAW_DIST || '/opt/homebrew/lib/node_modules/openclaw/dist';
const api = await import(DIST + '/extensions/device-pair/api.js');
const pairing = await import(DIST + '/device-pairing-CBKFSata.mjs');

function byName(mod, name) {
  for (const v of Object.values(mod)) if (typeof v === 'function' && v.name === name) return v;
  return undefined;
}
const removePairedDevice = byName(pairing, 'removePairedDevice');

const cmd = process.argv[2];
try {
  if (cmd === 'list-json') {
    const state = await api.listDevicePairing();
    process.stdout.write(JSON.stringify(state) + '\n');
  } else if (cmd === 'approve-latest') {
    const state = await api.listDevicePairing();
    const pending = Array.isArray(state.pending) ? state.pending : [];
    if (pending.length === 0) { console.error('no pending pairing requests'); process.exit(3); }
    let latest = pending[0];
    for (const p of pending) if ((p.ts ?? 0) > (latest.ts ?? 0)) latest = p;
    const approved = await api.approveDevicePairing(latest.requestId);
    if (!approved) { console.error('approve returned nothing (request vanished)'); process.exit(1); }
    if (approved.status === 'forbidden') {
      console.error('approve forbidden: needs ' + (approved.scope ?? approved.role ?? 'more scope'));
      process.exit(1);
    }
    const dev = approved.device ?? {};
    process.stdout.write(JSON.stringify({
      approved: true,
      requestId: latest.requestId,
      deviceId: dev.deviceId ?? latest.deviceId,
      publicKey: dev.publicKey ?? latest.publicKey
    }) + '\n');
  } else if (cmd === 'remove-by-pubkey') {
    const pk = process.argv[3];
    if (!pk) { console.error('usage: pair-local.mjs remove-by-pubkey <publicKey>'); process.exit(2); }
    if (!removePairedDevice) { console.error('removePairedDevice not found in module'); process.exit(1); }
    const state = await api.listDevicePairing();
    const paired = Array.isArray(state.paired) ? state.paired : [];
    const match = paired.find(d => d.publicKey === pk);
    if (!match) { console.error('no paired device with that exact publicKey; nothing removed'); process.exit(3); }
    const result = await removePairedDevice(match.deviceId);
    // Verify the destination: re-read and confirm the entry is gone.
    const after = await api.listDevicePairing();
    const stillThere = (after.paired ?? []).some(d => d.publicKey === pk);
    process.stdout.write(JSON.stringify({
      removed: !stillThere,
      deviceId: match.deviceId,
      publicKey: pk
    }) + '\n');
    if (stillThere) process.exit(1);
  } else {
    console.error('usage: pair-local.mjs {list-json|approve-latest|remove-by-pubkey <pk>}');
    process.exit(2);
  }
} catch (e) {
  console.error('pair-local error:', (e && e.stack) || e);
  process.exit(1);
}
