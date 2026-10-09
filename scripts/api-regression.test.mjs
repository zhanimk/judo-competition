import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { createMatch, applyCommand } from '@judo/engine/match';
import { AuthService } from '../apps/api/dist/modules/auth/auth.service.js';
import { MatchesService } from '../apps/api/dist/modules/matches/matches.service.js';
import { MatchCommandDto } from '../apps/api/dist/modules/matches/matches.dto.js';
import { TatamisService } from '../apps/api/dist/modules/tatamis/tatamis.service.js';
import { LiveService } from '../apps/api/dist/modules/matches/live.service.js';
import { ControlService } from '../apps/api/dist/modules/control/control.service.js';

const rules = {
  durationMs: 180000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [{ ms: 20000, score: 'IPPON' }],
};
const actor = { id: randomUUID(), role: 'ORGANIZER' };
const mat = randomUUID();
const tournament = randomUUID();
const matchId = randomUUID();
const categoryId = randomUUID();
const offlineSession = randomUUID();
const conflict = (reason) => (error) => error.getStatus() === 409 && error.message === reason;
const httpError = (status) => (error) => error.getStatus() === status;

function pausedMatch() {
  let state = createMatch(rules);
  for (const type of ['START', 'STOP'])
    state = applyCommand(state, { id: randomUUID(), expectedVersion: state.version, type });
  state.receipts = {};
  return state;
}

// Transaction snapshots make rollback observable without connecting to a user's database.
function harness({ offline = true, oldEvents = [], collideOnWrite = false } = {}) {
  let saved = {
    row: {
      id: matchId,
      drawId: randomUUID(),
      key: 'R1M1',
      round: 1,
      whiteEntryId: randomUUID(),
      blueEntryId: randomUUID(),
      status: 'ACTIVE',
      tatamiId: mat,
      revision: 7,
      queueOrder: 1,
      state: pausedMatch(),
      clockAnchorMs: null,
      clockEpoch: null,
      offlineSessionId: offline ? offlineSession : null,
      offlineActorId: offline ? actor.id : null,
      winnerEntryId: null,
      confirmedAt: null,
      updatedAt: new Date('2026-10-09T01:00:00.000Z'),
      draw: { categoryId, category: { tournamentId: tournament } },
    },
    events: structuredClone(oldEvents),
    audit: [],
    matStatus: 'BUSY',
  };
  saved.entries = [saved.row.whiteEntryId, saved.row.blueEntryId].map((id) => ({
    id,
    categoryId,
    athleteId: randomUUID(),
    archivedAt: null,
  }));
  const notices = [];
  const db = {
    async $transaction(callback) {
      const staged = structuredClone(saved);
      const tx = {
        $queryRaw: async (strings, ...values) =>
          strings.join('').includes('FROM "Athlete"')
            ? staged.entries
                .filter((entry) => entry.athleteId === values[0])
                .map((entry) => ({ id: entry.athleteId }))
            : [],
        rosterCommand: { findFirst: async () => null },
        entry: {
          findMany: async ({ where }) =>
            structuredClone(
              staged.entries.filter((entry) =>
                where.id
                  ? where.id.in.includes(entry.id)
                  : where.athleteId.in.includes(entry.athleteId),
              ),
            ),
        },
        contest: {
          findUnique: async () => structuredClone(staged.row),
          findFirst: async () => null,
          update: async ({ data }) => {
            staged.row = {
              ...staged.row,
              ...data,
              revision: staged.row.revision + (data.revision?.increment ?? 0),
              updatedAt: new Date(staged.row.updatedAt.getTime() + 1),
            };
            return structuredClone(staged.row);
          },
        },
        tatami: {
          update: async ({ data }) => {
            staged.matStatus = data.status;
          },
        },
        matchEvent: {
          findUnique: async ({ where }) =>
            staged.events.find((event) => event.id === where.id) ?? null,
          findFirst: async ({ where }) => {
            const ids = where.OR[0].id.in;
            return (
              staged.events.find(
                (event) =>
                  ids.includes(event.id) ||
                  (['OFFLINE_SYNC', 'OFFLINE_RELEASE'].includes(event.type) &&
                    event.payload.events?.some((nested) => ids.includes(nested.id))),
              ) ?? null
            );
          },
          createMany: async ({ data }) => {
            if (collideOnWrite)
              throw new Prisma.PrismaClientKnownRequestError('duplicate event', {
                code: 'P2002',
                clientVersion: 'test',
              });
            staged.events.push(...structuredClone(data));
          },
          create: async ({ data }) => staged.events.push(structuredClone(data)),
        },
        auditEvent: { create: async ({ data }) => staged.audit.push(structuredClone(data)) },
      };
      const result = await callback(tx);
      saved = staged;
      return result;
    },
  };
  const auth = { control: async () => ({ tournamentId: tournament }) };
  const service = new MatchesService(db, auth, { notify: (notice) => notices.push(notice) });
  return {
    service,
    snapshot: () => structuredClone(saved),
    notices,
    packet(events, extra = {}) {
      return {
        id: randomUUID(),
        type: 'OFFLINE_SYNC',
        sessionId: offlineSession,
        expectedVersion: saved.row.revision,
        events,
        ...extra,
      };
    },
    send: (dto) => service.command(mat, matchId, dto, actor),
  };
}

