import { isDefinitiveCommandRejection } from '../tournaments/api.ts';
export type WithdrawalPayload = {
  id: string;
  entryId: string;
  expectedVersion: number;
  impactToken: string;
  reason: string;
};
export type PendingWithdrawal = {
  tournamentId: string;
  categoryId: string;
  drawId: string;
  payload: WithdrawalPayload;
};
export type WithdrawalReceipt = {
  drawId: string;
  version: number;
  entryId: string;
  changedContestIds: string[];
};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (id: string) => `judo.withdrawal.pending.${id}`;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function readPendingWithdrawal(
  store: Store,
  tournamentId: string,
): PendingWithdrawal | null {
  const raw = store.getItem(key(tournamentId));
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingWithdrawal;
  const p = value?.payload;
  if (
    !value ||
    value.tournamentId !== tournamentId ||
    !uuid.test(value.categoryId) ||
    !uuid.test(value.drawId) ||
    !p ||
    !uuid.test(p.id) ||
    !uuid.test(p.entryId) ||
    !Number.isSafeInteger(p.expectedVersion) ||
    p.expectedVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(p.impactToken) ||
    typeof p.reason !== 'string' ||
    p.reason.trim().length < 3 ||
    p.reason.trim().length > 500
  )
    throw new Error('WITHDRAWAL_PENDING_CORRUPT');
  return value;
}
export function savePendingWithdrawal(store: Store, value: PendingWithdrawal) {
  const previous = readPendingWithdrawal(store, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('WITHDRAWAL_PENDING_EXISTS');
  store.setItem(key(value.tournamentId), JSON.stringify(value));
}
export function clearPendingWithdrawal(store: Store, value: PendingWithdrawal) {
  const previous = readPendingWithdrawal(store, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('WITHDRAWAL_PENDING_EXISTS');
  store.removeItem(key(value.tournamentId));
}
export async function deliverPendingWithdrawal(
  value: PendingWithdrawal,
  send: (categoryId: string, payload: WithdrawalPayload) => Promise<WithdrawalReceipt>,
) {
  try {
    const receipt = await send(value.categoryId, structuredClone(value.payload));
    if (
      receipt.drawId !== value.drawId ||
      receipt.entryId !== value.payload.entryId ||
      !Number.isSafeInteger(receipt.version) ||
      receipt.version <= value.payload.expectedVersion ||
      !Array.isArray(receipt.changedContestIds)
    )
      throw new Error('WITHDRAWAL_RESPONSE_INVALID');
    return { kind: 'success' as const, receipt };
  } catch (error) {
    return {
      kind: isDefinitiveCommandRejection(error) ? ('rejected' as const) : ('retry' as const),
      error,
    };
  }
}
