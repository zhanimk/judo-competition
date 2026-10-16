import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJournal, writeJournal } from '../src/features/offline/storage.ts';

/** Model the browser's request-success -> transaction-abort failure boundary. */
function databaseFixture() {
  const requests: { result?: unknown; onsuccess?: () => void; onerror?: () => void }[] = [];
  const transactions: {
    oncomplete?: () => void;
    onabort?: () => void;
    onerror?: () => void;
    error: Error | null;
    objectStore: () => unknown;
  }[] = [];
  const options: unknown[] = [];
  let closed = 0;
  const indexed = {
    open: () => {
      const request = {
        result: {
          close: () => {
            closed++;
          },
          transaction: (...args: unknown[]) => {
            options.push(args);
            const read: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
            const tx = {
              error: null as Error | null,
              objectStore: () => ({ get: () => read, put: () => {}, delete: () => {} }),
            };
            requests.push(read);
            transactions.push(tx);
            return tx;
          },
        },
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  return { indexed, requests, transactions, options, closed: () => closed };
}
test('a read request that succeeds before its transaction aborts cannot restore an uncommitted journal', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
    f = databaseFixture();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: f.indexed });
  try {
    let settled = false;
    const pending = readJournal('active:QA');
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    f.requests[0].result = { saved: true };
    f.requests[0].onsuccess?.();
    await Promise.resolve();
    assert.equal(settled, false);
    f.transactions[0].error = new Error('disk read aborted');
    f.transactions[0].onabort?.();
    await assert.rejects(pending, /disk read aborted/);
    assert.equal(f.closed(), 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
test('a saved command is acknowledged only after a strict write transaction commits, with abort propagated', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
    f = databaseFixture();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: f.indexed });
  try {
    let done = false;
    const pending = writeJournal('active:QA', { command: 'score' });
    void pending.then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.options[0], ['journals', 'readwrite', { durability: 'strict' }]);
    assert.equal(done, false);
    f.transactions[0].oncomplete?.();
    await pending;
    assert.equal(done, true);
    const aborted = writeJournal('active:QA', { command: 'next score' });
    const checked = assert.rejects(aborted, /OFFLINE_WRITE_ABORTED/);
    await new Promise((resolve) => setImmediate(resolve));
    f.transactions[1].onabort?.();
    await checked;
    assert.equal(f.closed(), 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
