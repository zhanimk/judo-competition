import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyCommand, createMatch } from '@judo/engine/match';
import {
  deliverMatchPacket,
  isUnknownMatchFailure,
  matchRecoveryProof,
  mayRetryMatch,
  readMatchPending,
  reviewedMatchArchive,
  saveMatchPending,
  type PendingMatchCommand,
} from '../src/features/live/pending-command.ts';
import {
  acknowledgeJournalPacket,
  appendJournalCommand,
  type Journal,
} from '../src/features/offline/journal.ts';
import { ApiError } from '../src/features/tournaments/api.ts';
const rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'] as const,
  holdThresholds: [{ ms: 20000, score: 'IPPON' as const }],
};
function fixture() {
  const pending: PendingMatchCommand = {
    contestId: randomUUID(),
    payload: {
      id: randomUUID(),
      expectedVersion: 10,
      deviceId: randomUUID(),
      controlGeneration: 4,
      type: 'AWARD',
      side: 'WHITE',
      kind: 'YUKO',
    },
  };
  let state = createMatch(rules);
  state = applyCommand(state, { id: randomUUID(), expectedVersion: 0, type: 'START' });
  state = applyCommand(state, { id: randomUUID(), expectedVersion: 1, type: 'STOP' });
  const receipt = {
    contestId: pending.contestId,
    revision: 11,
    status: 'ACTIVE',
    state,
    updatedAt: new Date().toISOString(),
  };
  return { pending, receipt };
}
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function journal(): Journal {
  const { pending, receipt } = fixture();
  const sessionId = randomUUID();
  return {
    sessionId,
    opening: false,
    revision: pending.payload.expectedVersion,
    state: receipt.state,
    grant: { deviceId: pending.payload.deviceId, controlGeneration: 4 },
    events: [],
    packet: {
      id: pending.payload.id,
      expectedVersion: 10,
      sessionId,
      type: 'OFFLINE_RELEASE',
      deviceId: pending.payload.deviceId,
      controlGeneration: 4,
      events: [],
    },
    view: {
      tournamentId: randomUUID(),
      tournamentName: 'QA',
      tournamentStatus: 'RUNNING',
      number: 1,
      lastResult: null,
      currentMatch: {
        id: pending.contestId,
        key: 'QA1',
        category: 'QA',
        revision: 10,
        state: receipt.state,
        white: { id: randomUUID(), firstName: 'QA', lastName: 'Ақ', club: 'QA' },
        blue: { id: randomUUID(), firstName: 'QA', lastName: 'Көк', club: 'QA' },
      },
    },
  };
}

test('lost sporting response restores exact command after reload and safely queries its saved receipt after takeover', async () => {
  const { pending, receipt } = fixture(),
    store = memory(),
    tatamiId = randomUUID();
  const original = structuredClone(pending),
    requests: unknown[] = [];
  saveMatchPending(store, tatamiId, pending);
  let writes = 0;
  const transport = async (_contestId: string, payload: unknown) => {
    requests.push(structuredClone(payload));
    (payload as { id: string }).id = 'transport mutation';
    if (!writes++) throw new TypeError('response lost after commit');
    return receipt;
  };
  await assert.rejects(deliverMatchPacket(pending.contestId, pending.payload, transport));
  const restored = readMatchPending(store, tatamiId)!;
  const newGrant = { deviceId: randomUUID(), controlGeneration: 5 };
  assert.equal(mayRetryMatch(restored, newGrant, false), false);
  assert.equal(mayRetryMatch(restored, newGrant, true), true);
  assert.equal(
    (await deliverMatchPacket(restored.contestId, restored.payload, transport)).revision,
    11,
  );
  assert.deepEqual(requests, [original.payload, original.payload]);
  assert.deepEqual(readMatchPending(store, tatamiId), original);
  assert.throws(
    () =>
      saveMatchPending(store, tatamiId, {
        ...restored,
        payload: { ...restored.payload, ...newGrant },
      }),
    /SAVED_MATCH_EXISTS/,
  );
});

test('malformed 200 replies cannot acknowledge or remove the saved online command', async () => {
  const { pending, receipt } = fixture(),
    store = memory(),
    mat = randomUUID();
  saveMatchPending(store, mat, pending);
  for (const response of [
    null,
    {},
    { ...receipt, contestId: randomUUID() },
    { ...receipt, revision: 10 },
    { ...receipt, updatedAt: 'bad date' },
    { ...receipt, status: 'CONFIRMED' },
    { ...receipt, state: { ...receipt.state, hold: { side: 'WRONG', elapsedMs: 0 } } },
    { ...receipt, state: { ...receipt.state, rules: {} } },
  ]) {
    await assert.rejects(
      deliverMatchPacket(pending.contestId, pending.payload, async () => response),
      /MATCH_RECEIPT_INVALID/,
    );
    assert.deepEqual(readMatchPending(store, mat), pending);
  }
});

