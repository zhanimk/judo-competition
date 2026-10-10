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
const actor = {
  id: randomUUID(),
  name: 'Administrator',
  role: 'ORGANIZER',
  sessionId: randomUUID(),
  tatamiId: null,
};
const deviceId = randomUUID();
const controlGeneration = 4;
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
      offlineControlGeneration: offline ? controlGeneration : null,
      winnerEntryId: null,
      confirmedAt: null,
      updatedAt: new Date('2026-10-09T01:00:00.000Z'),
      draw: { categoryId, category: { tournamentId: tournament } },
    },
    events: structuredClone(oldEvents),
    accessCommands: [],
    audit: [],
    matStatus: 'BUSY',
    mat: {
      id: mat,
      tournamentId: tournament,
      controllerSessionId: actor.sessionId,
      controllerActorId: actor.id,
      controllerDeviceId: deviceId,
      controlGeneration,
      accessRevision: 0,
    },
    session: {
      id: actor.sessionId,
      userId: actor.id,
      user: { id: actor.id, role: actor.role, name: actor.name },
      expiresAt: new Date('2099-01-01'),
      tatamiId: null,
      invitationId: null,
    },
  };
  saved.entries = [saved.row.whiteEntryId, saved.row.blueEntryId].map((id) => ({
    id,
    categoryId,
    athleteId: randomUUID(),
    archivedAt: null,
  }));
  const notices = [];
  const db = {
    contest: {
      findMany: async () => (saved.row.status === 'ACTIVE' ? [structuredClone(saved.row)] : []),
    },
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
        accessCommand: {
          findFirst: async ({ where }) =>
            staged.accessCommands.find((command) => where.id.in.includes(command.id)) ?? null,
        },
        session: { findUnique: async () => structuredClone(staged.session) },
        tournament: { findUnique: async () => ({ id: tournament, ownerId: actor.id }) },
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
          findUnique: async () => structuredClone(staged.mat),
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
    mutate: (callback) => callback(saved),
    notices,
    packet(events, extra = {}) {
      return {
        id: randomUUID(),
        deviceId,
        controlGeneration,
        type: 'OFFLINE_SYNC',
        sessionId: offlineSession,
        expectedVersion: saved.row.revision,
        events,
        ...extra,
      };
    },
    send: (dto) => service.command(mat, matchId, { deviceId, controlGeneration, ...dto }, actor),
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
  const base = { id: randomUUID(), expectedVersion: 0, deviceId, controlGeneration };
  const invalid = [
    { type: 'AWARD' },
    { type: 'AWARD', side: 'WHITE' },
    { type: 'HOLD' },
    { type: 'REVOKE' },
    { type: 'OFFLINE_OPEN' },
    { type: 1 },
    { type: 'STOP', expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'STOP', deviceId: undefined },
    { type: 'STOP', controlGeneration: undefined },
    { type: 'STOP', deviceId: 'invalid' },
    { type: 'STOP', controlGeneration: -1 },
    { type: 'STOP', controlGeneration: 1.5 },
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
    accessCommand: { findFirst: async () => null },
    session: {
      findUnique: async () => ({
        id: actor.sessionId,
        userId: actor.id,
        user: { id: actor.id, role: actor.role },
        expiresAt: new Date('2099-01-01'),
      }),
    },
    tournament: { findUnique: async () => ({ id: tournament, ownerId: actor.id }) },
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

test('new sporting mutations require the exact device and control generation without any bypass', async () => {
  for (const [grant, reason] of [
    [{ deviceId: undefined }, 'CONTROL_REQUIRED'],
    [{ controlGeneration: undefined }, 'CONTROL_REQUIRED'],
    [{ deviceId: randomUUID() }, 'CONTROL_HELD'],
    [{ controlGeneration: controlGeneration - 1 }, 'CONTROL_GENERATION_STALE'],
  ]) {
    const h = harness({ offline: false });
    const before = h.snapshot();
    await assert.rejects(
      h.send({ id: randomUUID(), expectedVersion: 7, type: 'START', ...grant }),
      conflict(reason),
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('exact acknowledged sporting receipts survive later grant invalidation but require a live actor', async () => {
  const h = harness({ offline: false });
  const command = { id: randomUUID(), expectedVersion: 7, type: 'START' };
  const original = await h.send(command);
  h.mutate((saved) => {
    saved.mat.controlGeneration += 1;
    saved.mat.controllerSessionId = randomUUID();
    saved.mat.controllerActorId = randomUUID();
    saved.mat.controllerDeviceId = randomUUID();
  });
  const afterTakeover = h.snapshot();
  assert.deepEqual(await h.send(command), original);
  assert.deepEqual(h.snapshot(), afterTakeover);
  await assert.rejects(
    h.send({ ...command, id: randomUUID(), expectedVersion: original.revision, type: 'STOP' }),
    conflict('CONTROL_GENERATION_STALE'),
  );
  h.mutate((saved) => {
    saved.session = null;
  });
  const afterLogout = h.snapshot();
  await assert.rejects(h.send(command), httpError(401));
  assert.deepEqual(h.snapshot(), afterLogout);
});

test('an acknowledged command cannot expose another actor receipt even if its payload is exact', async () => {
  const h = harness({ offline: false });
  const command = { id: randomUUID(), expectedVersion: 7, type: 'START' };
  await h.send(command);
  h.mutate((saved) => {
    saved.events[0].actorId = randomUUID();
  });
  const before = h.snapshot();
  await assert.rejects(h.send(command), conflict('COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
});

test('a legacy or previous-generation offline reservation requires administrative review', async () => {
  for (const previousGeneration of [null, controlGeneration - 1]) {
    const h = harness();
    h.mutate((saved) => {
      saved.row.offlineControlGeneration = previousGeneration;
    });
    const before = h.snapshot();
    await assert.rejects(h.send(h.packet([])), conflict('OFFLINE_CONTROL_STALE'));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('Access command IDs share the sporting envelope and offline event namespace', async () => {
  for (const nested of [false, true]) {
    const h = harness();
    const reserved = randomUUID();
    h.mutate((saved) => saved.accessCommands.push({ id: reserved }));
    const before = h.snapshot();
    const packet = nested
      ? h.packet([{ id: reserved, expectedVersion: before.row.state.version, type: 'START' }])
      : h.packet([], { id: reserved });
    await assert.rejects(h.send(packet), conflict('COMMAND_ID_REUSED'));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('tick pauses an expired holder once, preserving hold, scores, elapsed time and sticky ownership', async () => {
  const h = harness({ offline: false });
  h.mutate((saved) => {
    let value = applyCommand(saved.row.state, {
      id: randomUUID(),
      expectedVersion: saved.row.state.version,
      type: 'START',
    });
    value = applyCommand(value, {
      id: randomUUID(),
      expectedVersion: value.version,
      type: 'HOLD',
      side: 'WHITE',
    });
    value.receipts = {};
    saved.row.state = value;
    saved.session.expiresAt = new Date('2000-01-01');
    saved.row.clockEpoch = h.service.epoch;
    saved.row.clockAnchorMs = 0;
  });
  const before = h.snapshot();
  await h.service.tick();
  const paused = h.snapshot();
  assert.equal(paused.row.status, 'ACTIVE');
  assert.equal(paused.row.state.status, 'PAUSED');
  assert.deepEqual(paused.row.state.hold, before.row.state.hold);
  assert.deepEqual(paused.row.state.awards, before.row.state.awards);
  assert.equal(paused.row.state.elapsedMs, before.row.state.elapsedMs);
  assert.equal(paused.row.state.goldenMs, before.row.state.goldenMs);
  assert.equal(paused.row.revision, before.row.revision + 1);
  assert.equal(paused.row.state.version, before.row.state.version + 1);
  assert.equal(paused.row.clockAnchorMs, null);
  assert.deepEqual(paused.mat, before.mat);
  assert.equal(paused.matStatus, 'BUSY');
  assert.equal(paused.events.at(-1).type, 'CONTROL_LOST_PAUSED');
  assert.equal(paused.events.at(-1).payload.clockUncertain, true);
  assert.equal(paused.audit.at(-1).action, 'MATCH_CONTROL_LOST_PAUSED');
  await h.service.tick();
  assert.deepEqual(h.snapshot(), paused);
});

test('tick pauses expired offline RUNNING snapshots without clearing the lease or its generation', async () => {
  const h = harness();
  h.mutate((saved) => {
    const value = applyCommand(saved.row.state, {
      id: randomUUID(),
      expectedVersion: saved.row.state.version,
      type: 'START',
    });
    value.receipts = {};
    saved.row.state = value;
    saved.session.expiresAt = new Date('2000-01-01');
  });
  const before = h.snapshot();
  await h.service.tick();
  const paused = h.snapshot();
  assert.equal(paused.row.status, 'ACTIVE');
  assert.equal(paused.row.state.status, 'PAUSED');
  assert.equal(paused.row.offlineSessionId, before.row.offlineSessionId);
  assert.equal(paused.row.offlineActorId, before.row.offlineActorId);
  assert.equal(paused.row.offlineControlGeneration, before.row.offlineControlGeneration);
  assert.equal(paused.row.state.elapsedMs, before.row.state.elapsedMs);
  assert.equal(paused.row.state.goldenMs, before.row.state.goldenMs);
  assert.deepEqual(paused.row.state.awards, before.row.state.awards);
  assert.deepEqual(paused.mat, before.mat);
  assert.equal(paused.matStatus, 'BUSY');
  assert.equal(paused.events.at(-1).type, 'CONTROL_LOST_PAUSED');
  assert.equal(paused.events.at(-1).payload.clockUncertain, true);
  const packet = h.packet([]);
  await assert.rejects(h.send(packet), httpError(401));
  assert.deepEqual(h.snapshot(), paused);
  await h.service.tick();
  assert.deepEqual(h.snapshot(), paused);
});

test('tick never advances a valid offline holder clock or rewrites its saved journal state', async () => {
  const h = harness();
  h.mutate((saved) => {
    const value = applyCommand(saved.row.state, {
      id: randomUUID(),
      expectedVersion: saved.row.state.version,
      type: 'START',
    });
    value.receipts = {};
    saved.row.state = value;
    saved.row.clockEpoch = h.service.epoch;
    saved.row.clockAnchorMs = 0;
  });
  const before = h.snapshot();
  await h.service.tick();
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});
