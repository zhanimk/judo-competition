import {
  isGrant,
  isRevision,
  isUuid,
  sameGrant,
  type ControlGrant,
} from '../auth/control-model.ts';
import type { MatchAction } from '../scoreboard/model/types';
import { ApiError } from '../tournaments/api.ts';
import { validateMatchReceipt, type CommandResponse, isMatchState } from './command-response.ts';
export type PendingMatchCommand = {
  contestId: string;
  payload: MatchAction & { id: string; expectedVersion: number; skipRest?: boolean } & ControlGrant;
};
type MatchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const matchPendingKey = (tatamiId: string) => `judo.pending.${tatamiId}`;
export function readMatchPending(storage: MatchStorage, tatamiId: string) {
  const raw = storage.getItem(matchPendingKey(tatamiId));
  return raw === null ? null : restoreMatchPending(raw);
}
export function saveMatchPending(
  storage: MatchStorage,
  tatamiId: string,
  pending: PendingMatchCommand,
) {
  const value = restoreMatchPending(JSON.stringify(pending));
  const old = readMatchPending(storage, tatamiId);
  if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error('SAVED_MATCH_EXISTS');
  storage.setItem(matchPendingKey(tatamiId), JSON.stringify(value));
}
export function restoreMatchPending(raw: string): PendingMatchCommand {
  const p = JSON.parse(raw) as PendingMatchCommand;
  if (
    !isUuid(p?.contestId) ||
    !isUuid(p?.payload?.id) ||
    !isRevision(p?.payload?.expectedVersion) ||
    !['START', 'STOP', 'GOLDEN', 'TOKETA', 'CONFIRM', 'AWARD', 'HOLD', 'REVOKE'].includes(
      p?.payload?.type,
    )
  )
    throw new Error('SAVED_MATCH_INVALID');
  if (
    p.payload.skipRest !== undefined &&
    (p.payload.skipRest !== true || p.payload.type !== 'START')
  )
    throw new Error('SAVED_MATCH_INVALID');
  if (!isGrant(p.payload)) throw new Error('LEGACY_CONTROL_METADATA');
  return structuredClone(p);
}

export function mayRetryMatch(
  pending: PendingMatchCommand,
  grant: ControlGrant | null,
  adminAccess: boolean,
) {
  return sameGrant(pending.payload, grant) || adminAccess;
}

export function isUnknownMatchFailure(error: unknown) {
  return !(
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status) &&
    ![
      'COMMAND_ID_REUSED',
      'CONTROL_REQUIRED',
      'CONTROL_GENERATION_STALE',
      'INVITATION_REVOKED',
    ].includes(error.message)
  );
}

export async function deliverMatchPacket(
  contestId: string,
  payload: { expectedVersion: number },
  send: (contestId: string, payload: unknown) => Promise<unknown>,
): Promise<CommandResponse> {
  return validateMatchReceipt(
    contestId,
    payload.expectedVersion,
    await send(contestId, structuredClone(payload)),
  );
}

export type MatchRecoveryProof = {
  contestId: string;
  revision: number;
  impactToken: string;
  clockState: import('@judo/engine/match').MatchState | null;
  dependent: { id: string; key: string; status: string }[];
};

export function matchRecoveryProof(contestId: string, value: unknown): MatchRecoveryProof {
  const proof = value as MatchRecoveryProof;
  if (
    !isUuid(contestId) ||
    !isRevision(proof?.revision) ||
    !/^[a-f\d]{64}$/.test(proof.impactToken) ||
    (proof.clockState !== null && !isMatchState(proof.clockState)) ||
    !Array.isArray(proof.dependent) ||
    proof.dependent.some(
      (row) => !isUuid(row?.id) || typeof row.key !== 'string' || typeof row.status !== 'string',
    )
  )
    throw new Error('MATCH_RECOVERY_INVALID');
  return { ...structuredClone(proof), contestId };
}

export function reviewedMatchArchive(
  raw: string,
  reason: string,
  checked: boolean,
  proof: MatchRecoveryProof | null,
  liveAdmin: boolean,
  now = new Date().toISOString(),
) {
  const saved = JSON.parse(raw) as {
    contestId?: string;
    view?: { currentMatch?: { id?: string } };
  };
  const contestId = saved.contestId ?? saved.view?.currentMatch?.id;
  if (
    !liveAdmin ||
    !checked ||
    !proof ||
    proof.contestId !== contestId ||
    proof.clockState?.status === 'RUNNING' ||
    reason.trim().length < 3 ||
    reason.trim().length > 300
  )
    throw new Error('MATCH_RECOVERY_REVIEW_REQUIRED');
  return {
    raw,
    reason: reason.trim(),
    proof: matchRecoveryProof(proof.contestId, proof),
    reviewedAt: now,
  };
}
