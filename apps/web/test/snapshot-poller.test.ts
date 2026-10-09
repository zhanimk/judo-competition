import assert from 'node:assert/strict';
import test from 'node:test';
import { pollSnapshots } from '../src/shared/live/snapshot-poller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('burst notifications coalesce and serialized responses update in order', async (t) => {
  const first = deferred<number>(),
    second = deferred<number>();
  const values: number[] = [];
  let reads = 0;
  const poller = pollSnapshots(
    () => (++reads === 1 ? first.promise : second.promise),
    (value) => values.push(value),
    (error) => assert.fail(String(error)),
    60000,
  );
  t.after(() => poller.stop());
  const running = poller.refresh();
  const notices = [poller.refresh(), poller.refresh(), poller.refresh()];
  assert.equal(reads, 1, 'only one read can be in flight');
  first.resolve(1);
  await Promise.resolve();
  assert.equal(reads, 2, 'one trailing authoritative read follows the burst');
  assert.deepEqual(values, [1], 'a completed snapshot stays visible while its refresh is pending');
  second.resolve(2);
  await Promise.all([running, ...notices]);
  assert.deepEqual(values, [1, 2]);
  assert.equal(reads, 2);
});

test('continuous notifications during every read still display every completed snapshot', async (t) => {
  const reads = Array.from({ length: 6 }, () => deferred<number>());
  const values: number[] = [];
  let index = 0;
  const poller = pollSnapshots(
    () => reads[index++].promise,
    (value) => values.push(value),
    (error) => assert.fail(String(error)),
    60000,
  );
  t.after(() => poller.stop());
  const running = poller.refresh();
  for (let i = 0; i < 5; i++) {
    void poller.refresh();
    reads[i].resolve(i);
    await Promise.resolve();
    assert.deepEqual(
      values,
      Array.from({ length: i + 1 }, (_, n) => n),
    );
  }
  reads[5].resolve(5);
  await running;
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5]);
});

test('stopping a poller prevents a delayed response from another tournament being displayed', async () => {
  const read = deferred<string>();
  const values: string[] = [];
  const poller = pollSnapshots(
    () => read.promise,
    (v) => values.push(v),
    () => {},
    60000,
  );
  const running = poller.refresh();
  poller.stop();
  read.resolve('previous tournament');
  await running;
  await poller.refresh();
  assert.deepEqual(values, []);
});

test('a failed read reports loss of connection and the next successful read recovers', async (t) => {
  const values: string[] = [],
    errors: unknown[] = [];
  let reads = 0;
  const poller = pollSnapshots(
    async () => {
      if (++reads === 1) throw new Error('offline');
      return 'fresh';
    },
    (v) => values.push(v),
    (e) => errors.push(e),
    60000,
  );
  t.after(() => poller.stop());
  await poller.refresh();
  await poller.refresh();
  assert.equal(errors.length, 1);
  assert.deepEqual(values, ['fresh']);
});
