/** Pure custom-profile reducer. Time comes from a trusted monotonic-clock adapter. */
export type Side = 'WHITE' | 'BLUE';
export type Score = 'YUKO' | 'WAZA_ARI' | 'IPPON';
export type Rules = Readonly<{
  durationMs: number;
  shidoLimit: number;
  wazaForIppon: number;
  enabledScores: readonly Score[];
  holdThresholds: readonly Readonly<{ ms: number; score: Score }>[];
}>;
type Award = {
  id: string;
  side: Side;
  kind: Score | 'SHIDO';
  active: boolean;
  phase?: 'REGULAR' | 'GOLDEN';
};
export type MatchState = {
  rules: Rules;
  version: number;
  phase: 'REGULAR' | 'GOLDEN';
  status: 'READY' | 'PAUSED' | 'RUNNING' | 'DECISION' | 'PROVISIONAL' | 'CONFIRMED';
  elapsedMs: number;
  goldenMs: number;
  hold: { side: Side; elapsedMs: number; awardId?: string } | null;
  awards: Award[];
  outcome: { winner: Side; reason: string } | null;
  receipts: Record<string, string>;
};
export type Command = { id: string; expectedVersion: number } & (
  | { type: 'START' | 'STOP' | 'GOLDEN' | 'TOKETA' | 'CONFIRM' | 'RECOVER' }
  | { type: 'ADVANCE'; ms: number }
  | { type: 'AWARD'; side: Side; kind: Score | 'SHIDO' }
  | { type: 'HOLD'; side: Side }
  | { type: 'REVOKE'; awardId: string }
);
const opposite = (s: Side): Side => (s === 'WHITE' ? 'BLUE' : 'WHITE');
const scores: Score[] = ['YUKO', 'WAZA_ARI', 'IPPON'];
function requireCondition(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
export function createMatch(rules: Rules): MatchState {
  requireCondition(
    Number.isSafeInteger(rules.durationMs) && rules.durationMs > 0,
    'INVALID_DURATION',
  );
  requireCondition(
    Number.isSafeInteger(rules.shidoLimit) && rules.shidoLimit > 0,
    'INVALID_SHIDO_LIMIT',
  );
  requireCondition(
    Number.isSafeInteger(rules.wazaForIppon) && rules.wazaForIppon > 0,
    'INVALID_WAZA_LIMIT',
  );
  requireCondition(
    rules.enabledScores.length > 0 &&
      new Set(rules.enabledScores).size === rules.enabledScores.length &&
      rules.enabledScores.every((s) => scores.includes(s)),
    'INVALID_SCORES',
  );
  let previous = 0,
    rank = -1;
  for (const t of rules.holdThresholds) {
    requireCondition(
      Number.isSafeInteger(t.ms) &&
        t.ms > previous &&
        rules.enabledScores.includes(t.score) &&
        scores.indexOf(t.score) > rank,
      'INVALID_THRESHOLDS',
    );
    previous = t.ms;
    rank = scores.indexOf(t.score);
  }
  return {
    rules: structuredClone(rules),
    version: 0,
    phase: 'REGULAR',
    status: 'READY',
    elapsedMs: 0,
    goldenMs: 0,
    hold: null,
    awards: [],
    outcome: null,
    receipts: {},
  };
}
export function tally(state: MatchState, side: Side) {
  const result = { YUKO: 0, WAZA_ARI: 0, IPPON: 0, SHIDO: 0 };
  for (const a of state.awards) if (a.active && a.side === side) result[a.kind]++;
  return result;
}
/** Display the winning ippon without inventing a separate, revocable scoring action. */
export function scoreboardScores(state: MatchState, side: Side) {
  const result = tally(state, side);
  if (
    ['PROVISIONAL', 'CONFIRMED'].includes(state.status) &&
    state.outcome?.reason === 'ACCUMULATED_SHIDO' &&
    state.outcome.winner === side
  )
    result.IPPON = 1;
  return result;
}
function finish(s: MatchState, winner: Side, reason: string) {
  s.outcome = { winner, reason };
  s.status = 'PROVISIONAL';
  s.hold = null;
}
function evaluate(s: MatchState) {
  for (const side of ['WHITE', 'BLUE'] as const) {
    const t = tally(s, side);
    if (t.SHIDO >= s.rules.shidoLimit) {
      finish(s, opposite(side), 'ACCUMULATED_SHIDO');
      return;
    }
    if (t.IPPON || t.WAZA_ARI >= s.rules.wazaForIppon) {
      finish(s, side, t.IPPON ? 'IPPON' : 'COMBINATION');
      return;
    }
  }
  if (s.phase === 'REGULAR' && s.elapsedMs >= s.rules.durationMs && !s.hold) {
    const w = tally(s, 'WHITE'),
      b = tally(s, 'BLUE');
    for (const key of ['WAZA_ARI', 'YUKO'] as const)
      if (w[key] !== b[key]) {
        finish(s, w[key] > b[key] ? 'WHITE' : 'BLUE', 'TIME');
        return;
      }
    s.status = 'DECISION';
  }
}
function award(s: MatchState, id: string, side: Side, kind: Score | 'SHIDO') {
  requireCondition(kind === 'SHIDO' || s.rules.enabledScores.includes(kind), 'DISABLED_SCORE');
  s.awards.push({ id, side, kind, active: true, phase: s.phase });
  if (s.phase === 'GOLDEN' && kind !== 'SHIDO') finish(s, side, 'GOLDEN_SCORE');
  else evaluate(s);
}
function updateHoldAward(s: MatchState, id: string) {
  const h = s.hold!;
  const reached = s.rules.holdThresholds.filter((t) => t.ms <= h.elapsedMs).at(-1);
  const previous = s.awards.find((a) => a.id === h.awardId && a.active);
  if (!reached || previous?.kind === reached.score) return;
  // One hold contributes one score. Preserve superseded awards for review.
  if (previous) previous.active = false;
  h.awardId = id;
  award(s, id, h.side, reached.score);
}
function closeHold(s: MatchState, id: string) {
  updateHoldAward(s, id);
  s.hold = null;
  if (s.status === 'RUNNING') evaluate(s);
}
/** Commands contain scalar fields; JSON object-key order is not part of their identity. */
function commandFingerprint(command: Command) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(command).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
export function applyCommand(input: MatchState, c: Command): MatchState {
  requireCondition(typeof c.id === 'string' && c.id.trim().length > 0, 'INVALID_COMMAND_ID');
  const fingerprint = commandFingerprint(c);
  if (Object.hasOwn(input.receipts, c.id)) {
    // Preserve replay compatibility with receipts written before canonical key ordering.
    requireCondition(
      commandFingerprint(JSON.parse(input.receipts[c.id]) as Command) === fingerprint,
      'COMMAND_ID_REUSED',
    );
    return structuredClone(input);
  }
  requireCondition(c.expectedVersion === input.version, 'VERSION_CONFLICT');
  requireCondition(input.status !== 'CONFIRMED', 'RESULT_LOCKED');
  const s = structuredClone(input);
  const live = () =>
    requireCondition(['RUNNING', 'PAUSED', 'DECISION'].includes(s.status), 'INVALID_TRANSITION');
  switch (c.type) {
    case 'RECOVER':
      requireCondition(s.status === 'RUNNING', 'INVALID_TRANSITION');
      s.status = 'PAUSED';
      break;
    case 'START':
      requireCondition(['READY', 'PAUSED'].includes(s.status), 'INVALID_TRANSITION');
      s.status = 'RUNNING';
      break;
    case 'STOP':
      requireCondition(s.status === 'RUNNING', 'INVALID_TRANSITION');
      requireCondition(!s.hold, 'RESOLVE_HOLD_FIRST');
      s.status = 'PAUSED';
      break;
    case 'AWARD':
      live();
      requireCondition(c.side === 'WHITE' || c.side === 'BLUE', 'INVALID_SIDE');
      award(s, c.id, c.side, c.kind);
      break;
    case 'HOLD':
      requireCondition(s.status === 'RUNNING' && !s.hold, 'INVALID_TRANSITION');
      requireCondition(c.side === 'WHITE' || c.side === 'BLUE', 'INVALID_SIDE');
      requireCondition(s.rules.holdThresholds.length > 0, 'HOLD_DISABLED');
      s.hold = { side: c.side, elapsedMs: 0 };
      break;
    case 'TOKETA':
      requireCondition(s.status === 'RUNNING' && s.hold, 'INVALID_TRANSITION');
      closeHold(s, c.id);
      break;
    case 'ADVANCE': {
      requireCondition(s.status === 'RUNNING', 'INVALID_TRANSITION');
      requireCondition(Number.isSafeInteger(c.ms) && c.ms >= 0, 'INVALID_TIME');
      let delta = c.ms;
      if (s.hold) {
        const count = tally(s, s.hold.side);
        const currentAward = s.awards.find((a) => a.id === s.hold!.awardId && a.active);
        // Exclude this hold's current waza-ari when checking for a second one.
        if (currentAward?.kind === 'WAZA_ARI') count.WAZA_ARI--;
        const terminal = s.rules.holdThresholds.find(
          (t) =>
            s.phase === 'GOLDEN' ||
            t.score === 'IPPON' ||
            (t.score === 'WAZA_ARI' && count.WAZA_ARI + 1 >= s.rules.wazaForIppon),
        );
        if (terminal) delta = Math.min(delta, Math.max(0, terminal.ms - s.hold.elapsedMs));
      }
      if (s.phase === 'REGULAR') s.elapsedMs = Math.min(s.rules.durationMs, s.elapsedMs + delta);
      else s.goldenMs += delta;
      if (s.hold) {
        s.hold.elapsedMs += delta;
        updateHoldAward(s, c.id);
      }
      if (s.status === 'RUNNING') evaluate(s);
      break;
    }
    case 'GOLDEN':
      requireCondition(
        s.status === 'DECISION' && s.phase === 'REGULAR' && !s.hold && !s.outcome,
        'INVALID_TRANSITION',
      );
      s.phase = 'GOLDEN';
      s.status = 'PAUSED';
      break;
    case 'REVOKE': {
      requireCondition(!s.hold, 'RESOLVE_HOLD_FIRST');
      const a = s.awards.find((a) => a.id === c.awardId && a.active);
      requireCondition(a, 'AWARD_NOT_FOUND');
      // Cross-phase or dependent corrections require replay/review, not silent editing.
      requireCondition(s.phase === 'REGULAR' || a.phase === 'GOLDEN', 'CORRECTION_REQUIRES_REVIEW');
      a.active = false;
      const goldenWinner =
        s.phase === 'GOLDEN'
          ? s.awards.find((a) => a.active && a.phase === 'GOLDEN' && a.kind !== 'SHIDO')
          : undefined;
      s.outcome = null;
      s.status = 'PAUSED';
      evaluate(s);
      if (!s.outcome && goldenWinner) finish(s, goldenWinner.side, 'GOLDEN_SCORE');
      break;
    }
    case 'CONFIRM':
      requireCondition(s.status === 'PROVISIONAL' && s.outcome, 'INVALID_TRANSITION');
      s.status = 'CONFIRMED';
      break;
    default:
      throw new Error('UNKNOWN_COMMAND');
  }
  s.version++;
  Object.defineProperty(s.receipts, c.id, {
    value: fingerprint,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return s;
}
