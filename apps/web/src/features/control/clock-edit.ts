import { correctStoppedClock, MAX_CORRECTED_GOLDEN_MS, type MatchState } from '@judo/engine/match';

/** The administrator enters remaining regular time or elapsed Golden Score time, to 100 ms. */
export function formatClockTenths(ms: number) {
  const tenths = Math.round(Math.max(0, ms) / 100);
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}
export function clockEditValue(state: MatchState) {
  return formatClockTenths(
    state.phase === 'REGULAR' ? state.rules.durationMs - state.elapsedMs : state.goldenMs,
  );
}
export function previewClockCorrection(state: MatchState, input: string) {
  const parts = /^(\d{1,3}):([0-5]\d)\.(\d)$/.exec(input.trim());
  if (!parts) throw new Error('CLOCK_INPUT_FORMAT');
  const enteredMs = Number(parts[1]) * 60000 + Number(parts[2]) * 1000 + Number(parts[3]) * 100;
  const maximum = state.phase === 'REGULAR' ? state.rules.durationMs : MAX_CORRECTED_GOLDEN_MS;
  if (enteredMs > maximum) throw new Error('INVALID_TIME');
  const correction = {
    phase: state.phase,
    elapsedMs: state.phase === 'REGULAR' ? state.rules.durationMs - enteredMs : enteredMs,
  };
  return { correction, state: correctStoppedClock(state, correction) };
}
