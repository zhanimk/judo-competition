import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  clearPendingDraw,
  deliverPendingDraw,
  readPendingDraw,
  savePendingDraw,
  type PendingDraw,
} from '../src/features/draws/pending-draw.ts';
function memory() {
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
function fixture(): PendingDraw {
  return {
    tournamentId: randomUUID(),
    categoryId: randomUUID(),
    operation: 'preview',
    payload: { id: randomUUID(), expectedVersion: 0 },
  };
}
const receipt = (command: PendingDraw) => ({
  id: randomUUID(),
  categoryId: command.categoryId,
  version: 1,
  status: 'PREVIEW',
  publicationRevision: 0,
  publishedAt: null,
  snapshot: {},
  contests: [],
});
test('lost preview response retains the original command across reload and a retry creates one draw', async () => {
  const value = fixture(),
    store = memory(),
    response = receipt(value);
  savePendingDraw(store, value);
  const receipts = new Map<string, typeof response>();
  const sent: unknown[] = [];
  let lost = true;
  const send = async (_path: string, payload: PendingDraw['payload']) => {
    sent.push(structuredClone(payload));
    if (!receipts.has(payload.id)) receipts.set(payload.id, response);
    if (lost) {
      lost = false;
      throw new TypeError('reply lost after commit');
    }
    return receipts.get(payload.id)!;
  };
  assert.equal((await deliverPendingDraw(value, send)).kind, 'retry');
  const restored = readPendingDraw(store, value.tournamentId)!;
  assert.equal((await deliverPendingDraw(restored, send)).kind, 'success');
  assert.equal(receipts.size, 1);
  assert.deepEqual(sent, [value.payload, value.payload]);
  clearPendingDraw(store, restored);
  assert.equal(readPendingDraw(store, value.tournamentId), null);
});
test('unknown draw command cannot be replaced or removed by another action', () => {
  const value = fixture(),
    store = memory();
  savePendingDraw(store, value);
  const other = { ...value, payload: { ...value.payload, id: randomUUID() } } as PendingDraw;
  assert.throws(() => savePendingDraw(store, other), /DRAW_PENDING_EXISTS/);
  assert.throws(() => clearPendingDraw(store, other), /DRAW_PENDING_EXISTS/);
  assert.deepEqual(readPendingDraw(store, value.tournamentId), value);
});
test('restored command rejects unknown paths, foreign scope and missing versions', () => {
  const value = fixture();
  for (const change of [
    { operation: '../start' },
    { tournamentId: randomUUID() },
    { payload: { id: randomUUID() } },
    { payload: { id: randomUUID(), expectedVersion: -1 } },
  ]) {
    const store = memory();
    store.setItem(
      `judo.draw.pending.${value.tournamentId}`,
      JSON.stringify({ ...value, ...change }),
    );
    assert.throws(() => readPendingDraw(store, value.tournamentId), /DRAW_PENDING_CORRUPT/);
  }
});
test('confirm and publication validate their original receipt rather than the latest draw version', async () => {
  const value = fixture();
  const confirm: PendingDraw = {
    ...value,
    operation: 'confirm',
    payload: { id: randomUUID(), version: 1 },
  };
  const confirmed = { ...receipt(value), status: 'CONFIRMED' };
  assert.equal((await deliverPendingDraw(confirm, async () => confirmed)).kind, 'success');
  assert.equal(
    (await deliverPendingDraw(confirm, async () => ({ ...confirmed, version: 2 }))).kind,
    'retry',
  );
  const publication: PendingDraw = {
    ...value,
    operation: 'publication',
    payload: { id: randomUUID(), expectedRevision: 1, published: false },
  };
  assert.equal(
    (await deliverPendingDraw(publication, async () => ({ ...confirmed, publicationRevision: 2 })))
      .kind,
    'success',
  );
  assert.equal(
    (
      await deliverPendingDraw(publication, async () => ({
        ...confirmed,
        publicationRevision: 2,
        publishedAt: new Date().toISOString(),
      }))
    ).kind,
    'retry',
  );
});
test('only definitive rejection clears a draw intent; overload, invalid response and server failure remain unknown', async () => {
  const value = fixture();
  for (const [status, kind] of [
    [409, 'rejected'],
    [401, 'retry'],
    [403, 'retry'],
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
  ] as const)
    assert.equal(
      (
        await deliverPendingDraw(value, async () => {
          throw new ApiError('QA', status);
        })
      ).kind,
      kind,
    );
  assert.equal(
    (await deliverPendingDraw(value, async () => ({ ...receipt(value), categoryId: randomUUID() })))
      .kind,
    'retry',
  );
});
