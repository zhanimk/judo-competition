import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  correctionPreviewMatches,
  correctionRow,
  correctionSignature,
  savedEntry,
} from '../src/features/roster/entry-correction-model.ts';
import type { Tournament } from '../src/features/tournaments/types.ts';
import {
  deliverRosterCommand,
  readPendingRoster,
  savePendingRoster,
  type PendingRosterCommand,
} from '../src/features/roster/roster-command.ts';
import {
  mergeRosterReceipt,
  validEntryCorrectionPreview,
  type EntryCorrectionPreview,
  type EntryCorrectionReceipt,
  type SavedEntry,
} from '../src/features/roster/roster-model.ts';

const uuid = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tournamentId = uuid(1),
  entryId = uuid(2),
  categoryId = uuid(3),
  targetId = uuid(4),
  clubId = uuid(5),
  otherClubId = uuid(6);
function entry(extra: Partial<SavedEntry> = {}): SavedEntry {
  return {
    id: entryId,
    firstName: 'Әлихан',
    lastName: 'Серік',
    birthYear: 2012,
    categoryId,
    clubId,
    club: 'Қыран',
    gender: 'MALE',
    archivedAt: null,
    ...extra,
  };
}
function command(
  kind: 'update' | 'archive' | 'restore',
): Extract<PendingRosterCommand, { entryId: string }> {
  const base = {
    tournamentId,
    entryId,
    entrySnapshot: entry(kind === 'restore' ? { archivedAt: '2026-10-09T08:00:00.000Z' } : {}),
    payload: { id: uuid(7), expectedRevision: 4, reason: 'Ошибка в заявке' },
  };
  return kind === 'update'
    ? {
        ...base,
        kind,
        payload: {
          ...base.payload,
          firstName: 'Әлихан',
          lastName: 'Серік',
          categoryId,
          clubId,
          birthYear: 2012,
          gender: 'MALE',
        },
      }
    : { ...base, kind };
}
function response(
  pending: Extract<PendingRosterCommand, { entryId: string }>,
): EntryCorrectionReceipt {
  return {
    revision: 5,
    entry: entry(pending.kind === 'archive' ? { archivedAt: '2026-10-09T08:00:00.000Z' } : {}),
    invalidatedCategoryIds: [categoryId],
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
function tournament(): Tournament {
  return {
    id: tournamentId,
    name: 'QA',
    city: 'QA',
    venue: 'QA',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 1,
    status: 'DRAFT',
    rosterRevision: 4,
    clubs: [
      { id: clubId, name: 'Қыран', _count: { entries: 1 } },
      { id: otherClubId, name: 'Жеңіс', _count: { entries: 0 } },
    ],
    categories: [categoryId, targetId].map((id) => ({
      id,
      name: id,
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
      format: 'REPECHAGE',
      draw: { status: 'PREVIEW', publishedAt: null, _count: { contests: 0 } },
      entries: id === categoryId ? [entry()] : [],
    })),
  };
}

for (const kind of ['update', 'archive', 'restore'] as const) {
  test(`${kind} correction survives reload and exact retry without sending local snapshot metadata`, async () => {
    const saved = storage(),
      pending = command(kind);
    savePendingRoster(saved, pending);
    const restored = readPendingRoster(saved, tournamentId)!;
    assert.deepEqual(restored, pending);
    const sent: unknown[] = [];
    const send = async (path: string, payload: unknown) => {
      assert.equal(path, `/tournaments/${tournamentId}/roster/entries/${entryId}/${kind}`);
      assert.equal('entrySnapshot' in (payload as object), false);
      sent.push(structuredClone(payload));
      if (sent.length === 1) throw new Error('response lost');
      return response(pending);
    };
    assert.equal((await deliverRosterCommand(restored, send)).kind, 'retry');
    assert.equal((await deliverRosterCommand(restored, send)).kind, 'success');
    assert.deepEqual(sent[0], sent[1]);
    assert.deepEqual(readPendingRoster(saved, tournamentId), pending);
  });
}
test('correction receipt for a different athlete or opposite archival action remains retryable', async () => {
  for (const kind of ['update', 'archive', 'restore'] as const) {
    const pending = command(kind);
    const wrong = response(pending);
    wrong.entry.id = uuid(99);
    assert.equal((await deliverRosterCommand(pending, async () => wrong)).kind, 'retry');
    const opposite = response(pending);
    opposite.entry.archivedAt = kind === 'archive' ? null : '2026-10-09T08:00:00.000Z';
    assert.equal((await deliverRosterCommand(pending, async () => opposite)).kind, 'retry');
  }
});
test('bad saved correction metadata blocks new commands instead of guessing the target', () => {
  for (const corrupt of [
    { ...command('archive'), entryId: uuid(99) },
    { ...command('restore'), entrySnapshot: entry() },
    { ...command('archive'), payload: { ...command('archive').payload, reason: ' ' } },
  ]) {
    const saved = storage();
    saved.setItem(`judo.roster.pending.${tournamentId}`, JSON.stringify(corrupt));
    assert.throws(() => readPendingRoster(saved, tournamentId), /ROSTER_STORAGE_INVALID/);
    assert.throws(() => savePendingRoster(saved, command('update')), /ROSTER_STORAGE_INVALID/);
  }
});
test('archive removes only the corrected entry and an older receipt cannot erase its restoration', () => {
  const archived = mergeRosterReceipt(tournament(), response(command('archive')));
  assert.equal(archived.categories[0].entries?.length, 0);
  assert.equal(archived.clubs[0]._count.entries, 0);
  assert.equal(archived.categories[0].draw?.status, 'STALE');
  const restored = mergeRosterReceipt(archived, { ...response(command('restore')), revision: 6 });
  assert.equal(restored.categories[0].entries?.[0].id, entryId);
  assert.equal(restored.clubs[0]._count.entries, 1);
  assert.strictEqual(mergeRosterReceipt(restored, response(command('archive'))), restored);
});
test('moving a corrected entry preserves its ID and updates both category and club counts', () => {
  const receipt: EntryCorrectionReceipt = {
    revision: 5,
    entry: entry({ categoryId: targetId, clubId: otherClubId, club: 'Жеңіс' }),
    invalidatedCategoryIds: [categoryId, targetId],
  };
  const moved = mergeRosterReceipt(tournament(), receipt);
  assert.equal(moved.categories[0].entries?.length, 0);
  assert.equal(moved.categories[1].entries?.[0].id, entryId);
  assert.deepEqual(
    moved.clubs.map((club) => club._count.entries),
    [0, 1],
  );
  assert.deepEqual(
    moved.categories.map((category) => category.draw?.status),
    ['STALE', 'STALE'],
  );
});
test('correction preview validates the entity and the affected category scope', () => {
  const value: EntryCorrectionPreview = {
    revision: 4,
    before: entry(),
    proposed: entry({ categoryId: targetId }),
    affectedCategoryIds: [categoryId, targetId],
    invalidatedCategoryIds: [categoryId],
    rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
    canSave: true,
  };
  assert.equal(validEntryCorrectionPreview(value), true);
  assert.equal(validEntryCorrectionPreview({ ...value, proposed: entry({ id: uuid(99) }) }), false);
  assert.equal(
    validEntryCorrectionPreview({ ...value, invalidatedCategoryIds: [uuid(99)] }),
    false,
  );
});
test('editing the reason, club, row or revision invalidates the exact correction signature', () => {
  const row = correctionRow(entry());
  const signature = correctionSignature(clubId, row, 'Ошибка в заявке', 4);
  for (const changed of [
    correctionSignature(clubId, row, 'Другая причина', 4),
    correctionSignature(otherClubId, row, 'Ошибка в заявке', 4),
    correctionSignature(clubId, { ...row, firstName: 'Мирас' }, 'Ошибка в заявке', 4),
    correctionSignature(clubId, row, 'Ошибка в заявке', 5),
  ])
    assert.notEqual(changed, signature);
});
test('correction preview is bound to the selected entry and every proposed field', () => {
  const current = entry();
  const row = correctionRow(current);
  const preview: EntryCorrectionPreview = {
    revision: 4,
    before: current,
    proposed: entry(),
    affectedCategoryIds: [categoryId],
    invalidatedCategoryIds: [],
    rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
    canSave: true,
  };
  assert.equal(correctionPreviewMatches(preview, current, clubId, row, 'update'), true);
  for (const changed of [
    { id: uuid(99) },
    { firstName: 'Мирас' },
    { lastName: 'Другая' },
    { clubId: otherClubId },
    { categoryId: targetId },
    { birthYear: 2013 },
    { gender: 'FEMALE' as const },
    { archivedAt: '2026-10-09T08:00:00.000Z' },
  ]) {
    assert.equal(
      correctionPreviewMatches(
        { ...preview, proposed: entry(changed) },
        current,
        clubId,
        row,
        'update',
      ),
      false,
    );
  }
});
test('restoration preview preserves original fields and accepts the legacy category gender', () => {
  const original = entry({ archivedAt: '2026-10-09T08:00:00.000Z', gender: null });
  const row = { ...correctionRow(original), gender: 'MALE' as const };
  const preview: EntryCorrectionPreview = {
    revision: 4,
    before: original,
    proposed: entry(),
    affectedCategoryIds: [categoryId],
    invalidatedCategoryIds: [],
    rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
    canSave: true,
  };
  assert.equal(correctionPreviewMatches(preview, original, clubId, row, 'restore', 'MALE'), true);
  for (const changed of [{ firstName: 'Мирас' }, { clubId: otherClubId }, { archivedAt: null }]) {
    assert.equal(
      correctionPreviewMatches(
        { ...preview, before: { ...original, ...changed } },
        original,
        clubId,
        row,
        'restore',
        'MALE',
      ),
      false,
    );
  }
});
test('legacy saved entry metadata comes from its category without changing its identity', () => {
  const category = tournament().categories[0];
  const legacy = { ...entry(), gender: null, clubId: null, birthYear: null };
  const normalized = savedEntry(legacy, category)!;
  assert.equal(normalized.id, entryId);
  assert.equal(normalized.gender, 'MALE');
  assert.equal(normalized.clubId, null);
  assert.equal(normalized.categoryId, categoryId);
  assert.equal(normalized.archivedAt, null);
  assert.equal(normalized.birthYear, null);
  assert.equal(correctionRow(normalized).birthYear, '');
  const row = { ...correctionRow(normalized), birthYear: '2012' };
  const preview: EntryCorrectionPreview = {
    revision: 4,
    before: normalized,
    proposed: entry({ clubId: null }),
    affectedCategoryIds: [categoryId],
    invalidatedCategoryIds: [],
    rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
    canSave: true,
  };
  assert.equal(validEntryCorrectionPreview(preview), true);
  assert.equal(correctionPreviewMatches(preview, normalized, '', row, 'update'), false);
  assert.equal(
    correctionPreviewMatches({ ...preview, proposed: entry() }, normalized, clubId, row, 'update'),
    true,
  );
  const saved = storage();
  const pending = command('update');
  saved.setItem(
    `judo.roster.pending.${tournamentId}`,
    JSON.stringify({ ...pending, payload: { ...pending.payload, birthYear: null } }),
  );
  assert.throws(() => readPendingRoster(saved, tournamentId), /ROSTER_STORAGE_INVALID/);
});
test('a 409 correction conflict is rejected while a 503 retains the same retryable command', async () => {
  const pending = command('update');
  assert.equal(
    (
      await deliverRosterCommand(pending, async () => {
        throw new ApiError('VERSION_CONFLICT', 409);
      })
    ).kind,
    'rejected',
  );
  assert.equal(
    (
      await deliverRosterCommand(pending, async () => {
        throw new ApiError('Unavailable', 503);
      })
    ).kind,
    'retry',
  );
});