test('auth loss, timeout, overload and stale grants remain unknown; known no-apply rejection can resolve a packet', () => {
  for (const status of [401, 403, 408, 429, 500, 503])
    assert.equal(isUnknownMatchFailure(new ApiError('QA', status)), true);
  for (const code of [
    'CONTROL_GENERATION_STALE',
    'CONTROL_REQUIRED',
    'COMMAND_ID_REUSED',
    'INVITATION_REVOKED',
  ])
    assert.equal(isUnknownMatchFailure(new ApiError(code, 409)), true);
  assert.equal(isUnknownMatchFailure(new ApiError('VERSION_CONFLICT', 409)), false);
  assert.equal(isUnknownMatchFailure(new Error('malformed receipt')), true);
});

test('malformed release receipts retain the exact offline packet and all original events', async () => {
  const saved = journal(),
    before = structuredClone(saved),
    packet = saved.packet!;
  for (const value of [
    null,
    {},
    {
      contestId: saved.view.currentMatch!.id,
      revision: 11,
      status: 'CONFIRMED',
      state: saved.state,
    },
  ]) {
    await assert.rejects(
      deliverMatchPacket(saved.view.currentMatch!.id, packet, async () => value),
      /MATCH_RECEIPT_INVALID/,
    );
    assert.throws(() => acknowledgeJournalPacket(saved, packet, value), /MATCH_RECEIPT_INVALID/);
    assert.deepEqual(saved, before);
  }
  const receipt = {
    contestId: saved.view.currentMatch!.id,
    revision: 11,
    status: 'ACTIVE',
    state: saved.state,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(acknowledgeJournalPacket(saved, packet, receipt).archived, true);
  assert.deepEqual(saved, before);
});

test('acknowledging an offline prefix preserves newer unsent local scores and never mutates its old generation', () => {
  let saved = journal();
  delete saved.packet;
  saved = appendJournalCommand(saved, { type: 'AWARD', side: 'WHITE', kind: 'YUKO' });
  saved.packet = {
    id: randomUUID(),
    expectedVersion: 10,
    sessionId: saved.sessionId,
    type: 'OFFLINE_SYNC',
    ...saved.grant!,
    events: structuredClone(saved.events),
  };
  saved = appendJournalCommand(saved, { type: 'AWARD', side: 'BLUE', kind: 'YUKO' });
  const original = structuredClone(saved);
  const receipt = {
    contestId: saved.view.currentMatch!.id,
    revision: 11,
    status: 'ACTIVE',
    state: saved.state,
    updatedAt: new Date().toISOString(),
  };
  const applied = acknowledgeJournalPacket(saved, saved.packet!, receipt);
  assert.equal(applied.archived, false);
  assert.deepEqual(applied.next.events, saved.events.slice(1));
  assert.equal(applied.next.state, saved.state);
  assert.equal(applied.next.grant!.controlGeneration, 4);
  assert.deepEqual(saved, original);
});

test('a restored corrupt journal cannot acknowledge a changed packet or discard events that are not its exact prefix', () => {
  let saved = journal();
  delete saved.packet;
  saved = appendJournalCommand(saved, { type: 'AWARD', side: 'WHITE', kind: 'YUKO' });
  saved.packet = {
    id: randomUUID(),
    expectedVersion: saved.revision,
    sessionId: saved.sessionId,
    type: 'OFFLINE_SYNC',
    ...saved.grant!,
    events: structuredClone(saved.events),
  };
  const receipt = {
    contestId: saved.view.currentMatch!.id,
    revision: 11,
    status: 'ACTIVE',
    state: saved.state,
    updatedAt: new Date().toISOString(),
  };
  for (const corrupt of [
    { ...saved, sessionId: randomUUID() },
    { ...saved, revision: 9 },
    { ...saved, events: [] },
    { ...saved, events: [{ ...saved.events[0], id: randomUUID() }] },
  ]) {
    const restored = structuredClone(corrupt),
      before = structuredClone(restored);
    assert.throws(
      () => acknowledgeJournalPacket(restored, restored.packet!, receipt),
      /OFFLINE_PACKET_CHANGED/,
    );
    assert.deepEqual(restored, before, 'corrupt evidence is retained without dropping scores');
  }
  assert.throws(
    () => acknowledgeJournalPacket(saved, { ...saved.packet!, controlGeneration: 5 }, receipt),
    /OFFLINE_PACKET_CHANGED/,
  );
});

test('manual archive requires stopped proof of the original match and an explicit administrator decision', () => {
  const { pending, receipt } = fixture(),
    raw = JSON.stringify(pending);
  const proof = matchRecoveryProof(pending.contestId, {
    revision: 11,
    impactToken: 'a'.repeat(64),
    clockState: receipt.state,
    dependent: [],
  });
  for (const [reason, checked, access, evidence] of [
    ['QA review', false, true, proof],
    ['QA review', true, false, proof],
    ['x', true, true, proof],
    ['QA review', true, true, { ...proof, contestId: randomUUID() }],
    [
      'QA review',
      true,
      true,
      { ...proof, clockState: { ...receipt.state, status: 'RUNNING' as const } },
    ],
  ] as const)
    assert.throws(() => reviewedMatchArchive(raw, reason, checked, evidence, access));
  const archive = reviewedMatchArchive(raw, 'QA: сверены оценки и версия', true, proof, true);
  assert.equal(archive.raw, raw);
  assert.equal(archive.proof.contestId, pending.contestId);
  assert.equal(archive.proof.impactToken, proof.impactToken);
});
