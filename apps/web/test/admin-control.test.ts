import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatch, MAX_CORRECTED_GOLDEN_MS, type MatchState } from '@judo/engine/match';
import {
  adminPendingKey,
  archiveAdminPending,
  clearAdminPending,
  deliverAdminPending,
  readAdminPending,
  restoreAdminPending,
  saveAdminPending,
  type PendingAdminCommand,
} from '../src/features/control/pending-command.ts';
import {
  clockEditValue,
  formatClockTenths,
  previewClockCorrection,
} from '../src/features/control/clock-edit.ts';
import { ApiError } from '../src/features/tournaments/api.ts';

const tournament = '11111111-1111-4111-8111-111111111111';
const contest = '22222222-2222-4222-8222-222222222222';
const command = '33333333-3333-4333-8333-333333333333';
const mat = '44444444-4444-4444-8444-444444444444';
const archiveId = '55555555-5555-4555-8555-555555555555';
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const pending = (): PendingAdminCommand => ({
  tournamentId: tournament,
  contestId: contest,
  payload: {
    id: command,
    expectedRevision: 14,
    impactToken: 'a'.repeat(64),
    type: 'MOVE',
    tatamiId: mat,
    reason: 'Выравнивание нагрузки',
  },
  review: {
    key: 'B4',
    category: 'U12 -38',
    white: 'Тест Белый',
    blue: 'Тест Синий',
    targetNumber: 2,
  },
});
const stopped = (): MatchState => ({
  ...createMatch({
    durationMs: 180000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['IPPON', 'WAZA_ARI', 'YUKO'],
    holdThresholds: [],
  }),
  status: 'PAUSED',
  elapsedMs: 60000,
});

test('an applied move with a lost response restores its original packet and exact retry across reload', async () => {
  const store = storage();
  const original = pending();
  saveAdminPending(store, original);
  const before = store.getItem(adminPendingKey(tournament));
  const first = await deliverAdminPending(original, async (_contest, payload) => {
    assert.equal(
      store.getItem(adminPendingKey(tournament)),
      before,
      'packet exists before transport',
    );
    payload.expectedRevision = 99; // A transport must not mutate the persisted retry command.
    throw new Error('reply lost after commit');
  });
  assert.equal(first.kind, 'retry');
  const reloaded = readAdminPending(store, tournament)!;
  assert.deepEqual(reloaded, original);
  let retryPacket: unknown;
  const retry = await deliverAdminPending(reloaded, async (id, payload) => {
    assert.equal(id, contest);
    retryPacket = payload;
    return { ok: true };
  });
  assert.equal(retry.kind, 'success');
  assert.deepEqual(retryPacket, original.payload);
  clearAdminPending(store, reloaded);
  assert.equal(readAdminPending(store, tournament), null);
});

test('an unknown correction cannot be replaced by a fresh command ID, revision or impact plan', () => {
  const store = storage(),
    original = pending();
  saveAdminPending(store, original);
  for (const changed of [
    { id: archiveId },
    { expectedRevision: 15 },
    { impactToken: 'b'.repeat(64) },
    { tatamiId: archiveId },
  ]) {
    const replacement = {
      ...original,
      payload: { ...original.payload, ...changed },
    } as PendingAdminCommand;
    assert.throws(() => saveAdminPending(store, replacement), /ADMIN_PENDING_EXISTS/);
    assert.throws(() => clearAdminPending(store, replacement), /ADMIN_PENDING_EXISTS/);
    assert.deepEqual(readAdminPending(store, tournament), original);
  }
});

test('auth loss, invalid replies and server uncertainty retain a command; version rejection is known final', async () => {
  for (const error of [
    new Error('network'),
    new ApiError('down', 503),
    new ApiError('AUTH_REQUIRED', 401),
    new ApiError('FORBIDDEN', 403),
    new ApiError('COMMAND_ID_REUSED', 409),
    new ApiError('timeout', 408),
    new ApiError('rate', 429),
  ]) {
    const result = await deliverAdminPending(pending(), async () => {
      throw error;
    });
    assert.equal(result.kind, 'retry');
  }
  assert.equal((await deliverAdminPending(pending(), async () => ({ ok: false }))).kind, 'retry');
  for (const code of ['VERSION_CONFLICT', 'IMPACT_CHANGED', 'DEPENDENT_CONTESTS_STARTED'])
    assert.equal(
      (
        await deliverAdminPending(pending(), async () => {
          throw new ApiError(code, 409);
        })
      ).kind,
      'rejected',
    );
});

