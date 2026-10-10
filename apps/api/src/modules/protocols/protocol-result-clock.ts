import type { MatchState } from '@judo/engine/match';
const elapsed = (ms: number) => {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
};
/** Golden Score is a phase, including a result decided at 0:00.0. */
export function protocolResultClock(state: MatchState | null) {
  if (!state) return '—';
  return `${elapsed(state.elapsedMs)}${state.phase === 'GOLDEN' ? ` + GS ${elapsed(state.goldenMs)}` : ''}`;
}
