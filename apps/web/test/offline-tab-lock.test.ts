import assert from 'node:assert/strict';
import test from 'node:test';
import { startJournalTabLock } from '../src/features/offline/tab-lock.ts';
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function browserLocks() {
  const held = new Set<string>(),
    requests: string[] = [];
  return {
    held,
    requests,
    request: async (
      name: string,
      _options: { ifAvailable: true },
      callback: (lock: unknown) => Promise<void>,
    ) => {
      requests.push(name);
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
test('Strict Mode setup-cleanup-setup requests one lock without a false second-tab error', async () => {
  const locks = browserLocks(),
    acquired: string[] = [],
    unavailable: string[] = [];
  const callbacks = (name: string) => ({
    acquired: async () => {
      acquired.push(name);
    },
    unavailable: () => {
      unavailable.push(name);
    },
    released: () => {},
    failed: (e: unknown) => {
      throw e;
    },
  });
  const stale = startJournalTabLock(locks, 'mat', callbacks('stale'));
  stale.cancel(Promise.resolve());
  const current = startJournalTabLock(locks, 'mat', callbacks('current'), stale.done);
  await flush();
  assert.deepEqual(locks.requests, ['mat']);
  assert.deepEqual(acquired, ['current']);
  assert.deepEqual(unavailable, []);
  current.cancel(Promise.resolve());
  await current.done;
  assert.equal(locks.held.size, 0);
});
test('replacement waits for cancelled restoration and already-started writes, without applying stale state', async () => {
  const locks = browserLocks(),
    read = deferred(),
    write = deferred(),
    events: string[] = [];
  const old = startJournalTabLock(locks, 'mat', {
    acquired: async (active) => {
      events.push('old-read');
      await read.promise;
      if (active()) events.push('old-restored');
    },
    unavailable: () => {
      events.push('old-denied');
    },
    released: () => {
      events.push('old-released');
    },
    failed: (e) => {
      throw e;
    },
  });
  await flush();
  old.cancel(write.promise);
  const replacement = startJournalTabLock(
    locks,
    'mat',
    {
      acquired: async () => {
        events.push('new-restored');
      },
      unavailable: () => {
        events.push('new-denied');
      },
      released: () => {},
      failed: (e) => {
        throw e;
      },
    },
    old.done,
  );
  await flush();
  assert.deepEqual(locks.requests, ['mat']);
  read.resolve();
  await flush();
  assert.equal(events.includes('old-restored'), false);
  assert.equal(events.includes('new-restored'), false, 'writes still hold the old browser lock');
  write.resolve();
  await flush();
  assert.deepEqual(events, ['old-read', 'old-released', 'new-restored']);
  assert.equal(events.includes('new-denied'), false);
  replacement.cancel(Promise.resolve());
  await replacement.done;
});
test('a real second tab stays read-only while the first tab restores or owns its journal', async () => {
  const locks = browserLocks(),
    read = deferred();
  let restored = false,
    secondAcquired = false,
    denied = false;
  const first = startJournalTabLock(locks, 'mat', {
    acquired: async () => {
      await read.promise;
      restored = true;
    },
    unavailable: () => {},
    released: () => {},
    failed: (e) => {
      throw e;
    },
  });
  await flush();
  assert.equal(restored, false);
  const second = startJournalTabLock(locks, 'mat', {
    acquired: async () => {
      secondAcquired = true;
    },
    unavailable: () => {
      denied = true;
    },
    released: () => {},
    failed: (e) => {
      throw e;
    },
  });
  await second.done;
  assert.equal(denied, true);
  assert.equal(secondAcquired, false);
  read.resolve();
  await flush();
  assert.equal(restored, true);
  assert.equal(locks.held.has('mat'), true);
  first.cancel(Promise.resolve());
  await first.done;
  assert.equal(locks.held.size, 0);
});
