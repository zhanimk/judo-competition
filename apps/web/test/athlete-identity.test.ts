import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import type { Tournament } from '../src/features/tournaments/types.ts';
import {
  chooseAthlete,
  newAthlete,
  identityPreviewMatches,
  identitySignature,
  validAthleteCandidates,
  type AthleteCandidate,
  type EntryIdentityPreview,
} from '../src/features/roster/athlete-model.ts';
import {
  deliverRosterCommand,
  readPendingRoster,
  savePendingRoster,
  clearPendingRoster,
  type PendingRosterCommand,
} from '../src/features/roster/roster-command.ts';
import {
  entryInputs,
  rowsSignature,
  samePersonInput,
  mergeRosterReceipt,
  type DraftRow,
  type SavedEntry,
  type EntryCorrectionReceipt,
} from '../src/features/roster/roster-model.ts';
import {
  readRosterDraft,
  saveRosterDraft,
  draftKey,
} from '../src/features/roster/roster-storage.ts';
import { correctionPreviewMatches } from '../src/features/roster/entry-correction-model.ts';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tournamentId = id(1),
  categoryId = id(2),
  clubId = id(3),
  entryId = id(4),
  sourceAthleteId = id(5),
  targetAthleteId = id(6);
const entry = (): SavedEntry => ({
  id: entryId,
  athleteId: sourceAthleteId,
  firstName: 'Әли',
  lastName: 'Серік',
  birthYear: 2017,
  gender: 'MALE',
  club: 'Қыран',
  clubId,
  categoryId,
  archivedAt: null,
});
const candidate = (): AthleteCandidate => ({
  id: targetAthleteId,
  display: {
    entryId: id(7),
    tournamentId: id(8),
    firstName: 'Әли',
    lastName: 'Серік',
    birthYear: 2017,
    gender: 'MALE',
    club: 'Бұрынғы клуб',
  },
  activeEntry: null,
});
const row = (): DraftRow => ({
  localId: id(9),
  firstName: 'Әли',
  lastName: 'Серік',
  birthYear: '2017',
  gender: 'MALE',
  categoryId,
});
const command = (): Extract<PendingRosterCommand, { kind: 'identity' }> => ({
  kind: 'identity',
  tournamentId,
  entryId,
  entrySnapshot: entry(),
  athleteSnapshot: { id: targetAthleteId, display: candidate().display },
  payload: { id: id(10), expectedRevision: 4, athleteId: targetAthleteId, reason: 'Ошибка связи' },
});
const receipt = (): EntryCorrectionReceipt => ({
  revision: 5,
  entry: { ...entry(), athleteId: targetAthleteId },
  invalidatedCategoryIds: [categoryId],
});
const preview = (): EntryIdentityPreview => ({
  revision: 4,
  before: entry(),
  proposed: { ...entry(), athleteId: targetAthleteId },
  athlete: { id: targetAthleteId, display: candidate().display },
  errors: [],
  canSave: true,
  affectedCategoryIds: [categoryId],
  invalidatedCategoryIds: [categoryId],
});
function store() {
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
    startDate: '2026-10-09',
    endDate: '2026-10-09',
    tatamiCount: 1,
    status: 'DRAFT',
    rosterRevision: 4,
    clubs: [{ id: clubId, name: 'Қыран', _count: { entries: 1 } }],
    categories: [
      {
        id: categoryId,
        name: '2017',
        gender: 'MALE',
        birthYearFrom: 2017,
        birthYearTo: 2017,
        maxWeightGrams: null,
        durationSeconds: 120,
        format: 'ROUND_ROBIN',
        draw: { status: 'PREVIEW', publishedAt: null, _count: { contests: 0 } },
        entries: [entry()],
        _count: { entries: 1 },
      },
    ],
  };
}

