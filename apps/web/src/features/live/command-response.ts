import type { MatchState } from '@judo/engine/match';
import type { View } from './live-board';

export type CommandResponse = { revision: number; status: string; state: MatchState };

/** An idempotent retry can return an older receipt after the match was edited again. */
export function mergeCommandResponse(
  view: View | null,
  contestId: string,
  result: CommandResponse,
): View | null {
  const match = view?.currentMatch;
  if (!view || !match || match.id !== contestId || result.revision < match.revision) return view;
  return {
    ...view,
    currentMatch:
      result.status === 'CONFIRMED'
        ? null
        : { ...match, revision: result.revision, state: result.state },
  };
}
