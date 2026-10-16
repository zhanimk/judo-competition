import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  clearPendingTiebreak,
  deliverPendingTiebreak,
  readPendingTiebreak,
  savePendingTiebreak,
  type PendingTiebreak,
} from '../src/features/draws/pending-tiebreak.ts';
function fixture(): PendingTiebreak {
  return {
    tournamentId: randomUUID(),
    categoryId: randomUUID(),
    drawId: randomUUID(),
    payload: {
      id: randomUUID(),
      expectedVersion: 2,
      impactToken: 'a'.repeat(64),
      reason: 'QA: дополнительный круг',
      procedure: 'ROUND_ROBIN',
      parent: 'BASE',
      members: [randomUUID(), randomUUID(), randomUUID()],
    },
  };
}
function memory() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
}
test('additional round survives a lost response and is retried with the original reviewed payload', async () => {
  const value = fixture(),
    store = memory();
  savePendingTiebreak(store, value);
  let applied = 0;
  const receipt = {
    drawId: value.drawId,
    version: 3,
    addedContestIds: [randomUUID()],
    changedContestIds: [],
  };
  const sent: unknown[] = [];
  const send = async (_category: string, payload: unknown) => {
    sent.push(structuredClone(payload));
    if (!applied++) throw new TypeError('response lost after commit');
    return receipt;
  };
  assert.equal((await deliverPendingTiebreak(value, send)).kind, 'retry');
  const restored = readPendingTiebreak(store, value.tournamentId)!;
  assert.deepEqual(restored, value);
  assert.equal((await deliverPendingTiebreak(restored, send)).kind, 'success');
  assert.deepEqual(sent, [value.payload, value.payload]);
  clearPendingTiebreak(store, restored);
  assert.equal(readPendingTiebreak(store, value.tournamentId), null);
});
test('manual order survives reload and accepts a receipt without invented added bouts', async () => {
  const value = fixture(),
    store = memory();
  value.payload.procedure = 'ORDERED_PLACES';
  value.payload.members.reverse();
  savePendingTiebreak(store, value);
  const restored = readPendingTiebreak(store, value.tournamentId)!;
  assert.deepEqual(restored.payload.members, value.payload.members);
  const result = await deliverPendingTiebreak(restored, async (_id, payload) => {
    assert.deepEqual(payload, value.payload);
    return { drawId: value.drawId, version: 3, addedContestIds: [], changedContestIds: [] };
  });
  assert.equal(result.kind, 'success');
});

test('unknown manual command cannot be replaced, retargeted or cleared by another command', () => {
  const value = fixture(),
    store = memory();
  savePendingTiebreak(store, value);
  const other = { ...value, payload: { ...value.payload, id: randomUUID() } };
  assert.throws(() => savePendingTiebreak(store, other), /TIEBREAK_PENDING_EXISTS/);
  assert.throws(() => clearPendingTiebreak(store, other), /TIEBREAK_PENDING_EXISTS/);
  assert.deepEqual(readPendingTiebreak(store, value.tournamentId), value);
});
test('pending cohort and reviewed policy fail closed on duplicate IDs, unknown procedure and missing impact', () => {
  const value = fixture();
  for (const change of [
    { members: [value.payload.members[0], value.payload.members[0], value.payload.members[2]] },
    { procedure: 'CHOOSE_WINNER' },
    { impactToken: '' },
    { expectedVersion: 0 },
  ]) {
    const store = memory();
    store.setItem(
      `judo.tiebreak.pending.${value.tournamentId}`,
      JSON.stringify({ ...value, payload: { ...value.payload, ...change } }),
    );
    assert.throws(() => readPendingTiebreak(store, value.tournamentId), /TIEBREAK_PENDING_CORRUPT/);
  }
});
test('wrong draw, old revision and missing added bouts are unacknowledged responses', async () => {
  const value = fixture();
  for (const receipt of [
    { drawId: randomUUID(), version: 3, addedContestIds: ['one'], changedContestIds: [] },
    { drawId: value.drawId, version: 2, addedContestIds: ['one'], changedContestIds: [] },
    { drawId: value.drawId, version: 3, addedContestIds: [], changedContestIds: [] },
  ])
    assert.equal((await deliverPendingTiebreak(value, async () => receipt)).kind, 'retry');
});
test('definitive rejection permits a fresh review while overload and server errors keep the original command', async () => {
  const value = fixture();
  for (const [status, kind] of [
    [409, 'rejected'],
    [401, 'retry'],
    [403, 'retry'],
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
  ] as const)
    assert.equal(
      (
        await deliverPendingTiebreak(value, async () => {
          throw new ApiError('QA', status);
        })
      ).kind,
      kind,
    );
});
