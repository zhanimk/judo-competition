import { createMatch, type MatchState } from '@judo/engine/match';
import { isRevision } from '../auth/control-model.ts';
import type { View } from './live-board';

export type CommandResponse = { revision: number; status: string; state: MatchState };

export function isMatchState(value: unknown): value is MatchState {
  if (!value || typeof value !== 'object') return false;
  const state = value as MatchState;
  try {
    createMatch(state.rules);
  } catch {
    return false;
  }
  const side = (value: unknown) => value === 'WHITE' || value === 'BLUE';
  return (
    isRevision(state.version) &&
    ['REGULAR', 'GOLDEN'].includes(state.phase) &&
    ['READY', 'PAUSED', 'RUNNING', 'DECISION', 'PROVISIONAL', 'CONFIRMED'].includes(state.status) &&
    isRevision(state.elapsedMs) &&
    state.elapsedMs <= state.rules.durationMs &&
    isRevision(state.goldenMs) &&
    (state.hold === null ||
      (!!state.hold &&
        side(state.hold.side) &&
        isRevision(state.hold.elapsedMs) &&
        (state.hold.awardId === undefined || typeof state.hold.awardId === 'string'))) &&
    Array.isArray(state.awards) &&
    state.awards.every(
      (award) =>
        !!award &&
        typeof award.id === 'string' &&
        side(award.side) &&
        ['YUKO', 'WAZA_ARI', 'IPPON', 'SHIDO'].includes(award.kind) &&
        typeof award.active === 'boolean' &&
        (award.phase === undefined || ['REGULAR', 'GOLDEN'].includes(award.phase)),
    ) &&
    (state.outcome === null ||
      (!!state.outcome &&
        side(state.outcome.winner) &&
        ['IPPON', 'COMBINATION', 'TIME', 'ACCUMULATED_SHIDO', 'GOLDEN_SCORE'].includes(
          state.outcome.reason,
        ))) &&
    ['PROVISIONAL', 'CONFIRMED'].includes(state.status) === !!state.outcome &&
    !!state.receipts &&
    typeof state.receipts === 'object' &&
    !Array.isArray(state.receipts) &&
    Object.values(state.receipts).every((receipt) => typeof receipt === 'string')
  );
}

export function validateMatchReceipt(
  contestId: string,
  expectedRevision: number,
  value: unknown,
): CommandResponse {
  const receipt = value as CommandResponse & { contestId: string; updatedAt: string };
  if (
    !isRevision(expectedRevision) ||
    receipt?.contestId !== contestId ||
    !isRevision(receipt.revision) ||
    receipt.revision <= expectedRevision ||
    !['ACTIVE', 'CONFIRMED'].includes(receipt.status) ||
    !isMatchState(receipt.state) ||
    (receipt.status === 'CONFIRMED') !== (receipt.state.status === 'CONFIRMED') ||
    typeof receipt.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.updatedAt))
  )
    throw new Error('MATCH_RECEIPT_INVALID');
  return structuredClone(receipt);
}

/** An idempotent retry can return an older receipt after the match was edited again. */
export function mergeCommandResponse(
  view: View | null,
  contestId: string,
  result: CommandResponse,
): View | null {
  const match = view?.currentMatch;
  if (
    !view ||
    !match ||
    match.id !== contestId ||
    result.revision < match.revision ||
    (result.revision === match.revision && result.state.version < match.state.version)
  )
    return view;
  return {
    ...view,
    currentMatch:
      result.status === 'CONFIRMED'
        ? null
        : { ...match, revision: result.revision, state: result.state },
  };
}
