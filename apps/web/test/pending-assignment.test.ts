import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  clearPendingAssignment,
  deliverPendingAssignment,
  mergeAssignmentReceipt,
  readPendingAssignment,
  savePendingAssignment,
  type AssignmentPayload,
  type AssignmentReceipt,
  type PendingAssignment,
} from '../src/features/draws/pending-assignment.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}
function fixture(): PendingAssignment {
  return {
    tournamentId: '10000000-0000-4000-8000-000000000001',
    categoryId: '10000000-0000-4000-8000-000000000002',
    contestId: '10000000-0000-4000-8000-000000000003',
    payload: {
      id: '10000000-0000-4000-8000-000000000004',
      expectedRevision: 7,
      tatamiId: '10000000-0000-4000-8000-000000000005',
    },
  };
}
function receipt(pending: PendingAssignment): AssignmentReceipt {
  return {
    id: pending.contestId,
    revision: 8,
    status: 'READY',
    tatamiId: pending.payload.tatamiId,
    queueOrder: 2,
    updatedAt: '2026-10-09T12:00:00.000Z',
  };
}

test('lost response after server commit restores the exact assignment and retries it once', async () => {
  const storage = memoryStorage();
  const pending = fixture();
  const sent: AssignmentPayload[] = [];
  const receipts = new Map<string, AssignmentReceipt>();
  let mutations = 0;
  const send = async (_contestId: string, payload: AssignmentPayload) => {
    sent.push(structuredClone(payload));
    if (!receipts.has(payload.id)) {
      mutations++;
      receipts.set(payload.id, receipt(pending));
      throw new TypeError('response lost after commit');
    }
    return receipts.get(payload.id)!;
  };
  savePendingAssignment(storage, pending);
  assert.equal((await deliverPendingAssignment(pending, send)).kind, 'retry');
  const restored = readPendingAssignment(storage, pending.tournamentId)!;
  assert.deepEqual(restored, pending);
  const retried = await deliverPendingAssignment(restored, send);
  assert.equal(retried.kind, 'success');
  assert.equal(mutations, 1);
  assert.deepEqual(sent, [pending.payload, pending.payload]);
  assert.equal(restored.payload.id, pending.payload.id);
  assert.equal(restored.payload.expectedRevision, 7);
  clearPendingAssignment(storage, restored);
  assert.equal(readPendingAssignment(storage, pending.tournamentId), null);
});

test('server 500/503 and invalid responses retain the pending command; a version conflict releases it', async () => {
  const storage = memoryStorage();
  const pending = fixture();
  savePendingAssignment(storage, pending);
  for (const status of [500, 503]) {
    const result = await deliverPendingAssignment(pending, async () => {
      throw new ApiError('upstream failure', status);
    });
    assert.equal(result.kind, 'retry');
    assert.deepEqual(readPendingAssignment(storage, pending.tournamentId), pending);
  }
  assert.equal(
    (await deliverPendingAssignment(pending, async () => ({ ...receipt(pending), revision: 7 })))
      .kind,
    'retry',
  );
  const conflict = await deliverPendingAssignment(pending, async () => {
    throw new ApiError('VERSION_CONFLICT', 409);
  });
  assert.equal(conflict.kind, 'rejected');
  clearPendingAssignment(storage, pending);
  const newer = {
    ...pending,
    payload: {
      ...pending.payload,
      id: '10000000-0000-4000-8000-000000000006',
      expectedRevision: 9,
    },
  };
  savePendingAssignment(storage, newer);
  assert.deepEqual(readPendingAssignment(storage, pending.tournamentId), newer);
});

test('an unresolved assignment cannot be replaced by another match, revision or command ID', () => {
  const storage = memoryStorage();
  const pending = fixture();
  savePendingAssignment(storage, pending);
  savePendingAssignment(storage, structuredClone(pending));
  for (const newer of [
    { ...pending, contestId: '10000000-0000-4000-8000-000000000006' },
    { ...pending, payload: { ...pending.payload, expectedRevision: 8 } },
    { ...pending, payload: { ...pending.payload, id: '10000000-0000-4000-8000-000000000006' } },
  ]) {
    assert.throws(() => savePendingAssignment(storage, newer), /ASSIGN_PENDING_EXISTS/);
    assert.throws(() => clearPendingAssignment(storage, newer), /ASSIGN_PENDING_EXISTS/);
    assert.deepEqual(readPendingAssignment(storage, pending.tournamentId), pending);
  }
});

test('an old READY receipt cannot undo a newer start or transfer', () => {
  const pending = fixture();
  const latest = [
    { id: pending.contestId, revision: 10, status: 'ACTIVE', tatamiId: 'another-tatami' },
  ];
  assert.equal(mergeAssignmentReceipt(latest, receipt(pending)), latest);
  const current = [{ id: pending.contestId, revision: 7, status: 'READY', tatamiId: null }];
  const updated = mergeAssignmentReceipt(current, receipt(pending));
  assert.equal(updated[0].revision, 8);
  assert.equal(updated[0].tatamiId, pending.payload.tatamiId);
  assert.equal(current[0].revision, 7);
});

test('a corrupt saved assignment blocks restoration without silently deleting evidence', () => {
  const storage = memoryStorage();
  const pending = fixture();
  savePendingAssignment(storage, pending);
  const key = storage.key(0)!;
  storage.setItem(key, '{invalid');
  assert.throws(() => readPendingAssignment(storage, pending.tournamentId));
  assert.throws(() => savePendingAssignment(storage, pending));
  assert.equal(storage.getItem(key), '{invalid');
});
