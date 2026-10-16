import { isDefinitiveCommandRejection } from '../tournaments/api.ts';

export type TiebreakPayload = {
  id: string;
  expectedVersion: number;
  impactToken: string;
  reason: string;
  procedure: 'ROUND_ROBIN' | 'ORDERED_PLACES';
  parent: string;
  pool?: string;
  members: string[];
};
export type PendingTiebreak = {
  tournamentId: string;
  categoryId: string;
  drawId: string;
  payload: TiebreakPayload;
};
export type TiebreakReceipt = {
  drawId: string;
  version: number;
  addedContestIds: string[];
  changedContestIds: string[];
};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (tournamentId: string) => `judo.tiebreak.pending.${tournamentId}`;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function readPendingTiebreak(storage: Store, tournamentId: string): PendingTiebreak | null {
  const raw = storage.getItem(key(tournamentId));
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingTiebreak;
  const p = value?.payload;
  if (
    !value ||
    value.tournamentId !== tournamentId ||
    !uuid.test(value.categoryId) ||
    !uuid.test(value.drawId) ||
    !p ||
    !uuid.test(p.id) ||
    !Number.isSafeInteger(p.expectedVersion) ||
    p.expectedVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(p.impactToken) ||
    !['ROUND_ROBIN', 'ORDERED_PLACES'].includes(p.procedure) ||
    typeof p.reason !== 'string' ||
    p.reason.trim().length < 3 ||
    p.reason.trim().length > 1000 ||
    typeof p.parent !== 'string' ||
    !p.parent ||
    (p.pool !== undefined && typeof p.pool !== 'string') ||
    !Array.isArray(p.members) ||
    p.members.length < 3 ||
    p.members.length > 128 ||
    p.members.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
    new Set(p.members).size !== p.members.length
  )
    throw new Error('TIEBREAK_PENDING_CORRUPT');
  return value;
}
export function savePendingTiebreak(storage: Store, value: PendingTiebreak) {
  const previous = readPendingTiebreak(storage, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('TIEBREAK_PENDING_EXISTS');
  storage.setItem(key(value.tournamentId), JSON.stringify(value));
}
export function clearPendingTiebreak(storage: Store, value: PendingTiebreak) {
  const previous = readPendingTiebreak(storage, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('TIEBREAK_PENDING_EXISTS');
  storage.removeItem(key(value.tournamentId));
}
export async function deliverPendingTiebreak(
  value: PendingTiebreak,
  send: (categoryId: string, payload: TiebreakPayload) => Promise<TiebreakReceipt>,
) {
  try {
    const receipt = await send(value.categoryId, structuredClone(value.payload));
    if (
      receipt.drawId !== value.drawId ||
      !Number.isSafeInteger(receipt.version) ||
      receipt.version <= value.payload.expectedVersion ||
      !Array.isArray(receipt.addedContestIds) ||
      (value.payload.procedure === 'ROUND_ROBIN' && !receipt.addedContestIds.length) ||
      !Array.isArray(receipt.changedContestIds)
    )
      throw new Error('TIEBREAK_RESPONSE_INVALID');
    return { kind: 'success' as const, receipt };
  } catch (error) {
    return {
      kind: isDefinitiveCommandRejection(error) ? ('rejected' as const) : ('retry' as const),
      error,
    };
  }
}
