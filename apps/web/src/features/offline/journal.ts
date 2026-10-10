import { applyCommand, type Command, type MatchState } from '@judo/engine/match';
import type { MatchAction } from '../scoreboard/model/types';
import type { View } from '../live/live-board';
import { isGrant, sameGrant, type ControlGrant } from '../auth/control-model.ts';

export type Packet = {
  id: string;
  expectedVersion: number;
  sessionId: string;
  type: 'OFFLINE_OPEN' | 'OFFLINE_SYNC' | 'OFFLINE_RELEASE';
  events?: Command[];
  deviceId?: string;
  controlGeneration?: number;
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
  grant?: ControlGrant;
};

export function journalControlError(
  journal: Journal,
  grant: ControlGrant | null,
  known: boolean,
  deviceId?: string | null,
) {
  if (!isGrant(journal.grant) || (journal.packet && !isGrant(journal.packet)))
    return 'LEGACY_CONTROL_METADATA';
  if (journal.packet && !sameGrant(journal.packet as ControlGrant, journal.grant))
    return 'CONTROL_PACKET_MISMATCH';
  if (deviceId && journal.grant.deviceId !== deviceId) return 'CONTROL_DEVICE_CHANGED';
  if (known && !sameGrant(journal.grant, grant)) return 'CONTROL_GENERATION_STALE';
  return null;
}

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
