import { isGrant, isRevision, isUuid, type ControlGrant } from '../auth/control-model.ts';
import type { MatchAction } from '../scoreboard/model/types';
export type PendingMatchCommand = {
  contestId: string;
  payload: MatchAction & { id: string; expectedVersion: number } & ControlGrant;
};
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
  if (!isGrant(p.payload)) throw new Error('LEGACY_CONTROL_METADATA');
  return structuredClone(p);
}
