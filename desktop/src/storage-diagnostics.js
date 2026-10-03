// Runs in the page's main world. Observe native events without replacing requests,
// promises, handlers, or transaction scheduling. No stored value is inspected.
export function observeStorage(report, scope = globalThis) {
  const known = new Set(['AbortError', 'ConstraintError', 'DataCloneError', 'DataError',
    'InvalidAccessError', 'InvalidStateError', 'NotFoundError', 'NotReadableError',
    'QuotaExceededError', 'ReadOnlyError', 'SecurityError', 'TransactionInactiveError',
    'UnknownError', 'VersionError']);
  const emit = (operation, error, category = 'failure') => {
    try { report({ category, operation, name: known.has(error?.name) ? error.name : 'UnknownError' }); }
    catch { /* Diagnostics must never change the operation being observed. */ }
  };
  const wrap = (prototype, key, observe) => {
    if (!prototype || typeof prototype[key] !== 'function') return;
    const native = prototype[key];
    prototype[key] = function (...args) {
      let result;
      try { result = Reflect.apply(native, this, args); }
      catch (error) { emit(key, error); throw error; }
      try { observe(result); } catch { /* Observation is best effort. */ }
      return result;
    };
  };
  wrap(scope.IDBFactory?.prototype, 'open', (request) => {
    request.addEventListener('error', () => emit('open', request.error));
    request.addEventListener('blocked', () => emit('open', null, 'blocked'));
  });
  wrap(scope.IDBDatabase?.prototype, 'transaction', (transaction) => {
    transaction.addEventListener('abort', () => emit('transaction', transaction.error));
  });
  for (const operation of ['put', 'add', 'delete', 'clear', 'get', 'getAll']) {
    wrap(scope.IDBObjectStore?.prototype, operation, (request) => {
      request.addEventListener('error', () => emit(operation, request.error));
    });
  }
}

export function storageDiagnosticScript() {
  return '(' + observeStorage.toString() + ')((entry) => window.__chelaStorageReport(entry));';
}

// Treat the remote page as untrusted even though the observer emits only enums.
export function sanitizeStorageDiagnostic(value) {
  const operations = ['open', 'transaction', 'put', 'add', 'delete', 'clear', 'get', 'getAll'];
  const names = ['AbortError', 'ConstraintError', 'DataCloneError', 'DataError',
    'InvalidAccessError', 'InvalidStateError', 'NotFoundError', 'NotReadableError',
    'QuotaExceededError', 'ReadOnlyError', 'SecurityError', 'TransactionInactiveError',
    'UnknownError', 'VersionError'];
  if (!value || !operations.includes(value.operation) || !names.includes(value.name)
      || !['failure', 'blocked'].includes(value.category)) return null;
  return { category: value.category, operation: value.operation, name: value.name };
}
