import { applyCommand, type Command, type MatchState } from '@judo/engine/match';
import type { MatchAction } from '../scoreboard/model/types';
import type { View } from '../live/live-board';

export type Packet = {
  id: string;
  expectedVersion: number;
  sessionId: string;
  type: 'OFFLINE_OPEN' | 'OFFLINE_SYNC' | 'OFFLINE_RELEASE';
  events?: Command[];
};
export type Journal = {
  sessionId: string;
  view: View;
  state: MatchState;
  revision: number;
  events: Command[];
  packet?: Packet;
  opening: boolean;
  conflict?: string;
};

export function appendJournalCommand(journal: Journal, action: MatchAction): Journal {
  // A release packet transfers ownership. Events created after it would never reach the server.
  if (journal.packet?.type === 'OFFLINE_RELEASE') throw new Error('OFFLINE_RELEASE_IN_PROGRESS');
  const command = {
    ...action,
    id: crypto.randomUUID(),
    expectedVersion: journal.state.version,
  } as Command;
  const state = applyCommand(journal.state, command);
  state.receipts = {};
  return { ...journal, state, events: [...journal.events, command] };
}

export function canReleaseJournal(journal: Journal): boolean {
  return (
    !journal.opening &&
    !journal.conflict &&
    !journal.events.length &&
    !journal.packet &&
    journal.state.status !== 'RUNNING' &&
    !journal.state.hold
  );
}
