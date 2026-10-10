import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import type { Category, Tournament } from '../src/features/tournaments/types.ts';
import {
  clearPendingRoster,
  deliverRosterCommand,
  readPendingRoster,
  savePendingRoster,
  type PendingRosterCommand,
} from '../src/features/roster/roster-command.ts';
import {
  acceptRosterSnapshot,
  blankRow,
  eligibleCategories,
  entryInputs,
  mergeRosterReceipt,
  previewMatchesDraft,
  removeSubmittedDraft,
  rowErrors,
  rowsSignature,
  validRosterPreview,
  type DraftRow,
  type Receipt,
  type RosterPreview,
} from '../src/features/roster/roster-model.ts';
import { parseRosterText } from '../src/features/roster/roster-parser.ts';
import {
  draftKey,
  readRosterDraft,
  readRosterPaste,
  saveRosterDraft,
  saveRosterPaste,
} from '../src/features/roster/roster-storage.ts';

const tournamentId = '10000000-0000-4000-8000-000000000001';
const clubId = '10000000-0000-4000-8000-000000000002';
const categoryId = '10000000-0000-4000-8000-000000000003';
const commandId = '10000000-0000-4000-8000-000000000004';
const category: Category = {
  id: categoryId,
  name: 'Юноши U15 −50 кг',
  gender: 'MALE',
  birthYearFrom: 2012,
  birthYearTo: 2013,
  maxWeightGrams: 50000,
  durationSeconds: 180,
  format: 'REPECHAGE',
  entries: [],
};
function row(values: Partial<DraftRow> = {}): DraftRow {
  return {
    ...blankRow(),
    lastName: 'Иванов',
    firstName: 'Иван',
    birthYear: '2012',
    gender: 'MALE',
    categoryId,
    ...values,
  };
}
function tournament(): Tournament {
  return {
    id: tournamentId,
    name: 'Test',
    city: '',
    venue: '',
    startDate: '',
    endDate: '',
    tatamiCount: 1,
    status: 'DRAFT',
    administrationRevision: 0,
    rosterRevision: 4,
    clubs: [{ id: clubId, name: 'Клуб', _count: { entries: 0 } }],
    categories: [structuredClone(category)],
  };
}
function command(): Extract<PendingRosterCommand, { kind: 'roster' }> {
  const draftRows = [row()];
  return {
    tournamentId,
    kind: 'roster',
    draftRows,
    payload: { id: commandId, expectedRevision: 4, clubId, entries: entryInputs(draftRows) },
  };
}
function receipt(pending: Extract<PendingRosterCommand, { kind: 'roster' }>): Receipt {
  return {
    revision: 5,
    clubId,
    entries: pending.payload.entries.map((entry) => ({
      ...entry,
      id: crypto.randomUUID(),
      clubId,
      club: 'Клуб',
    })),
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

test('text list accepts the explicit header, semicolons or tabs and preserves compound names', () => {
  const parsed = parseRosterText(
    `Фамилия;Имя;Год рождения;Пол;Категория\nӘбді Рахман;Әли Нұр;2012;М;${category.name}\nИванов\tИван\t2013\tMALE\t${category.name}`,
    [category],
  );
  assert.equal(parsed.fatal, false);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].lastName, 'Әбді Рахман');
  assert.equal(parsed.rows[0].firstName, 'Әли Нұр');
  assert.equal(parsed.rows[1].categoryId, categoryId);
});
test('unknown or ambiguous category names and gender remain unresolved for explicit editing', () => {
  for (const categories of [[category], [category, { ...category, id: 'another' }]]) {
    const parsed = parseRosterText(
      `Иванов;Иван;2012;?;${categories.length === 1 ? 'U15' : category.name}`,
      categories,
    );
    assert.equal(parsed.fatal, false);
    assert.equal(parsed.rows[0].categoryId, '');
    assert.equal(parsed.rows[0].gender, '');
    assert.deepEqual(
      parsed.issues.map((issue) => issue.code),
      ['GENDER_REQUIRED', 'TEXT_CATEGORY'],
    );
    assert.ok(rowErrors(parsed.rows[0], categories).includes('CATEGORY_NOT_FOUND'));
  }
});
test('malformed lines are fatal rather than silently omitting athletes; batches are never truncated', () => {
  const malformed = parseRosterText(
    `Иванов;Иван;2012;М;${category.name}\nПроизвольное ФИО 2012 ${category.name}`,
    [category],
  );
  assert.equal(malformed.fatal, true);
  assert.deepEqual(malformed.issues, [{ line: 2, code: 'TEXT_FORMAT' }]);
  const large = parseRosterText(Array(501).fill(`Иванов;Иван;2012;М;${category.name}`).join('\n'), [
    category,
  ]);
  assert.equal(large.fatal, true);
  assert.equal(large.rows.length, 501);
  assert.ok(large.issues.some((issue) => issue.code === 'BATCH_LIMIT'));
});
test('category eligibility requires explicit year and gender and excludes confirmed draws', () => {
  const female = { ...category, id: 'female', gender: 'FEMALE' };
  const locked = {
    ...category,
    id: 'locked',
    draw: { status: 'CONFIRMED', publishedAt: null, _count: { contests: 0 } },
  };
  assert.deepEqual(eligibleCategories(row({ gender: '' }), [category]), []);
  assert.deepEqual(eligibleCategories(row({ birthYear: '' }), [category]), []);
  assert.deepEqual(
    eligibleCategories(row(), [category, female, locked]).map((item) => item.id),
    [categoryId],
  );
  assert.ok(rowErrors(row({ categoryId: female.id }), [female]).includes('GENDER_MISMATCH'));
  assert.ok(rowErrors(row({ categoryId: locked.id }), [locked]).includes('DRAW_LOCKED'));
  assert.ok(rowErrors(row({ birthYear: '2011' }), [category]).includes('BIRTH_YEAR_OUT_OF_RANGE'));
});
test('drafts restore by tournament and club; corrupted data is retained and cannot silently become an empty roster', () => {
  const store = storage(),
    draft = [row()];
  saveRosterDraft(store, tournamentId, clubId, draft);
  saveRosterPaste(store, tournamentId, clubId, 'Неотправленный текст команды');
  assert.deepEqual(readRosterDraft(store, tournamentId, clubId), draft);
  assert.equal(readRosterPaste(store, tournamentId, clubId), 'Неотправленный текст команды');
  assert.equal(readRosterPaste(store, tournamentId, 'another-club'), '');
  assert.notDeepEqual(readRosterDraft(store, 'another-tournament', clubId), draft);
  assert.notDeepEqual(readRosterDraft(store, tournamentId, 'another-club'), draft);
  store.setItem(draftKey(tournamentId, clubId), '{bad');
  assert.throws(() => readRosterDraft(store, tournamentId, clubId), /ROSTER_STORAGE_INVALID/);
  assert.equal(store.getItem(draftKey(tournamentId, clubId)), '{bad');
});
test('editing any row, confirming a homonym or receiving a new roster revision invalidates approval', () => {
  const draft = [row()],
    data: RosterPreview = {
      revision: 4,
      rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
      canSave: true,
    };
  const checked = { signature: rowsSignature(draft), data };
  assert.equal(previewMatchesDraft(checked, structuredClone(draft), 4), true);
  assert.equal(previewMatchesDraft(checked, [{ ...draft[0], firstName: 'Другой' }], 4), false);
  assert.equal(previewMatchesDraft(checked, [{ ...draft[0], duplicateConfirmed: true }], 4), false);
  assert.equal(previewMatchesDraft(checked, draft, 5), false);
  assert.equal(previewMatchesDraft(checked, [...draft, row()], 4), false);
});
test('bounded duplicate preview keeps the total and rejects a malformed approval', () => {
  const data: RosterPreview = {
    revision: 4,
    rows: [
      {
        index: 0,
        errors: ['DUPLICATE_CONFIRMATION_REQUIRED'],
        duplicateCount: 499,
        possibleDuplicates: Array.from({ length: 5 }, (_, index) => ({
          entryId: `batch:${index + 1}`,
          categoryId,
          club: 'Клуб',
          firstName: 'Иван',
          lastName: 'Иванов',
          birthYear: 2012,
        })),
      },
    ],
    canSave: false,
  };
  assert.equal(validRosterPreview(data, 1), true);
  assert.equal(validRosterPreview({ ...data, canSave: true }, 1), false);
  assert.equal(validRosterPreview({ ...data, rows: [{ ...data.rows[0], index: 2 }] }, 1), false);
});
test('lost commit response restores and retries the same command body and ID without adding athletes twice', async () => {
  const store = storage(),
    pending = command();
  const sent: unknown[] = [],
    receipts = new Map<string, Receipt>();
  let mutations = 0;
  const send = async (_path: string, payload: unknown) => {
    const input = payload as typeof pending.payload;
    sent.push(structuredClone(input));
    if (!receipts.has(input.id)) {
      mutations++;
      receipts.set(input.id, receipt(pending));
      throw new TypeError('response lost');
    }
    return receipts.get(input.id)!;
  };
  savePendingRoster(store, pending);
  assert.equal((await deliverRosterCommand(pending, send)).kind, 'retry');
  const restored = readPendingRoster(store, tournamentId)!;
  assert.deepEqual(restored, pending);
  assert.equal((await deliverRosterCommand(restored, send)).kind, 'success');
  assert.equal(mutations, 1);
  assert.deepEqual(sent, [pending.payload, pending.payload]);
  clearPendingRoster(store, restored);
  assert.equal(readPendingRoster(store, tournamentId), null);
});
test('unresolved roster blocks club creation or replacing its ID, revision, club and rows', () => {
  const store = storage(),
    pending = command();
  savePendingRoster(store, pending);
  for (const replacement of [
    { ...pending, payload: { ...pending.payload, id: '10000000-0000-4000-8000-000000000005' } },
    { ...pending, payload: { ...pending.payload, expectedRevision: 6 } },
    { ...pending, payload: { ...pending.payload, clubId: 'other' } },
    {
      tournamentId,
      kind: 'club' as const,
      payload: { id: commandId, expectedRevision: 4, name: 'Другой' },
    },
  ]) {
    assert.throws(() => savePendingRoster(store, replacement), /ROSTER_PENDING_EXISTS/);
    assert.throws(() => clearPendingRoster(store, replacement), /ROSTER_PENDING_EXISTS/);
    assert.deepEqual(readPendingRoster(store, tournamentId), pending);
  }
});
test('club creation lost response replays the same ID and cannot reset a newer saved club roster', async () => {
  const store = storage();
  const pending: PendingRosterCommand = {
    tournamentId,
    kind: 'club',
    payload: { id: commandId, expectedRevision: 4, name: 'Клуб' },
  };
  const created: Receipt = {
    revision: 5,
    club: { id: clubId, name: 'Клуб', _count: { entries: 0 } },
  };
  let mutations = 0,
    saved = false;
  const bodies: unknown[] = [];
  const send = async (_path: string, body: unknown) => {
    bodies.push(structuredClone(body));
    if (!saved) {
      saved = true;
      mutations++;
      throw new TypeError('lost after club commit');
    }
    return created;
  };
  savePendingRoster(store, pending);
  assert.equal((await deliverRosterCommand(pending, send)).kind, 'retry');
  assert.equal(
    (await deliverRosterCommand(readPendingRoster(store, tournamentId)!, send)).kind,
    'success',
  );
  assert.equal(mutations, 1);
  assert.deepEqual(bodies, [pending.payload, pending.payload]);
  const newer = {
    ...tournament(),
    rosterRevision: 6,
    clubs: [{ id: clubId, name: 'Клуб', _count: { entries: 12 } }],
  };
  assert.equal(mergeRosterReceipt(newer, created), newer);
  assert.equal(newer.clubs[0]._count.entries, 12);
});
test('5xx and invalid receipts require exact retry; definite conflict releases the old command', async () => {
  const store = storage(),
    pending = command();
  savePendingRoster(store, pending);
  for (const status of [500, 503])
    assert.equal(
      (
        await deliverRosterCommand(pending, async () => {
          throw new ApiError('upstream', status);
        })
      ).kind,
      'retry',
    );
  const invalid = receipt(pending);
  assert.equal(
    (await deliverRosterCommand(pending, async () => ({ ...invalid, revision: 4 }))).kind,
    'retry',
  );
  assert.deepEqual(readPendingRoster(store, tournamentId), pending);
  assert.equal(
    (
      await deliverRosterCommand(pending, async () => {
        throw new ApiError('VERSION_CONFLICT', 409);
      })
    ).kind,
    'rejected',
  );
  clearPendingRoster(store, pending);
  const rechecked = {
    ...pending,
    payload: {
      ...pending.payload,
      expectedRevision: 9,
      id: '10000000-0000-4000-8000-000000000005',
    },
  };
  savePendingRoster(store, rechecked);
  assert.equal(readPendingRoster(store, tournamentId)?.payload.expectedRevision, 9);
});
test('transport cannot mutate the original body used for exact retry', async () => {
  const pending = command(),
    original = structuredClone(pending);
  await deliverRosterCommand(pending, async (_path, payload) => {
    (payload as typeof pending.payload).entries[0].firstName = 'Mutation';
    throw new TypeError('lost');
  });
  assert.deepEqual(pending, original);
});
test('old receipts and snapshots cannot undo a newer roster; preview has no effect on persisted counts', () => {
  const current = tournament(),
    pending = command(),
    saved = receipt(pending);
  const next = mergeRosterReceipt(current, saved);
  assert.equal(current.categories[0].entries!.length, 0);
  assert.equal(current.clubs[0]._count.entries, 0);
  assert.equal(next.categories[0].entries!.length, 1);
  assert.equal(next.clubs[0]._count.entries, 1);
  assert.equal(mergeRosterReceipt(next, saved), next);
  assert.equal(acceptRosterSnapshot(next, current, tournamentId), next);
  const authoritative = { ...next, name: 'Updated', status: 'RUNNING' };
  assert.equal(
    acceptRosterSnapshot(next, authoritative, tournamentId),
    authoritative,
    'equal revision still replaces a partial receipt with the complete snapshot',
  );
  assert.equal(acceptRosterSnapshot(next, { ...authoritative, id: 'another' }, tournamentId), next);
  assert.equal(mergeRosterReceipt({ ...next, rosterRevision: 10 }, saved).rosterRevision, 10);
});
test('acknowledging submitted rows preserves later draft rows and can be repeated safely', () => {
  const submitted = [row()],
    later = row({ firstName: 'Следующий' });
  const remaining = removeSubmittedDraft([...submitted, later], submitted);
  assert.deepEqual(remaining, [later]);
  assert.deepEqual(removeSubmittedDraft(remaining, submitted), [later]);
});
