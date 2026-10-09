import { ApiError } from '../tournaments/api.ts';
import type {
  ClubReceipt,
  DraftRow,
  Receipt,
  RosterEntryInput,
  RosterReceipt,
  SavedEntry,
} from './roster-model';
import { entryInputs, isUuid, validSavedEntry, validCategoryIds } from './roster-model.ts';
import { validDraftRows } from './roster-storage.ts';
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
    !['club', 'roster', 'update', 'archive', 'restore'].includes(value.kind) ||
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
    ((value.kind === 'update' || value.kind === 'archive' || value.kind === 'restore') &&
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
                entry.clubId !== command.payload.clubId ||
                entry.categoryId !== command.payload.entries[index].categoryId ||
                entry.gender !== command.payload.entries[index].gender,
            )
          : !validCorrectionReceipt(command, receipt))
    )
      throw new Error('ROSTER_RESPONSE_INVALID');
    return { kind: 'success', receipt };
  } catch (error) {
    return { kind: error instanceof ApiError && error.status < 500 ? 'rejected' : 'retry', error };
  }
}