test('corrupt evidence is blocked until explicit reviewed archive, preserving the original bytes', () => {
  const store = storage(),
    raw = '{broken original packet';
  store.setItem(adminPendingKey(tournament), raw);
  assert.throws(() => readAdminPending(store, tournament));
  assert.throws(() => saveAdminPending(store, pending()));
  assert.throws(
    () => archiveAdminPending(store, tournament, 'Проверил протокол', false, archiveId),
    /REVIEW_REQUIRED/,
  );
  assert.equal(store.getItem(adminPendingKey(tournament)), raw);
  archiveAdminPending(
    store,
    tournament,
    'Сверил встречу и зависимые пары',
    true,
    archiveId,
    '2026-10-10T01:00:00.000Z',
  );
  assert.equal(readAdminPending(store, tournament), null);
  const archive = JSON.parse(
    store.getItem(`judo.admin-control.archive.${tournament}.${archiveId}`)!,
  );
  assert.equal(archive.raw, raw);
  assert.equal(archive.reviewedAt, '2026-10-10T01:00:00.000Z');
});

test('archive storage failure cannot erase an unknown command', () => {
  const store = storage();
  saveAdminPending(store, pending());
  const original = store.getItem(adminPendingKey(tournament));
  assert.throws(
    () =>
      archiveAdminPending(
        {
          ...store,
          setItem: () => {
            throw new Error('quota');
          },
        },
        tournament,
        'Сверил результат',
        true,
        archiveId,
      ),
    /quota/,
  );
  assert.equal(store.getItem(adminPendingKey(tournament)), original);
});

test('saved timer packets reject extra phase-changing fields and keep the exact correction', () => {
  const original: PendingAdminCommand = {
    ...pending(),
    payload: {
      id: command,
      expectedRevision: 14,
      impactToken: 'a'.repeat(64),
      reason: 'Сверка секундомера',
      type: 'EDIT_TIME',
      phase: 'REGULAR',
      elapsedMs: 60500,
    },
  };
  assert.deepEqual(restoreAdminPending(JSON.stringify(original), tournament), original);
  for (const changed of [
    { elapsedMs: -100 },
    { elapsedMs: 60501 },
    { phase: 'UNKNOWN' },
    { durationMs: 200000 },
    { reason: '  ' },
  ])
    assert.throws(
      () =>
        restoreAdminPending(
          JSON.stringify({ ...original, payload: { ...original.payload, ...changed } }),
          tournament,
        ),
      /ADMIN_PENDING_CORRUPT/,
    );
  assert.throws(() => restoreAdminPending(JSON.stringify(original), mat), /ADMIN_PENDING_CORRUPT/);
});

test('timer receipts confirm the original contest, phase and exact time without rebinding to a new correction', async () => {
  const original: PendingAdminCommand = {
    ...pending(),
    payload: {
      id: command,
      expectedRevision: 14,
      impactToken: 'a'.repeat(64),
      reason: 'Сверка секундомера',
      type: 'EDIT_TIME',
      phase: 'GOLDEN',
      elapsedMs: 45500,
    },
  };
  const receipt = {
    ok: true,
    contestId: contest,
    revision: 15,
    controlGeneration: 8,
    state: { ...stopped(), phase: 'GOLDEN', goldenMs: 45500 },
  };
  assert.equal((await deliverAdminPending(original, async () => receipt)).kind, 'success');
  for (const changed of [
    { contestId: mat },
    { revision: 14 },
    { controlGeneration: -1 },
    { state: { ...receipt.state, goldenMs: 45400 } },
    { state: { ...receipt.state, phase: 'REGULAR' } },
  ])
    assert.equal(
      (await deliverAdminPending(original, async () => ({ ...receipt, ...changed }))).kind,
      'retry',
    );
});

