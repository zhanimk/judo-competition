import { isDefinitiveCommandRejection } from '../tournaments/api.ts';

type Intent =
  | { operation: 'preview'; payload: { id: string; expectedVersion: number } }
  | { operation: 'confirm'; payload: { id: string; version: number } }
  | {
      operation: 'publication';
      payload: { id: string; expectedRevision: number; published: boolean };
    };
export type PendingDraw = Intent & { tournamentId: string; categoryId: string };
export type DrawReceipt = {
  id: string;
  categoryId: string;
  version: number;
  status: string;
  publicationRevision: number;
  publishedAt: string | null;
  snapshot: object;
  contests: unknown[];
};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (tournamentId: string) => `judo.draw.pending.${tournamentId}`;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const revision = (value: unknown, min: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
export function readPendingDraw(storage: Store, tournamentId: string): PendingDraw | null {
  const raw = storage.getItem(key(tournamentId));
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingDraw;
  if (
    !value ||
    value.tournamentId !== tournamentId ||
    !uuid.test(value.categoryId) ||
    !value.payload ||
    !uuid.test(value.payload.id) ||
    !(
      (value.operation === 'preview' && revision(value.payload.expectedVersion, 0)) ||
      (value.operation === 'confirm' && revision(value.payload.version, 1)) ||
      (value.operation === 'publication' &&
        revision(value.payload.expectedRevision, 0) &&
        typeof value.payload.published === 'boolean')
    )
  )
    throw new Error('DRAW_PENDING_CORRUPT');
  return value;
}
export function savePendingDraw(storage: Store, value: PendingDraw) {
  const previous = readPendingDraw(storage, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('DRAW_PENDING_EXISTS');
  storage.setItem(key(value.tournamentId), JSON.stringify(value));
}
export function clearPendingDraw(storage: Store, value: PendingDraw) {
  const previous = readPendingDraw(storage, value.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('DRAW_PENDING_EXISTS');
  storage.removeItem(key(value.tournamentId));
}
export async function deliverPendingDraw(
  value: PendingDraw,
  send: (path: string, payload: PendingDraw['payload']) => Promise<DrawReceipt>,
) {
  try {
    const receipt = await send(
      `/categories/${value.categoryId}/draw/${value.operation}`,
      structuredClone(value.payload),
    );
    if (
      !receipt ||
      !uuid.test(receipt.id) ||
      receipt.categoryId !== value.categoryId ||
      !revision(receipt.version, 1) ||
      !revision(receipt.publicationRevision, 0) ||
      !receipt.snapshot ||
      !Array.isArray(receipt.contests) ||
      (value.operation === 'preview' &&
        (receipt.status !== 'PREVIEW' || receipt.version !== value.payload.expectedVersion + 1)) ||
      (value.operation === 'confirm' &&
        (receipt.status !== 'CONFIRMED' || receipt.version !== value.payload.version)) ||
      (value.operation === 'publication' &&
        (receipt.status !== 'CONFIRMED' ||
          !!receipt.publishedAt !== value.payload.published ||
          receipt.publicationRevision < value.payload.expectedRevision))
    )
      throw new Error('DRAW_RESPONSE_INVALID');
    return { kind: 'success' as const };
  } catch (error) {
    return {
      kind: isDefinitiveCommandRejection(error) ? ('rejected' as const) : ('retry' as const),
      error,
    };
  }
}
