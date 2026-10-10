import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import type { Tournament } from '../src/features/tournaments/types.ts';
import {
  canCorrectEntryName,
  nameCorrectionErrors,
  nameReviewMatches,
  reviewEntryName,
  savedNameEntry,
  validNameCorrectionPayload,
} from '../src/features/roster/entry-name-model.ts';
import {
  clearPendingRoster,
  deliverRosterCommand,
  pendingRosterJson,
  readPendingRoster,
  savePendingRoster,
  type PendingRosterCommand,
} from '../src/features/roster/roster-command.ts';
import {
  mergeRosterReceipt,
  type EntryCorrectionReceipt,
  type SavedEntry,
} from '../src/features/roster/roster-model.ts';

const uuid = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tournamentId = uuid(1),
  entryId = uuid(2),
  categoryId = uuid(3),
  clubId = uuid(4);
function entry(extra: Partial<SavedEntry> = {}): SavedEntry {
  return {
    id: entryId,
    athleteId: uuid(5),
    categoryId,
    clubId,
    club: 'QA Қыран',
    birthYear: 2012,
    gender: null,
    archivedAt: null,
    firstName: 'Әлихан',
    lastName: 'QA Серік',
    ...extra,
  };
}
function tournament(status = 'RUNNING', drawStatus = 'CONFIRMED'): Tournament {
  return {
    id: tournamentId,
    name: 'QA tournament',
    city: 'QA',
    venue: 'QA',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 1,
    status,
    rosterRevision: 8,
    clubs: [{ id: clubId, name: 'QA Қыран', _count: { entries: 2 } }],
    categories: [
      {
        id: categoryId,
        name: 'QA U14 -30',
        gender: 'MALE',
        birthYearFrom: 2012,
        birthYearTo: 2013,
        maxWeightGrams: 30000,
        durationSeconds: 180,
        format: 'ROUND_ROBIN',
        draw: {
          status: drawStatus,
          publishedAt: '2026-10-10T00:00:00.000Z',
          _count: { contests: 1 },
        },
        entries: [entry(), entry({ id: uuid(10), athleteId: uuid(11) })],
      },
    ],
  };
}
function command(): Extract<PendingRosterCommand, { kind: 'name' }> {
  return {
    tournamentId,
    kind: 'name',
    entryId,
    entrySnapshot: entry(),
    payload: {
      id: uuid(6),
      expectedRevision: 8,
      firstName: 'Әлихан',
      lastName: 'QA Серікұлы',
      reason: 'Опечатка в фамилии',
    },
  };
}
function receipt(): EntryCorrectionReceipt {
  return {
    revision: 9,
    entry: entry({ lastName: command().payload.lastName }),
    invalidatedCategoryIds: [],
  };
}
function storage() {
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

test('name-only availability follows target draw and active entry ID, including finished tournaments', () => {
  for (const [status, drawStatus, allowed] of [
    ['DRAFT', 'PREVIEW', false],
    ['DRAFT', 'CONFIRMED', true],
    ['RUNNING', 'CONFIRMED', true],
    ['FINISHED', 'CONFIRMED', true],
    ['CANCELLED', 'CONFIRMED', false],
  ] as const) {
    const value = tournament(status, drawStatus);
    assert.equal(canCorrectEntryName(value, entry()), allowed);
    assert.equal(
      canCorrectEntryName(value, entry({ archivedAt: '2026-10-10T00:00:00.000Z' })),
      false,
    );
    assert.equal(canCorrectEntryName(value, entry({ id: uuid(99) })), false);
  }
  const value = tournament('DRAFT');
  value.categories[0].draw = null;
  assert.equal(canCorrectEntryName(value, entry()), false);
});

test('legacy null sporting fields stay null rather than being materialized from the category', () => {
  const category = tournament().categories[0];
  const raw = entry({ birthYear: null, clubId: null, athleteId: undefined });
  assert.deepEqual(savedNameEntry(raw, category), raw);
  assert.equal(savedNameEntry(raw, category)?.gender, null);
});

test('name review normalizes Unicode and whitespace, catches unchanged names and expanded overlength', () => {
  const before = entry();
  const review = reviewEntryName(before, '  Әлихан  ', 'QA\tСерікұлы', '  Опечатка  ', 8)!;
  assert.equal(review.firstName, 'Әлихан');
  assert.equal(review.lastName, 'QA Серікұлы');
  assert.equal(review.reason, 'Опечатка');
  assert.deepEqual(nameCorrectionErrors(before, 'Әлихан', ' QA  Серік ', 'Причина'), [
    'NAME_UNCHANGED',
  ]);
  assert.ok(
    nameCorrectionErrors(before, '\ufb03'.repeat(27), 'Новое', 'Причина').includes('NAME_TOO_LONG'),
  );
  assert.ok(nameCorrectionErrors(before, ' ', 'Новое', 'Причина').includes('NAME_REQUIRED'));
  assert.equal(reviewEntryName(before, 'Новое', 'ФИО', 'я', 8), null);
  before.club = 'changed after review';
  assert.equal(review.before.club, 'QA Қыран');
});

test('a reviewed correction cannot be confirmed after a poll, reason edit or identity snapshot change', () => {
  const before = entry();
  const review = reviewEntryName(before, 'Әлихан', 'QA Серікұлы', 'Опечатка', 8);
  assert.equal(nameReviewMatches(review, before, 'Әлихан', 'QA Серікұлы', 'Опечатка', 8), true);
  assert.equal(nameReviewMatches(review, before, 'Әлихан', 'QA Серікұлы', 'Опечатка', 9), false);
  assert.equal(
    nameReviewMatches(review, before, 'Әлихан', 'QA Серікұлы', 'Другая причина', 8),
    false,
  );
  assert.equal(
    nameReviewMatches(review, before, 'Другое имя', 'QA Серікұлы', 'Опечатка', 8),
    false,
  );
  for (const extra of [
    { id: uuid(99) },
    { gender: 'MALE' as const },
    { athleteId: uuid(99) },
    { lastName: 'Новее' },
  ])
    assert.equal(
      nameReviewMatches(review, entry(extra), 'Әлихан', 'QA Серікұлы', 'Опечатка', 8),
      false,
    );
});

test('unknown name delivery restores and retries its immutable original packet across reload', async () => {
  const store = storage(),
    pending = command();
  savePendingRoster(store, pending);
  const raw = pendingRosterJson(store, tournamentId);
  const sent: unknown[] = [];
  async function send(path: string, payload: unknown) {
    assert.equal(path, `/tournaments/${tournamentId}/roster/entries/${entryId}/name`);
    assert.deepEqual(Object.keys(payload as object).sort(), [
      'expectedRevision',
      'firstName',
      'id',
      'lastName',
      'reason',
    ]);
    sent.push(structuredClone(payload));
    (payload as { expectedRevision: number }).expectedRevision = 999;
    if (sent.length === 1) throw new Error('response lost after commit');
    return receipt();
  }
  assert.equal((await deliverRosterCommand(pending, send)).kind, 'retry');
  const restored = readPendingRoster(store, tournamentId)!;
  assert.equal((await deliverRosterCommand(restored, send)).kind, 'success');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(pendingRosterJson(store, tournamentId), raw);
  assert.equal(restored.payload.expectedRevision, 8);
});

test('one roster pending barrier prevents a new name packet or archive from replacing an unresolved correction', () => {
  const store = storage(),
    pending = command();
  savePendingRoster(store, pending);
  const replacement = {
    ...pending,
    payload: { ...pending.payload, id: uuid(99), expectedRevision: 9 },
  };
  assert.throws(() => savePendingRoster(store, replacement), /ROSTER_PENDING_EXISTS/);
  assert.throws(() => clearPendingRoster(store, replacement), /ROSTER_PENDING_EXISTS/);
  const archive: PendingRosterCommand = {
    ...pending,
    kind: 'archive',
    payload: { id: uuid(99), expectedRevision: 9, reason: 'Исключение' },
  };
  assert.throws(() => savePendingRoster(store, archive), /ROSTER_PENDING_EXISTS/);
  assert.deepEqual(JSON.parse(pendingRosterJson(store, tournamentId)), pending);
  clearPendingRoster(store, pending);
  assert.equal(readPendingRoster(store, tournamentId), null);
});

test('corrupt or broad saved name packets block delivery instead of editing category or club', () => {
  for (const corrupt of [
    { ...command(), payload: { ...command().payload, categoryId } },
    { ...command(), payload: { ...command().payload, clubId } },
    { ...command(), payload: { ...command().payload, firstName: '' } },
    { ...command(), entrySnapshot: entry({ id: uuid(99) }) },
    { ...command(), entrySnapshot: entry({ archivedAt: '2026-10-10T00:00:00.000Z' }) },
  ]) {
    const store = storage();
    store.setItem(`judo.roster.pending.${tournamentId}`, JSON.stringify(corrupt));
    assert.throws(() => readPendingRoster(store, tournamentId), /ROSTER_STORAGE_INVALID/);
    assert.throws(
      () => savePendingRoster(storage(), corrupt as PendingRosterCommand),
      /ROSTER_STORAGE_INVALID/,
    );
  }
  assert.equal(validNameCorrectionPayload({ ...command().payload, athleteId: uuid(99) }), false);
});

test('name receipt must preserve identity, nullable fields, category, club and the confirmed draw', async () => {
  const pending = command();
  assert.equal((await deliverRosterCommand(pending, async () => receipt())).kind, 'success');
  for (const extra of [
    { id: uuid(99) },
    { athleteId: uuid(99) },
    { categoryId: uuid(99) },
    { clubId: uuid(99) },
    { club: 'Другой клуб' },
    { birthYear: 2013 },
    { gender: 'MALE' as const },
    { archivedAt: '2026-10-10T00:00:00.000Z' },
    { firstName: 'Другое' },
    { lastName: 'Другой' },
  ]) {
    const wrong = receipt();
    Object.assign(wrong.entry, extra);
    assert.equal((await deliverRosterCommand(pending, async () => wrong)).kind, 'retry');
  }
  assert.equal(
    (
      await deliverRosterCommand(pending, async () => ({
        ...receipt(),
        invalidatedCategoryIds: [categoryId],
      }))
    ).kind,
    'retry',
  );
});

test('merging a name receipt updates only its ID, preserves homonyms and rejects older receipts', () => {
  const current = tournament('FINISHED'),
    draw = current.categories[0].draw;
  const next = mergeRosterReceipt(current, receipt());
  assert.equal(next.status, 'FINISHED');
  assert.strictEqual(next.categories[0].draw, draw);
  assert.equal(
    next.categories[0].entries?.find((value) => value.id === entryId)?.lastName,
    'QA Серікұлы',
  );
  assert.equal(
    next.categories[0].entries?.find((value) => value.id === uuid(10))?.lastName,
    'QA Серік',
  );
  assert.equal(next.clubs[0]._count.entries, 2);
  const newer = mergeRosterReceipt(next, {
    ...receipt(),
    revision: 10,
    entry: entry({ lastName: 'QA Новейшее' }),
  });
  assert.strictEqual(mergeRosterReceipt(newer, receipt()), newer);
});

test('auth loss, rate limits, server failures and reused IDs retain exact name packets; definite validation errors reject', async () => {
  const pending = command();
  for (const [status, code] of [
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMIT'],
    [500, 'FAILED'],
    [409, 'COMMAND_ID_REUSED'],
  ] as const)
    assert.equal(
      (
        await deliverRosterCommand(pending, async () => {
          throw new ApiError(code, status);
        })
      ).kind,
      'retry',
    );
  for (const [status, code] of [
    [400, 'NAME_REQUIRED'],
    [409, 'VERSION_CONFLICT'],
    [409, 'ENTRY_ARCHIVED'],
    [409, 'NAME_UNCHANGED'],
  ] as const)
    assert.equal(
      (
        await deliverRosterCommand(pending, async () => {
          throw new ApiError(code, status);
        })
      ).kind,
      'rejected',
    );
});
