import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readPendingWithdrawal,
  savePendingWithdrawal,
  clearPendingWithdrawal,
  deliverPendingWithdrawal,
  type PendingWithdrawal,
} from '../src/features/draws/pending-withdrawal.ts';
const fixture = (): PendingWithdrawal => ({
  tournamentId: randomUUID(),
  categoryId: randomUUID(),
  drawId: randomUUID(),
  payload: {
    id: randomUUID(),
    entryId: randomUUID(),
    expectedVersion: 3,
    impactToken: 'a'.repeat(64),
    reason: 'Удалить из следующих встреч',
  },
});
function store() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
test('a withdrawal with a lost response retains its original ID, target and reviewed version across reload', async () => {
  const pending = fixture(),
    storage = store(),
    sent: unknown[] = [];
  savePendingWithdrawal(storage, pending);
  const first = await deliverPendingWithdrawal(pending, async (_id, dto) => {
    sent.push(dto);
    throw new TypeError('response lost');
  });
  assert.equal(first.kind, 'retry');
  const restored = readPendingWithdrawal(storage, pending.tournamentId)!;
  const response = {
    drawId: pending.drawId,
    version: 4,
    entryId: pending.payload.entryId,
    changedContestIds: [],
  };
  assert.equal(
    (
      await deliverPendingWithdrawal(restored, async (_id, dto) => {
        sent.push(dto);
        return response;
      })
    ).kind,
    'success',
  );
  assert.deepEqual(sent, [pending.payload, pending.payload]);
  clearPendingWithdrawal(storage, restored);
  assert.equal(readPendingWithdrawal(storage, pending.tournamentId), null);
});
test('unknown withdrawal cannot be replaced or cleared by a different command and corruption fails closed', () => {
  const pending = fixture(),
    storage = store();
  savePendingWithdrawal(storage, pending);
  const changed = { ...pending, payload: { ...pending.payload, id: randomUUID() } };
  assert.throws(() => savePendingWithdrawal(storage, changed), /EXISTS/);
  assert.throws(() => clearPendingWithdrawal(storage, changed), /EXISTS/);
  storage.setItem(
    `judo.withdrawal.pending.${pending.tournamentId}`,
    JSON.stringify({ ...pending, payload: { ...pending.payload, entryId: 'wrong' } }),
  );
  assert.throws(() => readPendingWithdrawal(storage, pending.tournamentId), /CORRUPT/);
});
test('a receipt for another athlete cannot acknowledge a withdrawal', async () => {
  const pending = fixture();
  const result = await deliverPendingWithdrawal(pending, async () => ({
    drawId: pending.drawId,
    version: 4,
    entryId: randomUUID(),
    changedContestIds: [],
  }));
  assert.equal(result.kind, 'retry');
});
