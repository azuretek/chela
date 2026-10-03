import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeStorage, sanitizeStorageDiagnostic } from '../src/storage-diagnostics.js';
function fixture(report) {
  const request = new EventTarget();
  const transaction = new EventTarget();
  const error = new DOMException('secret filename and image bytes', 'DataError');
  let input;
  class IDBFactory { open() { return request; } }
  class IDBDatabase { transaction() { return transaction; } }
  class IDBObjectStore {
    put(value) { input = value; return request; }
    add() { throw error; }
  }
  observeStorage(report, { IDBFactory, IDBDatabase, IDBObjectStore });
  return { request, transaction, error, factory: new IDBFactory(), db: new IDBDatabase(),
    store: new IDBObjectStore(), input: () => input };
}
test('native results, input identity, sync throws and page event handlers survive', () => {
  const records = [];
  const f = fixture((r) => records.push(r));
  const value = { get text() { throw Error('must not inspect content'); } };
  assert.equal(f.store.put(value), f.request);
  assert.equal(f.input(), value);
  assert.equal(f.factory.open(), f.request);
  assert.equal(f.db.transaction(), f.transaction);
  assert.throws(() => f.store.add(), (error) => error === f.error);
  let called = false;
  f.request.addEventListener('error', () => { called = true; });
  f.request.error = f.error;
  f.request.dispatchEvent(new Event('error'));
  f.transaction.error = f.error;
  f.transaction.dispatchEvent(new Event('abort'));
  assert.equal(called, true);
  assert.deepEqual(records.map((r) => r.operation), ['add', 'put', 'open', 'transaction']);
  assert.equal(JSON.stringify(records).includes('secret'), false);
  assert.ok(records.every((r) => r.name === 'DataError'));
});
test('reporter failure never replaces native error or request', () => {
  const f = fixture(() => { throw Error('reporter failed'); });
  assert.equal(f.store.put({}), f.request);
  assert.throws(() => f.store.add(), (error) => error === f.error);
  f.request.error = f.error;
  assert.equal(f.request.dispatchEvent(new Event('error')), true);
});
test('unknown names and arbitrary remote fields cannot leak through the host boundary', () => {
  const records = [];
  const f = fixture((r) => records.push(r));
  f.factory.open(); f.request.error = { name: 'secret filename', message: 'secret bytes' };
  f.request.dispatchEvent(new Event('error'));
  assert.deepEqual(records, [{ category: 'failure', operation: 'open', name: 'UnknownError' }]);
  assert.deepEqual(sanitizeStorageDiagnostic({ ...records[0], text: 'secret', url: 'secret' }), records[0]);
  assert.equal(sanitizeStorageDiagnostic({ ...records[0], name: 'secret' }), null);
  assert.equal(sanitizeStorageDiagnostic({ ...records[0], operation: 'secret' }), null);
});