test('private tatami visibility requires the owner, administrator or its assigned operator', async () => {
  let publishedAt = null;
  const auth = new AuthService({
    tatami: {
      findFirst: async ({ where }) =>
        where.id === mat && (!where.tournamentId || where.tournamentId === tournament)
          ? { id: mat, tournamentId: tournament, tournament: { ownerId: actor.id, publishedAt } }
          : null,
    },
  });
  await assert.rejects(auth.viewTatami(null, mat), httpError(404));
  await assert.rejects(auth.viewTatami({ id: 'other', role: 'ORGANIZER' }, mat), httpError(403));
  await assert.rejects(
    auth.viewTatami({ id: 'other', role: 'OPERATOR', tatamiId: 'another-mat' }, mat),
    httpError(403),
  );
  await auth.viewTatami(actor, mat);
  await auth.viewTatami({ role: 'SUPER_ADMIN' }, mat);
  await auth.viewTatami({ role: 'OPERATOR', tatamiId: mat }, mat);
  await assert.rejects(auth.viewTatami(actor, mat, 'wrong-tournament'), httpError(404));
  publishedAt = new Date();
  await auth.viewTatami(null, mat);
});

test('both public read services check visibility before reading LIVE state or queue', async () => {
  let reads = 0;
  const auth = {
    authenticate: async () => null,
    viewTatami: async () => {
      const error = new Error('private tournament');
      error.getStatus = () => 404;
      throw error;
    },
  };
  const matches = new MatchesService({}, auth, {});
  matches.view = async () => {
    reads++;
  };
  await assert.rejects(matches.publicView(mat), httpError(404));
  const tatamis = new TatamisService(matches, {}, auth);
  await assert.rejects(tatamis.get(tournament, mat), httpError(404));
  assert.equal(reads, 0);
});

