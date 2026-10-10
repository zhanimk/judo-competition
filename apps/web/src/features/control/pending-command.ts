import type { MatchState } from '@judo/engine/match';
import { isRevision, isUuid } from '../auth/control-model.ts';
import { ApiError } from '../tournaments/api.ts';

export type AdminAction = 'MOVE' | 'RESET' | 'REOPEN' | 'REMOVE' | 'RELEASE_OFFLINE' | 'EDIT_TIME';
type CommandBase = {
  id: string;
  expectedRevision: number;
  impactToken: string;
  reason: string;
};
export type AdminCommandPayload = CommandBase &
  (
    | { type: 'MOVE'; tatamiId: string }
    | { type: 'EDIT_TIME'; phase: 'REGULAR' | 'GOLDEN'; elapsedMs: number }
    | { type: Exclude<AdminAction, 'MOVE' | 'EDIT_TIME'> }
  );
export type PendingAdminCommand = {
  tournamentId: string;
  contestId: string;
  payload: AdminCommandPayload;
  review: {
    key: string;
    category: string;
    white: string;
    blue: string;
    targetNumber?: number;
    dependent?: { id: string; key: string; status: string }[];
  };
};
export type AdminReceipt = {
  ok: true;
  contestId?: string;
  revision?: number;
  state?: MatchState;
  controlGeneration?: number;
};
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const adminPendingKey = (tournamentId: string) =>
  `judo.admin-control.pending.${tournamentId}`;
const boundedText = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max;

/** Never rebuild an unresolved command using a newer revision, impact plan or timer value. */
export function restoreAdminPending(raw: string, tournamentId: string): PendingAdminCommand {
  const p = JSON.parse(raw) as PendingAdminCommand;
  const body = p?.payload;
  const fields = ['id', 'expectedRevision', 'impactToken', 'reason', 'type'];
  if (body?.type === 'MOVE') fields.push('tatamiId');
  if (body?.type === 'EDIT_TIME') fields.push('phase', 'elapsedMs');
  if (
    !isUuid(tournamentId) ||
    p?.tournamentId !== tournamentId ||
    !isUuid(p?.contestId) ||
    !isUuid(body?.id) ||
    !isRevision(body?.expectedRevision) ||
    !/^[a-f0-9]{64}$/i.test(body?.impactToken ?? '') ||
    !boundedText(body?.reason, 300) ||
    body.reason.trim().length < 3 ||
    body.reason !== body.reason.trim() ||
    !['MOVE', 'RESET', 'REOPEN', 'REMOVE', 'RELEASE_OFFLINE', 'EDIT_TIME'].includes(body?.type) ||
    Object.keys(body).some((field) => !fields.includes(field)) ||
    (body.type === 'MOVE' && !isUuid(body.tatamiId)) ||
    (body.type === 'EDIT_TIME' &&
      (!['REGULAR', 'GOLDEN'].includes(body.phase) ||
        !Number.isSafeInteger(body.elapsedMs) ||
        body.elapsedMs < 0 ||
        body.elapsedMs % 100 !== 0)) ||
    !p.review ||
    !boundedText(p.review.key, 100) ||
    !boundedText(p.review.category, 500) ||
    !boundedText(p.review.white, 500) ||
    !boundedText(p.review.blue, 500) ||
    (p.review.targetNumber !== undefined &&
      (!Number.isSafeInteger(p.review.targetNumber) || p.review.targetNumber < 1)) ||
    (p.review.dependent !== undefined &&
      (!Array.isArray(p.review.dependent) ||
        p.review.dependent.length > 1000 ||
        p.review.dependent.some(
          (row) => !isUuid(row?.id) || !boundedText(row?.key, 100) || !boundedText(row?.status, 30),
        )))
  )
    throw new Error('ADMIN_PENDING_CORRUPT');
  return structuredClone(p);
}

export function readAdminPending(storage: CommandStorage, tournamentId: string) {
  const raw = storage.getItem(adminPendingKey(tournamentId));
  return raw === null ? null : restoreAdminPending(raw, tournamentId);
}

export function saveAdminPending(storage: CommandStorage, pending: PendingAdminCommand) {
  const value = restoreAdminPending(JSON.stringify(pending), pending.tournamentId);
  const previous = readAdminPending(storage, pending.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error('ADMIN_PENDING_EXISTS');
  storage.setItem(adminPendingKey(pending.tournamentId), JSON.stringify(value));
}

export function clearAdminPending(storage: CommandStorage, pending: PendingAdminCommand) {
  const previous = readAdminPending(storage, pending.tournamentId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(pending))
    throw new Error('ADMIN_PENDING_EXISTS');
  storage.removeItem(adminPendingKey(pending.tournamentId));
}

export function validateAdminReceipt(pending: PendingAdminCommand, value: unknown): AdminReceipt {
  const receipt = value as AdminReceipt;
  if (
    receipt?.ok !== true ||
    (pending.payload.type === 'EDIT_TIME' &&
      (receipt.contestId !== pending.contestId ||
        !isRevision(receipt.revision) ||
        receipt.revision! <= pending.payload.expectedRevision ||
        !isRevision(receipt.controlGeneration) ||
        !receipt.state ||
        receipt.state.phase !== pending.payload.phase ||
        (pending.payload.phase === 'REGULAR' ? receipt.state.elapsedMs : receipt.state.goldenMs) !==
          pending.payload.elapsedMs))
  )
    throw new Error('ADMIN_RECEIPT_INVALID');
  return receipt;
}

export async function deliverAdminPending(
  pending: PendingAdminCommand,
  send: (contestId: string, payload: AdminCommandPayload) => Promise<unknown>,
): Promise<
  { kind: 'success'; receipt: AdminReceipt } | { kind: 'retry' | 'rejected'; error: unknown }
> {
  try {
    // Even a transport adapter must not be able to alter the saved retry packet.
    const receipt = validateAdminReceipt(
      pending,
      await send(pending.contestId, structuredClone(pending.payload)),
    );
    return { kind: 'success', receipt };
  } catch (error) {
    // Access is checked before receipts. Losing access cannot prove that the original command failed.
    const knownRejection =
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![401, 403, 408, 429].includes(error.status) &&
      error.message !== 'COMMAND_ID_REUSED';
    return { kind: knownRejection ? 'rejected' : 'retry', error };
  }
}

/** Archiving is local evidence preservation, never a cancellation on the server. */
export function archiveAdminPending(
  storage: CommandStorage,
  tournamentId: string,
  reason: string,
  checked: boolean,
  archiveId: string,
  now = new Date().toISOString(),
) {
  if (!checked || reason.trim().length < 3 || reason.trim().length > 300 || !isUuid(archiveId))
    throw new Error('ADMIN_ARCHIVE_REVIEW_REQUIRED');
  const raw = storage.getItem(adminPendingKey(tournamentId));
  if (raw === null) throw new Error('ADMIN_PENDING_MISSING');
  // Preserve malformed packets verbatim too; removing them without evidence would hide the failure.
  const key = `judo.admin-control.archive.${tournamentId}.${archiveId}`;
  storage.setItem(
    key,
    JSON.stringify({ tournamentId, raw, reason: reason.trim(), reviewedAt: now }),
  );
  storage.removeItem(adminPendingKey(tournamentId));
}
