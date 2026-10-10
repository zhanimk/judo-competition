import type { MatchState } from '@judo/engine/match';
import { time } from '../scoreboard/lib/format-time.ts';
const elapsed = (ms: number) => {
  const value = time(ms);
  return `${value.main}.${value.tenth}`;
};
export function resultClock(state: MatchState | null | undefined) {
  if (!state) return '—';
  return `${elapsed(state.elapsedMs)}${state.phase === 'GOLDEN' ? ` + GS ${elapsed(state.goldenMs)}` : ''}`;
}
