import { appendJournalCommand, type Journal } from './journal.ts';
import type { MatchAction } from '../scoreboard/model/types';

/** The caller commits nextAnchor only after this whole step succeeds. Fractions
 * remain in the monotonic anchor instead of being lost on every 250 ms tick. */
export function advanceJournalClock(
  journal: Journal,
  anchor: number,
  at: number,
  action?: MatchAction,
) {
  if (!Number.isFinite(anchor) || !Number.isFinite(at) || at < anchor)
    throw new Error('OFFLINE_CLOCK_INVALID');
  const running = journal.state.status === 'RUNNING';
  const ms = running ? Math.floor(at - anchor) : 0;
  let next = running && ms ? appendJournalCommand(journal, { type: 'ADVANCE', ms }) : journal;
  if (action) next = appendJournalCommand(next, action);
  return { journal: next, nextAnchor: running ? anchor + ms : at };
}
