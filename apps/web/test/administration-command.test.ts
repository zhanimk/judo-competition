import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  administrationPath,
  clearAdministrationPending,
  deliverAdministrationPending,
  readAdministrationPending,
  saveAdministrationPending,
  type AdministrationPending,
} from '../src/features/tournaments/administration-command.ts';
function fixture(): AdministrationPending {
  return {
    scope: 'new',
    operation: 'CREATE',
    payload: {
      id: randomUUID(),
      name: 'QA',
      city: 'QA',
      venue: 'QA',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 2,
    },
  };
}
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
test('lost creation response restores the reviewed request and never creates another tournament on retry', async () => {
  const value = fixture(),
    store = memory(),
    receipts = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const sent: unknown[] = [];
  const send = async (path: string, payload: AdministrationPending['payload']) => {
    assert.equal(path, '/tournaments');
    sent.push(structuredClone(payload));
    if (!receipts.has(payload.id)) {
      receipts.set(payload.id, { id: randomUUID(), administrationRevision: 0 });
      writes++;
      throw new TypeError('lost answer');
    }
    return receipts.get(payload.id)!;
  };
  saveAdministrationPending(store, value);
  assert.equal((await deliverAdministrationPending(value, send)).kind, 'retry');
  const restored = readAdministrationPending(store, 'new')!;
  assert.deepEqual(restored, value);
  assert.equal((await deliverAdministrationPending(restored, send)).kind, 'success');
  assert.equal(writes, 1);
  assert.deepEqual(sent, [value.payload, value.payload]);
  clearAdministrationPending(store, restored);
  assert.equal(readAdministrationPending(store, 'new'), null);
});
test('pending administrative command cannot be replaced or cleared by a new ID or revision', () => {
  const store = memory(),
    value: AdministrationPending = {
      scope: randomUUID(),
      operation: 'START',
      payload: { id: randomUUID(), expectedRevision: 4 },
    };
  saveAdministrationPending(store, value);
  for (const payload of [
    { ...value.payload, id: randomUUID() },
    { ...value.payload, expectedRevision: 5 },
  ]) {
    assert.throws(() => saveAdministrationPending(store, { ...value, payload }), /PENDING_EXISTS/);
    assert.throws(() => clearAdministrationPending(store, { ...value, payload }), /PENDING_EXISTS/);
  }
});
test('stored paths are derived only from a valid tournament and a known operation', () => {
  const value = fixture(),
    store = memory();
  for (const change of [
    { operation: 'DELETE_DATABASE' },
    { scope: randomUUID() },
    { payload: { id: 'invalid' } },
  ]) {
    store.setItem('judo.administration.pending.new', JSON.stringify({ ...value, ...change }));
    assert.throws(() => readAdministrationPending(store, 'new'), /PENDING_CORRUPT/);
  }
  const category: AdministrationPending = {
    scope: randomUUID(),
    operation: 'CATEGORY',
    payload: { id: randomUUID(), expectedRevision: 0 },
  };
  assert.equal(administrationPath(category), `/tournaments/${category.scope}/categories`);
});
test('unacknowledged administrative replies retain the exact command', async () => {
  const value: AdministrationPending = {
    scope: randomUUID(),
    operation: 'START',
    payload: { id: randomUUID(), expectedRevision: 2 },
  };
  for (const receipt of [
    { administrationRevision: 2, status: 'RUNNING' },
    { administrationRevision: 3, status: 'DRAFT' },
    { status: 'RUNNING' },
  ])
    assert.equal((await deliverAdministrationPending(value, async () => receipt)).kind, 'retry');
  for (const [status, kind] of [
    [409, 'rejected'],
    [401, 'retry'],
    [403, 'retry'],
    [408, 'retry'],
    [429, 'retry'],
    [503, 'retry'],
  ] as const)
    assert.equal(
      (
        await deliverAdministrationPending(value, async () => {
          throw new ApiError('QA', status);
        })
      ).kind,
      kind,
    );
});