test('regular input means remaining time at 100 ms precision and preserves scores and source state', () => {
  const state = stopped();
  state.awards.push({ id: command, side: 'WHITE', kind: 'YUKO', active: true, phase: 'REGULAR' });
  const original = structuredClone(state);
  const preview = previewClockCorrection(state, '01:59.5');
  assert.deepEqual(preview.correction, { phase: 'REGULAR', elapsedMs: 60500 });
  assert.equal(preview.state.status, 'PAUSED');
  assert.deepEqual(preview.state.awards, state.awards);
  assert.deepEqual(state, original);
  assert.equal(clockEditValue(preview.state), '01:59.5');
});

test('regular expiry previews winner or tie, while restoring remaining time returns a decision to pause', () => {
  const lead = stopped();
  lead.awards.push({ id: command, side: 'BLUE', kind: 'WAZA_ARI', active: true, phase: 'REGULAR' });
  const winner = previewClockCorrection(lead, '00:00.0').state;
  assert.equal(winner.status, 'PROVISIONAL');
  assert.deepEqual(winner.outcome, { winner: 'BLUE', reason: 'TIME' });
  const tie = previewClockCorrection(stopped(), '00:00.0').state;
  assert.equal(tie.status, 'DECISION');
  assert.equal(tie.outcome, null);
  assert.equal(previewClockCorrection(tie, '00:10.0').state.status, 'PAUSED');
});

test('Golden Score input means elapsed time, keeps the phase and enforces the six-hour technical bound', () => {
  const state: MatchState = { ...stopped(), phase: 'GOLDEN', elapsedMs: 180000, goldenMs: 34000 };
  const preview = previewClockCorrection(state, '00:45.5');
  assert.deepEqual(preview.correction, { phase: 'GOLDEN', elapsedMs: 45500 });
  assert.equal(preview.state.elapsedMs, 180000);
  assert.equal(preview.state.goldenMs, 45500);
  assert.equal(preview.state.status, 'PAUSED');
  assert.equal(
    previewClockCorrection(state, formatClockTenths(MAX_CORRECTED_GOLDEN_MS)).state.goldenMs,
    MAX_CORRECTED_GOLDEN_MS,
  );
  assert.throws(() => previewClockCorrection(state, '360:00.1'), /INVALID_TIME/);
});

test('invalid clock text and a running, held or decided result cannot be previewed as an editable pause', () => {
  for (const value of ['01:60.0', '-01:00.0', '1.5', '01:00.01', '01:00', 'NaN'])
    assert.throws(() => previewClockCorrection(stopped(), value), /CLOCK_INPUT_FORMAT/);
  assert.throws(() => previewClockCorrection(stopped(), '03:00.1'), /INVALID_TIME/);
  assert.throws(
    () => previewClockCorrection({ ...stopped(), status: 'RUNNING' }, '01:00.0'),
    /PAUSE_REQUIRED/,
  );
  assert.throws(
    () =>
      previewClockCorrection({ ...stopped(), hold: { side: 'WHITE', elapsedMs: 2000 } }, '01:00.0'),
    /RESOLVE_HOLD_FIRST/,
  );
  assert.throws(
    () =>
      previewClockCorrection(
        { ...stopped(), outcome: { winner: 'BLUE', reason: 'IPPON' } },
        '01:00.0',
      ),
    /RESULT_LOCKED/,
  );
});

test('an unconfirmed regular TIME result can restore remaining time without removing the score history', () => {
  const state = stopped();
  state.awards.push({ id: command, side: 'WHITE', kind: 'YUKO', active: true, phase: 'REGULAR' });
  const timedResult = previewClockCorrection(state, '00:00.0').state;
  assert.equal(timedResult.status, 'PROVISIONAL');
  assert.equal(timedResult.outcome?.reason, 'TIME');
  const restored = previewClockCorrection(timedResult, '00:03.5').state;
  assert.equal(restored.status, 'PAUSED');
  assert.equal(restored.outcome, null);
  assert.deepEqual(restored.awards, state.awards);
  assert.equal(timedResult.outcome?.reason, 'TIME', 'preview does not mutate the source result');
  assert.throws(
    () => previewClockCorrection({ ...timedResult, status: 'CONFIRMED' }, '00:03.5'),
    /PAUSE_REQUIRED|RESULT_LOCKED/,
  );
});
