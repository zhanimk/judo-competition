import { ApiError } from '../tournaments/api.ts';
import type {
  ClubReceipt,
  DraftRow,
  Receipt,
  RosterEntryInput,
  RosterReceipt,
} from './roster-model';
import { entryInputs } from './roster-model.ts';
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
    !['club', 'roster'].includes(value.kind) ||
    !value.payload ||
    typeof value.payload.id !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.payload.id) ||
    !Number.isSafeInteger(value.payload.expectedRevision) ||
    value.payload.expectedRevision < 0 ||
    (value.kind === 'club'
      ? typeof value.payload.name !== 'string'
      : !Array.isArray(value.payload.entries) ||
        !value.payload.entries.length ||
        value.payload.entries.length > 500 ||
        typeof value.payload.clubId !== 'string' ||
        !validDraftRows(value.draftRows) ||
        value.draftRows.length !== value.payload.entries.length)
  )
    throw new Error('ROSTER_STORAGE_INVALID');
  if (
    value.kind === 'roster' &&
    JSON.stringify(entryInputs(value.draftRows)) !== JSON.stringify(value.payload.entries)
  )
    throw new Error('ROSTER_STORAGE_INVALID');
  return value;
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
      `/tournaments/${command.tournamentId}/${command.kind === 'club' ? 'clubs' : 'roster'}`,
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
        : !('entries' in receipt) ||
          (receipt as RosterReceipt).clubId !== command.payload.clubId ||
          !Array.isArray(receipt.entries) ||
          receipt.entries.length !== command.payload.entries.length ||
          receipt.entries.some(
            (entry, index) =>
              !entry?.id ||
              entry.clubId !== command.payload.clubId ||
              entry.categoryId !== command.payload.entries[index].categoryId ||
              entry.gender !== command.payload.entries[index].gender,
          ))
    )
      throw new Error('ROSTER_RESPONSE_INVALID');
    return { kind: 'success', receipt };
  } catch (error) {
    return { kind: error instanceof ApiError && error.status < 500 ? 'rejected' : 'retry', error };
  }
}
