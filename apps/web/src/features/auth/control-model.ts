import type { QueueItem } from '../tatamis/queue-view';

export type ControlGrant = { deviceId: string; controlGeneration: number };
export type ControlSnapshot = {
  generation: number;
  held: boolean;
  owned: boolean;
  holderName: string | null;
  holderValid: boolean;
  acquiredAt: string | null;
};
export type ControlContext = {
  tatamiId: string;
  tournamentId: string;
  number: number;
  tournamentName: string;
  operatorName: string;
  role: string;
  workRole: 'ADMIN' | 'JUDGE';
  matchCommandsAvailable: boolean;
  accessRevision: number;
  control: ControlSnapshot;
  queue: (QueueItem & { revision: number })[];
};
export type ControlCommand = {
  id: string;
  expectedRevision: number;
  deviceId: string;
  type: 'CLAIM' | 'RELEASE' | 'TAKEOVER';
  reason?: string;
};
export type ControlReceipt = { revision: number; control: ControlSnapshot };
export type PendingControl = { tatamiId: string; command: ControlCommand };
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
export const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export function isControlSnapshot(value: unknown): value is ControlSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as ControlSnapshot;
  return (
    isRevision(s.generation) &&
    typeof s.held === 'boolean' &&
    typeof s.owned === 'boolean' &&
    typeof s.holderValid === 'boolean' &&
    (s.holderName === null || typeof s.holderName === 'string') &&
    (s.acquiredAt === null || typeof s.acquiredAt === 'string') &&
    (!s.owned || s.held)
  );
}
export function controlGrant(context: ControlContext | null, deviceId: string | null) {
  return context &&
    isUuid(deviceId) &&
    context.control.held &&
    context.control.owned &&
    context.control.holderValid
    ? { deviceId, controlGeneration: context.control.generation }
    : null;
}
export function sameGrant(left: ControlGrant | null | undefined, right: ControlGrant | null) {
  return (
    !!left &&
    !!right &&
    left.deviceId === right.deviceId &&
    left.controlGeneration === right.controlGeneration
  );
}
export function isGrant(value: unknown): value is ControlGrant {
  const g = value as ControlGrant | null;
  return !!g && isUuid(g.deviceId) && isRevision(g.controlGeneration);
}
export function restoreControlPending(raw: string, tatamiId: string): PendingControl {
  const p = JSON.parse(raw) as PendingControl;
  const c = p?.command;
  if (
    p?.tatamiId !== tatamiId ||
    !isUuid(c?.id) ||
    !isUuid(c?.deviceId) ||
    !isRevision(c?.expectedRevision) ||
    !['CLAIM', 'RELEASE', 'TAKEOVER'].includes(c?.type) ||
    Object.keys(p).some((key) => !['tatamiId', 'command'].includes(key)) ||
    Object.keys(c).some(
      (key) => !['id', 'expectedRevision', 'deviceId', 'type', 'reason'].includes(key),
    ) ||
    (c.type === 'TAKEOVER' && c.reason === undefined) ||
    (c.reason !== undefined &&
      (typeof c.reason !== 'string' || c.reason.trim().length < 3 || c.reason.length > 500))
  )
    throw new Error('SAVED_CONTROL_INVALID');
  return structuredClone(p);
}
export function applyControlReceipt(context: ControlContext | null, receipt: ControlReceipt) {
  if (!isRevision(receipt?.revision) || !isControlSnapshot(receipt?.control))
    throw new Error('INVALID_CONTROL_RECEIPT');
  if (!context || receipt.revision < context.accessRevision) return context;
  return { ...context, accessRevision: receipt.revision, control: receipt.control };
}
export function retainUncertainCommand(status: number | undefined, code: string) {
  return (
    status === undefined ||
    status >= 500 ||
    status === 401 ||
    status === 403 ||
    ['CONTROL_REQUIRED', 'CONTROL_GENERATION_STALE', 'INVITATION_REVOKED'].includes(code)
  );
}