test('athlete search accepts bounded explicit identities and rejects malformed registration scopes', () => {
  assert.equal(validAthleteCandidates({ athletes: [candidate()] }), true);
  assert.equal(
    validAthleteCandidates({
      athletes: [{ ...candidate(), activeEntry: { entryId, categoryId } }],
    }),
    true,
  );
  assert.equal(
    validAthleteCandidates({
      athletes: [{ ...candidate(), activeEntry: { entryId: 'bad', categoryId } }],
    }),
    false,
  );
  assert.equal(validAthleteCandidates({ athletes: [candidate(), candidate()] }), false);
  assert.equal(
    validAthleteCandidates({
      athletes: Array.from({ length: 21 }, (_, i) => ({ ...candidate(), id: id(i + 20) })),
    }),
    false,
  );
});
test('choosing a past athlete explicitly copies its snapshot but requires a new category selection', () => {
  const original = row(),
    person = candidate(),
    chosen = chooseAthlete(original, person);
  assert.equal(chosen.athleteId, targetAthleteId);
  assert.equal(chosen.categoryId, '');
  assert.equal(original.categoryId, categoryId);
  person.display.firstName = 'Changed';
  assert.equal(chosen.athleteDisplay?.firstName, 'Әли');
  assert.equal(
    chooseAthlete(original, {
      ...candidate(),
      display: { ...candidate().display, birthYear: null },
    }).birthYear,
    '',
  );
  const homonym = newAthlete(chosen);
  assert.equal(homonym.athleteId, undefined);
  assert.equal(homonym.athleteDisplay, undefined);
  assert.equal(homonym.firstName, chosen.firstName);
});
test('different identities with identical names invalidate the reviewed batch and duplicate acknowledgment', () => {
  const first = { ...row(), athleteId: sourceAthleteId },
    second = { ...row(), athleteId: targetAthleteId };
  assert.notEqual(rowsSignature([first]), rowsSignature([second]));
  assert.equal(samePersonInput(first, second), false);
  assert.equal(entryInputs([second])[0].athleteId, targetAthleteId);
  assert.equal(
    'athleteId' in entryInputs([row()])[0],
    false,
    'typed names alone do not select an identity',
  );
  assert.notEqual(
    identitySignature(targetAthleteId, 'Reason', 4),
    identitySignature(targetAthleteId, 'Another', 4),
  );
  assert.notEqual(
    identitySignature(targetAthleteId, 'Reason', 4),
    identitySignature(targetAthleteId, 'Reason', 5),
  );
});
test('chosen identity and source snapshot survive same-tab draft reload without tolerating corrupt IDs', () => {
  const storage = store(),
    chosen = chooseAthlete(row(), candidate());
  saveRosterDraft(storage, tournamentId, clubId, [chosen]);
  assert.deepEqual(readRosterDraft(storage, tournamentId, clubId), [chosen]);
  storage.setItem(
    draftKey(tournamentId, clubId),
    JSON.stringify([{ ...chosen, athleteId: 'bad' }]),
  );
  assert.throws(() => readRosterDraft(storage, tournamentId, clubId), /ROSTER_STORAGE_INVALID/);
  assert.ok(storage.getItem(draftKey(tournamentId, clubId)));
});
test('identity preview permits only a link change on the concrete active entry', () => {
  const valid = preview();
  assert.equal(identityPreviewMatches(valid, entryId, targetAthleteId), true);
  for (const value of [
    { ...valid, before: { ...valid.before, id: id(40) } },
    { ...valid, proposed: { ...valid.proposed, firstName: 'Changed' } },
    { ...valid, proposed: { ...valid.proposed, categoryId: id(41) } },
    { ...valid, proposed: { ...valid.proposed, athleteId: sourceAthleteId } },
    { ...valid, invalidatedCategoryIds: [id(42)] },
    { ...valid, errors: ['ATHLETE_ALREADY_REGISTERED'] },
  ])
    assert.equal(identityPreviewMatches(value, entryId, targetAthleteId), false);
  assert.equal(
    identityPreviewMatches(
      { ...valid, errors: ['ATHLETE_ALREADY_REGISTERED'], canSave: false },
      entryId,
      targetAthleteId,
    ),
    true,
  );
});
test('binding legacy raw null gender preserves both preview snapshots and accepts effective receipt gender', async () => {
  const data = preview();
  data.before.gender = null;
  data.proposed.gender = null;
  assert.equal(identityPreviewMatches(data, entryId, targetAthleteId), true);
  const pending = command();
  pending.entrySnapshot.gender = null;
  assert.equal((await deliverRosterCommand(pending, async () => receipt())).kind, 'success');
  assert.equal(
    (
      await deliverRosterCommand(command(), async () => ({
        ...receipt(),
        entry: { ...receipt().entry, gender: 'FEMALE' },
      }))
    ).kind,
    'retry',
  );
});
test('lost bind response restores one immutable command and sends no local snapshots', async () => {
  const storage = store(),
    pending = command();
  savePendingRoster(storage, pending);
  assert.equal(
    (
      await deliverRosterCommand(pending, async () => {
        throw new TypeError('lost response');
      })
    ).kind,
    'retry',
  );
  const restored = readPendingRoster(storage, tournamentId)!;
  assert.deepEqual(restored, pending);
  const result = await deliverRosterCommand(restored, async (path, body) => {
    assert.equal(path, `/tournaments/${tournamentId}/roster/entries/${entryId}/identity`);
    assert.deepEqual(body, pending.payload);
    (body as typeof pending.payload).athleteId = id(43);
    assert.equal(pending.payload.athleteId, targetAthleteId);
    return receipt();
  });
  assert.equal(result.kind, 'success');
  clearPendingRoster(storage, pending);
  assert.equal(readPendingRoster(storage, tournamentId), null);
});
test('pending identity cannot be replaced by another target, entry, revision or mutation', () => {
  const storage = store(),
    pending = command();
  savePendingRoster(storage, pending);
  for (const replacement of [
    { ...pending, payload: { ...pending.payload, athleteId: id(44) } },
    { ...pending, payload: { ...pending.payload, expectedRevision: 5 } },
    { ...pending, entryId: id(45) },
  ])
    assert.throws(() => savePendingRoster(storage, replacement), /ROSTER_PENDING_EXISTS/);
  assert.throws(
    () =>
      savePendingRoster(storage, {
        kind: 'club',
        tournamentId,
        payload: { id: id(46), expectedRevision: 4, name: 'New' },
      }),
    /ROSTER_PENDING_EXISTS/,
  );
  assert.deepEqual(readPendingRoster(storage, tournamentId), pending);
});
test('wrong identity or rewritten personal data in a receipt retains the exact pending command', async () => {
  for (const changed of [
    { athleteId: sourceAthleteId },
    { id: id(47) },
    { firstName: 'Changed' },
    { birthYear: null },
    { club: 'Changed' },
    { categoryId: id(48) },
    { archivedAt: '2026-10-09T09:00:00Z' },
  ])
    assert.equal(
      (
        await deliverRosterCommand(command(), async () => ({
          ...receipt(),
          entry: { ...receipt().entry, ...changed },
        }))
      ).kind,
      'retry',
    );
});
test('identity conflict is definite while unavailable server retains its command', async () => {
  assert.equal(
    (
      await deliverRosterCommand(command(), async () => {
        throw new ApiError('ATHLETE_ALREADY_REGISTERED', 409);
      })
    ).kind,
    'rejected',
  );
  assert.equal(
    (
      await deliverRosterCommand(command(), async () => {
        throw new ApiError('Unavailable', 503);
      })
    ).kind,
    'retry',
  );
});
test('binding retains Entry ID and personal snapshots, updates STALE and cannot undo a newer link', () => {
  const original = tournament(),
    next = mergeRosterReceipt(original, receipt());
  assert.equal(original.categories[0].entries![0].athleteId, sourceAthleteId);
  assert.deepEqual(next.categories[0].entries, [receipt().entry]);
  assert.equal(next.categories[0].draw?.status, 'STALE');
  assert.equal(next.clubs[0]._count.entries, 1);
  const newer = {
    ...next,
    rosterRevision: 6,
    categories: [{ ...next.categories[0], entries: [{ ...receipt().entry, athleteId: id(49) }] }],
  };
  assert.equal(mergeRosterReceipt(newer, receipt()), newer);
});
test('selected batch identity must match the receipt while historical receipts remain compatible', async () => {
  const chosen = { ...chooseAthlete(row(), candidate()), categoryId };
  const batch: PendingRosterCommand = {
    kind: 'roster',
    tournamentId,
    draftRows: [chosen],
    payload: { id: id(50), expectedRevision: 4, clubId, entries: entryInputs([chosen]) },
  };
  const batchEntry = { ...entry(), clubId, gender: 'MALE' as const };
  const result = { revision: 5, clubId, entries: [{ ...batchEntry, athleteId: targetAthleteId }] };
  assert.equal((await deliverRosterCommand(batch, async () => result)).kind, 'success');
  assert.equal(
    (await deliverRosterCommand(batch, async () => ({ ...result, entries: [batchEntry] }))).kind,
    'retry',
  );
  const oldRow = row(),
    oldBatch = {
      ...batch,
      draftRows: [oldRow],
      payload: { ...batch.payload, entries: entryInputs([oldRow]) },
    };
  const { athleteId: _id, ...oldEntry } = batchEntry;
  assert.equal(
    (await deliverRosterCommand(oldBatch, async () => ({ ...result, entries: [oldEntry] }))).kind,
    'success',
  );
});
test('ordinary correction cannot sneak an identity change through an update payload or preview', () => {
  const storage = store(),
    source = entry();
  storage.setItem(
    `judo.roster.pending.${tournamentId}`,
    JSON.stringify({
      kind: 'update',
      tournamentId,
      entryId,
      entrySnapshot: source,
      payload: {
        id: id(51),
        expectedRevision: 4,
        reason: 'Reason',
        clubId,
        ...entryInputs([row()])[0],
        athleteId: targetAthleteId,
      },
    }),
  );
  assert.throws(() => readPendingRoster(storage, tournamentId), /ROSTER_STORAGE_INVALID/);
  assert.equal(
    correctionPreviewMatches(
      {
        revision: 4,
        before: source,
        proposed: { ...source, athleteId: targetAthleteId },
        rows: [{ index: 0, errors: [], duplicateCount: 0, possibleDuplicates: [] }],
        canSave: true,
        affectedCategoryIds: [categoryId],
        invalidatedCategoryIds: [],
      },
      source,
      clubId,
      row(),
      'update',
    ),
    false,
  );
});
test('corrupt target snapshot remains stored and blocks identity recovery', () => {
  const storage = store(),
    pending = command();
  storage.setItem(
    `judo.roster.pending.${tournamentId}`,
    JSON.stringify({
      ...pending,
      athleteSnapshot: { ...pending.athleteSnapshot, id: sourceAthleteId },
    }),
  );
  assert.throws(() => readPendingRoster(storage, tournamentId), /ROSTER_STORAGE_INVALID/);
  assert.ok(storage.getItem(`judo.roster.pending.${tournamentId}`));
});