test('DTO rejects incomplete scoring, time and offline commands with a validation error', async () => {
  const base = { id: randomUUID(), expectedVersion: 0 };
  const invalid = [
    { type: 'AWARD' },
    { type: 'AWARD', side: 'WHITE' },
    { type: 'HOLD' },
    { type: 'REVOKE' },
    { type: 'OFFLINE_OPEN' },
    { type: 1 },
    { type: 'STOP', expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    {
      type: 'OFFLINE_SYNC',
      sessionId: offlineSession,
      events: [{ id: randomUUID(), expectedVersion: 0, type: 'ADVANCE' }],
    },
  ];
  for (const payload of invalid)
    assert.ok(
      (await validate(plainToInstance(MatchCommandDto, { ...base, ...payload }))).length > 0,
      JSON.stringify(payload),
    );
  assert.equal(
    (
      await validate(
        plainToInstance(MatchCommandDto, {
          ...base,
          type: 'AWARD',
          side: 'WHITE',
          kind: 'YUKO',
        }),
      )
    ).length,
    0,
  );
});

test('repeated sporting commands return their original response after later changes', async () => {
  const h = harness({ offline: false });
  const award = {
    id: randomUUID(),
    expectedVersion: 7,
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
  };
  const first = await h.send(award);
  await h.send({ ...award, id: randomUUID(), expectedVersion: 8, side: 'BLUE' });
  assert.equal(h.snapshot().row.state.awards.length, 2);
  assert.deepEqual(await h.send(award), first);
  assert.equal(h.snapshot().row.revision, 9);
  assert.equal(h.snapshot().events.length, 2);
  await assert.rejects(h.send({ ...award, side: 'BLUE' }), conflict('COMMAND_ID_REUSED'));
});

test('offline packets apply each event once and persist event IDs and their exact response', async () => {
  const h = harness();
  const event = {
    id: randomUUID(),
    expectedVersion: h.snapshot().row.state.version,
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
  };
  const packet = h.packet([event]);
  const first = await h.send(packet);
  assert.equal(h.snapshot().events.filter((e) => e.type === 'OFFLINE_EVENT').length, 1);
  await h.send(
    h.packet([{ ...event, id: randomUUID(), expectedVersion: first.state.version, side: 'BLUE' }]),
  );
  assert.deepEqual(await h.send(packet), first);
  assert.equal(h.snapshot().row.state.awards.length, 2);
  const before = h.snapshot();
  await assert.rejects(
    h.send(h.packet([{ ...event, expectedVersion: before.row.state.version }])),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('duplicate IDs inside a packet or between its envelope and event cannot change the bout', async () => {
  const h = harness();
  const before = h.snapshot();
  const duplicate = randomUUID();
  await assert.rejects(
    h.send(
      h.packet([
        { id: duplicate, expectedVersion: before.row.state.version, type: 'START' },
        { id: duplicate, expectedVersion: before.row.state.version + 1, type: 'STOP' },
      ]),
    ),
    conflict('COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.send(
      h.packet([{ id: duplicate, expectedVersion: before.row.state.version, type: 'START' }], {
        id: duplicate,
      }),
    ),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});

test('old flat packet history still prevents reuse of pre-upgrade offline event IDs', async () => {
  const oldId = randomUUID();
  const h = harness({
    oldEvents: [
      {
        id: randomUUID(),
        contestId: matchId,
        type: 'OFFLINE_SYNC',
        payload: { events: [{ id: oldId, type: 'ADVANCE', ms: 500 }] },
      },
    ],
  });
  const before = h.snapshot();
  await assert.rejects(
    h.send(h.packet([{ id: oldId, expectedVersion: before.row.state.version, type: 'START' }])),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('legacy offline event IDs cannot be reused by online commands or another contest', async () => {
  const oldId = randomUUID();
  const legacy = {
    id: randomUUID(),
    contestId: 'another-contest',
    type: 'OFFLINE_SYNC',
    payload: { events: [{ id: oldId, type: 'AWARD', side: 'WHITE', kind: 'YUKO' }] },
  };
  const online = harness({ offline: false, oldEvents: [legacy] });
  const before = online.snapshot();
  await assert.rejects(
    online.send({ id: oldId, expectedVersion: 7, type: 'AWARD', side: 'BLUE', kind: 'YUKO' }),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.deepEqual(online.snapshot(), before);
  const offline = harness({ oldEvents: [legacy] });
  await assert.rejects(
    offline.send(offline.packet([], { id: oldId })),
    conflict('COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    offline.send(
      offline.packet([
        { id: oldId, expectedVersion: offline.snapshot().row.state.version, type: 'START' },
      ]),
    ),
    conflict('COMMAND_ID_REUSED'),
  );
});

test('administrative commands also reject IDs reserved by a legacy offline packet', async () => {
  const legacyId = randomUUID();
  let writes = 0;
  const tx = {
    $queryRaw: async () => [],
    rosterCommand: { findFirst: async () => null },
    contest: {
      findFirst: async () => ({ id: matchId, revision: 7, state: pausedMatch() }),
      update: async () => writes++,
    },
    matchEvent: {
      findUnique: async () => null,
      findFirst: async ({ where }) => {
        assert.ok(where.OR[0].id.in.includes(legacyId));
        assert.equal('contestId' in where.OR[1], false);
        return { id: 'old-offline-packet' };
      },
    },
  };
  const service = new ControlService(
    { $transaction: (callback) => callback(tx) },
    { owner: async () => {} },
    {},
    {},
  );
  await assert.rejects(
    service.command(
      tournament,
      matchId,
      {
        id: legacyId,
        expectedRevision: 7,
        reason: 'QA correction',
        type: 'RESET',
        impactToken: '0'.repeat(64),
      },
      actor,
    ),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.equal(writes, 0);
});

test('offline replay with a discontinuous version rolls back the entire batch', async () => {
  const h = harness();
  const before = h.snapshot();
  await assert.rejects(
    h.send(
      h.packet([
        { id: randomUUID(), expectedVersion: before.row.state.version, type: 'START' },
        { id: randomUUID(), expectedVersion: before.row.state.version + 2, type: 'STOP' },
      ]),
    ),
    conflict('VERSION_CONFLICT'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('a concurrent unique-ID collision returns conflict and rolls back state and audit', async () => {
  const h = harness({ collideOnWrite: true });
  const before = h.snapshot();
  await assert.rejects(
    h.send(
      h.packet([{ id: randomUUID(), expectedVersion: before.row.state.version, type: 'START' }]),
    ),
    conflict('COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});

test('online commands cannot silently discard an offline event journal', async () => {
  const h = harness({ offline: false });
  const before = h.snapshot();
  await assert.rejects(
    h.send({ id: randomUUID(), expectedVersion: 7, type: 'START', events: [] }),
    httpError(400),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('LIVE heartbeat releases unresponsive connections and retains clients that answer pong', async () => {
  const live = new LiveService({}, {});
  live.allowed = async () => true;
  const calls = { ping: 0, terminate: 0 };
  const socket = {
    readyState: 1,
    ping: () => calls.ping++,
    terminate: () => calls.terminate++,
  };
  const client = { tournamentId: tournament, req: {}, alive: true };
  live.sockets.set(socket, client);
  await live.heartbeat();
  assert.deepEqual(calls, { ping: 1, terminate: 0 });
  client.alive = true; // The socket's pong listener marks this on real connections.
  await live.heartbeat();
  assert.deepEqual(calls, { ping: 2, terminate: 0 });
  await live.heartbeat();
  assert.deepEqual(calls, { ping: 2, terminate: 1 });
});
