import { ApiError } from '../tournaments/api.ts';
import type {
  ClubReceipt,
  DraftRow,
  Receipt,
  RosterEntryInput,
  RosterReceipt,
  SavedEntry,
  AthleteDisplay,
} from './roster-model';
import { entryInputs, isUuid, validSavedEntry, validCategoryIds } from './roster-model.ts';
import { validDraftRows } from './roster-storage.ts';
import { validAthleteDisplay } from './athlete-model.ts';
import {
  nameReceiptPreservesEntry,
  normalizeEntryName,
  validNameCorrectionPayload,
  type NameCorrectionPayload,
} from './entry-name-model.ts';
type Base = { tournamentId: string };
export type PendingRosterCommand =
  | (Base & { kind: 'club'; payload: { id: string; expectedRevision: number; name: string } })
  | (Base & {
      kind: 'roster';
      draftRows: DraftRow[];
      payload: {
        id: string;
        expectedRevision: number;
        clubId: string;
        entries: RosterEntryInput[];
      };
    })
  | (Base & {
      kind: 'name';
      entryId: string;
      entrySnapshot: SavedEntry;
      payload: NameCorrectionPayload;
    })
  | (Base & {
      kind: 'identity';
      entryId: string;
      entrySnapshot: SavedEntry;
      athleteSnapshot: { id: string; display: AthleteDisplay };
      payload: { id: string; expectedRevision: number; athleteId: string; reason: string };
    })
  | (Base & {
      kind: 'update';
      entryId: string;
      entrySnapshot: SavedEntry;
      payload: RosterEntryInput & {
        id: string;
        expectedRevision: number;
        reason: string;
        clubId: string;
      };
    })
  | (Base & {
      kind: 'archive' | 'restore';
      entryId: string;
      entrySnapshot: SavedEntry;
      payload: {
        id: string;
        expectedRevision: number;
        reason: string;
        duplicateConfirmed?: boolean;
      };
    });
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (id: string) => `judo.roster.pending.${id}`;
export function readPendingRoster(store: Store, tournamentId: string): PendingRosterCommand | null {
  const raw = store.getItem(key(tournamentId));
  if (!raw) return null;
  let value: PendingRosterCommand;
  try {
    value = JSON.parse(raw) as PendingRosterCommand;
  } catch {
    throw new Error('ROSTER_STORAGE_INVALID');
  }
  if (
    !value ||
    value.tournamentId !== tournamentId ||
    !['club', 'roster', 'update', 'archive', 'restore', 'identity', 'name'].includes(value.kind) ||
    !value.payload ||
    typeof value.payload.id !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.payload.id) ||
    !Number.isSafeInteger(value.payload.expectedRevision) ||
    value.payload.expectedRevision < 0 ||
    (value.kind === 'club' && typeof value.payload.name !== 'string') ||
    (value.kind === 'roster' &&
      (!Array.isArray(value.payload.entries) ||
        !value.payload.entries.length ||
        value.payload.entries.length > 500 ||
        typeof value.payload.clubId !== 'string' ||
        !validDraftRows(value.draftRows) ||
        value.draftRows.length !== value.payload.entries.length)) ||
    ((value.kind === 'update' ||
      value.kind === 'archive' ||
      value.kind === 'restore' ||
      value.kind === 'identity' ||
      value.kind === 'name') &&
      (!isUuid(value.entryId) ||
        !validSavedEntry(value.entrySnapshot) ||
        value.entrySnapshot.id !== value.entryId ||
        typeof value.payload.reason !== 'string' ||
        value.payload.reason.trim().length < 3 ||
        value.payload.reason.length > 500 ||
        (value.kind === 'restore'
          ? value.entrySnapshot.archivedAt === null
          : value.entrySnapshot.archivedAt !== null) ||
        (value.kind === 'update' && !validCorrectionInput(value.payload)) ||
        (value.kind === 'name' && !validNameCorrectionPayload(value.payload)) ||
        (value.kind === 'identity' &&
          (!isUuid(value.payload.athleteId) ||
            !isUuid(value.entrySnapshot.athleteId) ||
            value.entrySnapshot.athleteId === value.payload.athleteId ||
            value.athleteSnapshot?.id !== value.payload.athleteId ||
            !validAthleteDisplay(value.athleteSnapshot?.display))) ||
        ('duplicateConfirmed' in value.payload &&
          value.payload.duplicateConfirmed !== undefined &&
          typeof value.payload.duplicateConfirmed !== 'boolean')))
  )
    throw new Error('ROSTER_STORAGE_INVALID');
  if (
    value.kind === 'roster' &&
    JSON.stringify(entryInputs(value.draftRows)) !== JSON.stringify(value.payload.entries)
  )
    throw new Error('ROSTER_STORAGE_INVALID');
  return value;
}
function validCorrectionInput(value: RosterEntryInput & { clubId: string }): boolean {
  return (
    value.athleteId === undefined &&
    isUuid(value.clubId) &&
    isUuid(value.categoryId) &&
    [value.firstName, value.lastName].every(
      (name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 80,
    ) &&
    Number.isInteger(value.birthYear) &&
    value.birthYear >= 1900 &&
    value.birthYear <= 2100 &&
    ['MALE', 'FEMALE'].includes(value.gender)
  );
}
const cleanName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
function validCorrectionReceipt(
  command: Extract<PendingRosterCommand, { entryId: string }>,
  receipt: Receipt,
): boolean {
  if (
    !('entry' in receipt) ||
    !validSavedEntry(receipt.entry) ||
    receipt.entry.id !== command.entryId ||
    !validCategoryIds(receipt.invalidatedCategoryIds)
  )
    return false;
  const entry = receipt.entry;
  if (command.kind === 'name')
    return (
      receipt.invalidatedCategoryIds.length === 0 &&
      nameReceiptPreservesEntry(command.entrySnapshot, entry) &&
      entry.firstName === normalizeEntryName(command.payload.firstName) &&
      entry.lastName === normalizeEntryName(command.payload.lastName)
    );
  if (command.kind === 'identity')
    return (
      entry.athleteId === command.payload.athleteId &&
      entry.archivedAt === null &&
      entry.categoryId === command.entrySnapshot.categoryId &&
      entry.clubId === command.entrySnapshot.clubId &&
      entry.club === command.entrySnapshot.club &&
      entry.birthYear === command.entrySnapshot.birthYear &&
      entry.firstName === command.entrySnapshot.firstName &&
      entry.lastName === command.entrySnapshot.lastName &&
      (command.entrySnapshot.gender === null || entry.gender === command.entrySnapshot.gender)
    );
  if (
    command.entrySnapshot.athleteId !== undefined &&
    entry.athleteId !== command.entrySnapshot.athleteId
  )
    return false;
  if (command.kind === 'update')
    return (
      entry.archivedAt === null &&
      entry.categoryId === command.payload.categoryId &&
      entry.clubId === command.payload.clubId &&
      entry.gender === command.payload.gender &&
      entry.birthYear === command.payload.birthYear &&
      entry.firstName === cleanName(command.payload.firstName) &&
      entry.lastName === cleanName(command.payload.lastName)
    );
  return (
    (command.kind === 'archive' ? entry.archivedAt !== null : entry.archivedAt === null) &&
    entry.categoryId === command.entrySnapshot.categoryId &&
    entry.clubId === command.entrySnapshot.clubId &&
    entry.birthYear === command.entrySnapshot.birthYear &&
    entry.firstName === command.entrySnapshot.firstName &&
    entry.lastName === command.entrySnapshot.lastName
  );
}
export function savePendingRoster(store: Store, command: PendingRosterCommand): void {
  if (
    command.kind === 'name' &&
    (!isUuid(command.entryId) ||
      !validSavedEntry(command.entrySnapshot) ||
      command.entrySnapshot.id !== command.entryId ||
      command.entrySnapshot.archivedAt !== null ||
      !validNameCorrectionPayload(command.payload))
  )
    throw new Error('ROSTER_STORAGE_INVALID');
  const existing = readPendingRoster(store, command.tournamentId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(command))
    throw new Error('ROSTER_PENDING_EXISTS');
  store.setItem(key(command.tournamentId), JSON.stringify(command));
}
export function clearPendingRoster(store: Store, command: PendingRosterCommand): void {
  const existing = readPendingRoster(store, command.tournamentId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(command))
    throw new Error('ROSTER_PENDING_EXISTS');
  store.removeItem(key(command.tournamentId));
}
/** Download the stored original, not a packet reconstructed with a newer revision. */
export function pendingRosterJson(store: Store, tournamentId: string): string {
  if (!readPendingRoster(store, tournamentId)) throw new Error('ROSTER_STORAGE_INVALID');
  return store.getItem(key(tournamentId))!;
}
export async function deliverRosterCommand(
  command: PendingRosterCommand,
  send: (path: string, payload: unknown) => Promise<Receipt>,
): Promise<{ kind: 'success'; receipt: Receipt } | { kind: 'retry' | 'rejected'; error: unknown }> {
  try {
    const receipt = await send(
      `/tournaments/${command.tournamentId}/${command.kind === 'club' ? 'clubs' : command.kind === 'roster' ? 'roster' : `roster/entries/${command.entryId}/${command.kind}`}`,
      structuredClone(command.payload),
    );
    if (
      !Number.isSafeInteger(receipt?.revision) ||
      receipt.revision <= command.payload.expectedRevision ||
      (command.kind === 'club'
        ? !('club' in receipt) ||
          !(receipt as ClubReceipt).club?.id ||
          typeof receipt.club.name !== 'string' ||
          !Number.isSafeInteger(receipt.club._count?.entries)
        : command.kind === 'roster'
          ? !('entries' in receipt) ||
            (receipt as RosterReceipt).clubId !== command.payload.clubId ||
            !Array.isArray(receipt.entries) ||
            receipt.entries.length !== command.payload.entries.length ||
            receipt.entries.some(
              (entry, index) =>
                !entry?.id ||
                (entry.athleteId !== undefined && !isUuid(entry.athleteId)) ||
                (command.payload.entries[index].athleteId !== undefined &&
                  entry.athleteId !== command.payload.entries[index].athleteId) ||
                entry.clubId !== command.payload.clubId ||
                entry.categoryId !== command.payload.entries[index].categoryId ||
                entry.gender !== command.payload.entries[index].gender,
            )
          : !validCorrectionReceipt(command, receipt))
    )
      throw new Error('ROSTER_RESPONSE_INVALID');
    return { kind: 'success', receipt };
  } catch (error) {
    // Auth can expire after a previous delivery applied. Keep the exact name packet until its
    // receipt or a definite validation rejection is known, including after a reload.
    const rejected =
      error instanceof ApiError &&
      (command.kind === 'name'
        ? [400, 404, 409].includes(error.status) && error.message !== 'COMMAND_ID_REUSED'
        : error.status < 500);
    return { kind: rejected ? 'rejected' : 'retry', error };
  }
}
