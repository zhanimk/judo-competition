import { isDefinitiveCommandRejection } from './api.ts';
export type AdministrationOperation = 'CREATE' | 'CATEGORY' | 'START' | 'SCHEDULE' | 'PUBLISH';
export type AdministrationPending = {
  scope: string;
  operation: AdministrationOperation;
  payload: { id: string; expectedRevision?: number; [field: string]: unknown };
};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (scope: string) => `judo.administration.pending.${scope}`;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function readAdministrationPending(
  store: Store,
  scope: string,
): AdministrationPending | null {
  const raw = store.getItem(key(scope));
  if (raw === null) return null;
  const value = JSON.parse(raw) as AdministrationPending;
  if (
    !value ||
    value.scope !== scope ||
    !['CREATE', 'CATEGORY', 'START', 'SCHEDULE', 'PUBLISH'].includes(value.operation) ||
    !value.payload ||
    !uuid.test(value.payload.id) ||
    (value.operation === 'CREATE'
      ? scope !== 'new' || value.payload.expectedRevision !== undefined
      : !uuid.test(scope) ||
        !Number.isSafeInteger(value.payload.expectedRevision) ||
        value.payload.expectedRevision! < 0)
  )
    throw new Error('ADMINISTRATION_PENDING_CORRUPT');
  return value;
}
export function saveAdministrationPending(store: Store, value: AdministrationPending) {
  const previous = readAdministrationPending(store, value.scope);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('ADMINISTRATION_PENDING_EXISTS');
  store.setItem(key(value.scope), JSON.stringify(value));
}
export function clearAdministrationPending(store: Store, value: AdministrationPending) {
  const previous = readAdministrationPending(store, value.scope);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('ADMINISTRATION_PENDING_EXISTS');
  store.removeItem(key(value.scope));
}
export function administrationPath(value: AdministrationPending) {
  return value.operation === 'CREATE'
    ? '/tournaments'
    : `/tournaments/${value.scope}/${{ CATEGORY: 'categories', START: 'start', SCHEDULE: 'schedule', PUBLISH: 'publish' }[value.operation]}`;
}
export async function deliverAdministrationPending(
  value: AdministrationPending,
  send: (
    path: string,
    payload: AdministrationPending['payload'],
  ) => Promise<Record<string, unknown>>,
) {
  try {
    const receipt = await send(administrationPath(value), structuredClone(value.payload));
    const revision = receipt.administrationRevision;
    if (
      !Number.isSafeInteger(revision) ||
      (value.operation === 'CREATE'
        ? (revision as number) < 0 || typeof receipt.id !== 'string' || !uuid.test(receipt.id)
        : (revision as number) <= value.payload.expectedRevision!)
    )
      throw new Error('ADMINISTRATION_RESPONSE_INVALID');
    if (
      value.operation === 'CATEGORY' &&
      (typeof receipt.id !== 'string' || !uuid.test(receipt.id))
    )
      throw new Error('ADMINISTRATION_RESPONSE_INVALID');
    if (value.operation === 'START' && !['RUNNING', 'FINISHED'].includes(receipt.status as string))
      throw new Error('ADMINISTRATION_RESPONSE_INVALID');
    if (value.operation === 'SCHEDULE' && !Array.isArray(receipt.assignments))
      throw new Error('ADMINISTRATION_RESPONSE_INVALID');
    if (
      value.operation === 'PUBLISH' &&
      (receipt.id !== value.scope ||
        typeof receipt.publishedAt !== 'string' ||
        !Number.isFinite(Date.parse(receipt.publishedAt)))
    )
      throw new Error('ADMINISTRATION_RESPONSE_INVALID');
    return { kind: 'success' as const, receipt };
  } catch (error) {
    return {
      kind: isDefinitiveCommandRejection(error) ? ('rejected' as const) : ('retry' as const),
      error,
    };
  }
}
