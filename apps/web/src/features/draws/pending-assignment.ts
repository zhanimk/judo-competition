import { isDefinitiveCommandRejection } from '../tournaments/api.ts';

export type AssignmentPayload = {
  id: string;
  expectedRevision: number;
  tatamiId: string;
};
export type PendingAssignment = {
  tournamentId: string;
  categoryId: string;
  contestId: string;
  payload: AssignmentPayload;
};
export type AssignmentReceipt = {
  id: string;
  revision: number;
  status: 'READY';
  tatamiId: string;
  queueOrder: number | null;
  updatedAt: string;
};
type AssignmentStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const prefix = (tournamentId: string) => `judo.assign.pending.${tournamentId}.`;
const storageKey = (pending: PendingAssignment) =>
  `${prefix(pending.tournamentId)}${pending.categoryId}.${pending.contestId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readPendingAssignment(
  storage: AssignmentStorage,
  tournamentId: string,
): PendingAssignment | null {
  let found: PendingAssignment | null = null;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix(tournamentId))) continue;
    const pending = JSON.parse(storage.getItem(key) ?? 'null') as PendingAssignment | null;
    if (
      !pending ||
      pending.tournamentId !== tournamentId ||
      !uuid.test(pending.categoryId) ||
      !uuid.test(pending.contestId) ||
      !pending.payload ||
      !uuid.test(pending.payload.id) ||
      !uuid.test(pending.payload.tatamiId) ||
      !Number.isSafeInteger(pending.payload.expectedRevision) ||
      pending.payload.expectedRevision < 0 ||
      storageKey(pending) !== key ||
      found
    )
      throw new Error('ASSIGN_PENDING_CORRUPT');
    found = pending;
  }
  return found;
}

/** Persist before sending. An unresolved command cannot be replaced with a new revision or ID. */
export function savePendingAssignment(
  storage: AssignmentStorage,
  pending: PendingAssignment,
): void {
  const previous = readPendingAssignment(storage, pending.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(pending))
    throw new Error('ASSIGN_PENDING_EXISTS');
  storage.setItem(storageKey(pending), JSON.stringify(pending));
}

export function clearPendingAssignment(
  storage: AssignmentStorage,
  pending: PendingAssignment,
): void {
  const previous = readPendingAssignment(storage, pending.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(pending))
    throw new Error('ASSIGN_PENDING_EXISTS');
  storage.removeItem(storageKey(pending));
}

export async function deliverPendingAssignment(
  pending: PendingAssignment,
  send: (contestId: string, payload: AssignmentPayload) => Promise<AssignmentReceipt>,
): Promise<
  { kind: 'success'; receipt: AssignmentReceipt } | { kind: 'rejected' | 'retry'; error: unknown }
> {
  try {
    const receipt = await send(pending.contestId, { ...pending.payload });
    if (
      receipt.id !== pending.contestId ||
      receipt.tatamiId !== pending.payload.tatamiId ||
      receipt.status !== 'READY' ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision <= pending.payload.expectedRevision
    )
      throw new Error('ASSIGN_RESPONSE_INVALID');
    return { kind: 'success', receipt };
  } catch (error) {
    return {
      kind: isDefinitiveCommandRejection(error) ? 'rejected' : 'retry',
      error,
    };
  }
}

/** A replayed receipt must not undo a subsequent start, transfer or administrative correction. */
export function mergeAssignmentReceipt<T extends { id: string; revision: number }>(
  contests: T[],
  receipt: AssignmentReceipt,
): T[] {
  const current = contests.find((contest) => contest.id === receipt.id);
  if (!current || current.revision >= receipt.revision) return contests;
  return contests.map((contest) =>
    contest.id === receipt.id ? { ...contest, ...receipt } : contest,
  );
}
