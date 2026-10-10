import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { createMatch, applyCommand } from '@judo/engine/match';
const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const apiModule = (path) => import(new URL(`${apiDist}/modules/${path}.js`, import.meta.url));
const { AuthService } = await apiModule('auth/auth.service');
const { MatchesService } = await apiModule('matches/matches.service');
const { MatchCommandDto } = await apiModule('matches/matches.dto');
const { TatamisService } = await apiModule('tatamis/tatamis.service');
const { LiveService } = await apiModule('matches/live.service');
const { ControlService } = await apiModule('control/control.service');
const { hasOfflineOwnership, hasIncompleteOfflineOwnership } = await apiModule(
  'matches/offline-ownership',
);

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
function harness({
  offline = true,
  oldEvents = [],
  collideOnWrite = false,
  failAudit = false,
} = {}) {
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
        auditEvent: {
          create: async ({ data }) => {
            if (failAudit) throw new Error('audit unavailable');
            staged.audit.push(structuredClone(data));
          },
        },
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
    await assert.rejects(
      h.send(h.packet([])),
      conflict(
        previousGeneration === null ? 'OFFLINE_METADATA_INCOMPLETE' : 'OFFLINE_CONTROL_STALE',
      ),
    );
    assert.deepEqual(h.snapshot(), before);
  }
});

test('offline ownership treats every metadata field, including generation zero, as a saved lease', () => {
  assert.equal(hasOfflineOwnership({}), false);
  assert.equal(hasIncompleteOfflineOwnership({}), false);
  assert.equal(
    hasOfflineOwnership({
      offlineSessionId: null,
      offlineActorId: null,
      offlineControlGeneration: null,
    }),
    false,
  );
  for (const row of [
    { offlineSessionId: offlineSession },
    { offlineActorId: actor.id },
    { offlineControlGeneration: 0 },
    { offlineSessionId: offlineSession, offlineActorId: actor.id },
    { offlineSessionId: offlineSession, offlineControlGeneration: 0 },
    { offlineActorId: actor.id, offlineControlGeneration: 0 },
    { offlineSessionId: '', offlineActorId: actor.id, offlineControlGeneration: 0 },
  ]) {
    assert.equal(hasOfflineOwnership(row), true);
    assert.equal(hasIncompleteOfflineOwnership(row), true);
  }
  const complete = {
    offlineSessionId: offlineSession,
    offlineActorId: actor.id,
    offlineControlGeneration: 0,
  };
  assert.equal(hasOfflineOwnership(complete), true);
  assert.equal(hasIncompleteOfflineOwnership(complete), false);
});

const incompleteLeases = [
  { offlineSessionId: offlineSession },
  { offlineActorId: actor.id },
  { offlineControlGeneration: 0 },
  { offlineSessionId: offlineSession, offlineActorId: actor.id },
  { offlineSessionId: offlineSession, offlineControlGeneration: 0 },
  { offlineActorId: actor.id, offlineControlGeneration: 0 },
];

test('new sporting and offline commands cannot replace partial offline metadata or its journal', async () => {
  for (const partial of incompleteLeases) {
    const h = harness({ offline: false });
    h.mutate((saved) => Object.assign(saved.row, partial));
    const before = h.snapshot();
    for (const command of [
      { type: 'AWARD', side: 'WHITE', kind: 'YUKO' },
      { type: 'OFFLINE_OPEN', sessionId: offlineSession },
      { type: 'OFFLINE_SYNC', sessionId: offlineSession, events: [] },
      { type: 'OFFLINE_RELEASE', sessionId: offlineSession, events: [] },
    ]) {
      await assert.rejects(
        h.send({ id: randomUUID(), expectedVersion: before.row.revision, ...command }),
        conflict('OFFLINE_METADATA_INCOMPLETE'),
      );
      assert.deepEqual(h.snapshot(), before);
      assert.equal(h.notices.length, 0);
    }
  }
});

test('exact historical receipts remain read-only after partial offline metadata appears', async () => {
  for (const offline of [false, true])
    for (const partial of incompleteLeases) {
      const h = harness({ offline });
      const command = offline
        ? h.packet([])
        : {
            id: randomUUID(),
            expectedVersion: 7,
            type: 'AWARD',
            side: 'WHITE',
            kind: 'YUKO',
          };
      const original = await h.send(command);
      h.mutate((saved) =>
        Object.assign(saved.row, {
          offlineSessionId: null,
          offlineActorId: null,
          offlineControlGeneration: null,
          ...partial,
        }),
      );
      const before = h.snapshot();
      assert.deepEqual(await h.send(command), original);
      assert.deepEqual(h.snapshot(), before);
      await assert.rejects(
        h.send({
          id: randomUUID(),
          expectedVersion: before.row.revision,
          type: 'AWARD',
          side: 'BLUE',
          kind: 'YUKO',
        }),
        conflict('OFFLINE_METADATA_INCOMPLETE'),
      );
      assert.deepEqual(h.snapshot(), before);
      h.mutate((saved) => {
        saved.session = null;
      });
      const loggedOut = h.snapshot();
      await assert.rejects(h.send(command), httpError(401));
      assert.deepEqual(h.snapshot(), loggedOut);
    }
});

test('partial offline metadata remains visibly offline in the live snapshot', async () => {
  for (const partial of incompleteLeases) {
    const h = harness({ offline: false });
    h.mutate((saved) => Object.assign(saved.row, partial));
    const { row } = h.snapshot();
    row.draw.category.entries = [];
    const service = new MatchesService(
      {
        tatami: {
          findUnique: async () => ({
            tournamentId: tournament,
            number: 1,
            tournament: { name: 'QA', status: 'RUNNING' },
          }),
        },
        contest: { findFirst: async ({ where }) => (where.status === 'ACTIVE' ? row : null) },
      },
      {},
      {},
    );
    assert.equal((await service.view(mat)).currentMatch.offlineActive, true);
  }
});

test('valid control holder never advances or reconciles a partial offline journal', async () => {
  for (const partial of incompleteLeases) {
    const h = harness({ offline: false });
    h.mutate((saved) => {
      Object.assign(saved.row, partial);
      saved.row.state = applyCommand(saved.row.state, {
        id: randomUUID(),
        expectedVersion: saved.row.state.version,
        type: 'START',
      });
      saved.row.clockEpoch = h.service.epoch;
      saved.row.clockAnchorMs = 0;
    });
    const before = h.snapshot();
    await h.service.tick();
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('expired holder safely pauses a partial offline journal without clearing or rebinding its metadata', async () => {
  for (const partial of incompleteLeases) {
    const h = harness({ offline: false });
    h.mutate((saved) => {
      Object.assign(saved.row, partial);
      saved.row.state = applyCommand(saved.row.state, {
        id: randomUUID(),
        expectedVersion: saved.row.state.version,
        type: 'START',
      });
      saved.session.expiresAt = new Date(0);
    });
    const before = h.snapshot();
    await h.service.tick();
    const paused = h.snapshot();
    assert.equal(paused.row.status, 'ACTIVE');
    assert.equal(paused.row.state.status, 'PAUSED');
    assert.equal(paused.row.state.elapsedMs, before.row.state.elapsedMs);
    assert.deepEqual(paused.row.state.awards, before.row.state.awards);
    for (const field of ['offlineSessionId', 'offlineActorId', 'offlineControlGeneration'])
      assert.equal(paused.row[field], before.row[field]);
    assert.deepEqual(paused.mat, before.mat);
    assert.equal(paused.events.at(-1).type, 'CONTROL_LOST_PAUSED');
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

function startTickFixture(h, { lead = false, hold = false, golden = false } = {}) {
  h.mutate((saved) => {
    let state = saved.row.state;
    const command = (type, extra = {}) => {
      state = applyCommand(state, {
        id: randomUUID(),
        expectedVersion: state.version,
        type,
        ...extra,
      });
    };
    if (golden) {
      command('START');
      command('ADVANCE', { ms: state.rules.durationMs });
      command('GOLDEN');
    }
    if (lead) command('AWARD', { side: 'WHITE', kind: 'YUKO' });
    command('START');
    if (hold) command('HOLD', { side: 'BLUE' });
    state.receipts = {};
    saved.row.state = state;
    saved.row.clockEpoch = h.service.epoch;
    saved.row.clockAnchorMs = 0;
  });
}

test('terminal clock expiry records one atomic transition and revision for tie or TIME lead', async () => {
  for (const lead of [false, true]) {
    const h = harness({ offline: false });
    startTickFixture(h, { lead });
    const before = h.snapshot();
    await h.service.tick();
    const after = h.snapshot();
    assert.equal(after.row.status, 'ACTIVE', 'a terminal clock transition is still unconfirmed');
    assert.equal(after.row.state.status, lead ? 'PROVISIONAL' : 'DECISION');
    assert.deepEqual(after.row.state.outcome, lead ? { winner: 'WHITE', reason: 'TIME' } : null);
    assert.equal(after.row.revision, before.row.revision + 1);
    assert.equal(after.row.state.version, before.row.state.version + 1);
    assert.equal(after.row.state.elapsedMs, rules.durationMs);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].type, 'CLOCK_TERMINAL_REACHED');
    assert.equal(after.events[0].actorId, 'SYSTEM');
    assert.equal(after.events[0].payload.cause, 'REGULAR_TIME_EXPIRED');
    assert.equal(after.events[0].payload.revision, after.row.revision);
    assert.deepEqual(after.events[0].payload.before, before.row.state);
    assert.deepEqual(after.events[0].payload.state, after.row.state);
    assert.equal(after.audit.length, 1);
    assert.equal(after.audit[0].action, 'MATCH_CLOCK_TERMINAL_REACHED');
    assert.equal(after.audit[0].tournamentId, tournament);
    assert.equal(after.audit[0].entityId, matchId);
    assert.deepEqual(after.audit[0].payload, after.events[0].payload);
    assert.deepEqual(after.mat, before.mat);
    assert.equal(after.matStatus, 'BUSY');
    assert.equal(h.notices.length, 1);
    await h.service.tick();
    assert.deepEqual(
      h.snapshot(),
      after,
      'repeated stopped tick cannot duplicate revision/event/audit',
    );
    assert.equal(h.notices.length, 1);
  }
});

test('hold completion logs its score once and one terminal-clock boundary in REGULAR and GOLDEN', async () => {
  for (const golden of [false, true]) {
    const h = harness({ offline: false });
    startTickFixture(h, { hold: true, golden });
    const before = h.snapshot();
    await h.service.tick();
    const after = h.snapshot();
    assert.equal(after.row.state.status, 'PROVISIONAL');
    assert.deepEqual(after.row.state.outcome, {
      winner: 'BLUE',
      reason: golden ? 'GOLDEN_SCORE' : 'IPPON',
    });
    assert.equal(after.row.revision, before.row.revision + 1);
    assert.equal(
      after.row.state.awards.filter((award) => award.active && award.kind === 'IPPON').length,
      1,
    );
    assert.equal(after.events.filter((event) => event.type === 'HOLD_SCORE_UPDATED').length, 1);
    const transitions = after.events.filter((event) => event.type === 'CLOCK_TERMINAL_REACHED');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].payload.cause, 'HOLD_SCORE_FINISHED');
    assert.deepEqual(transitions[0].payload.before, before.row.state);
    assert.deepEqual(transitions[0].payload.state, after.row.state);
    assert.equal(after.audit.length, 1);
    assert.deepEqual(after.audit[0].payload, transitions[0].payload);
    await h.service.tick();
    assert.deepEqual(h.snapshot(), after);
  }
});

test('current-profile Golden Score hold finishes at the first 5-second YUKO with one boundary audit', async () => {
  const h = harness({ offline: false });
  h.mutate((saved) => {
    saved.row.state.rules.holdThresholds = [
      { ms: 5000, score: 'YUKO' },
      { ms: 10000, score: 'WAZA_ARI' },
      { ms: 20000, score: 'IPPON' },
    ];
  });
  startTickFixture(h, { hold: true, golden: true });
  const before = h.snapshot();
  await h.service.tick();
  const after = h.snapshot();
  assert.equal(after.row.state.status, 'PROVISIONAL');
  assert.deepEqual(after.row.state.outcome, { winner: 'BLUE', reason: 'GOLDEN_SCORE' });
  assert.equal(after.row.state.goldenMs, 5000);
  assert.equal(after.row.state.elapsedMs, rules.durationMs);
  assert.equal(after.row.revision, before.row.revision + 1);
  assert.deepEqual(
    after.row.state.awards.filter((award) => award.active).map((award) => award.kind),
    ['YUKO'],
  );
  assert.equal(after.events.filter((event) => event.type === 'HOLD_SCORE_UPDATED').length, 1);
  const transitions = after.events.filter((event) => event.type === 'CLOCK_TERMINAL_REACHED');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].payload.cause, 'HOLD_SCORE_FINISHED');
  assert.deepEqual(transitions[0].payload.state, after.row.state);
  assert.equal(after.audit.length, 1);
  assert.deepEqual(after.audit[0].payload, transitions[0].payload);
  await h.service.tick();
  assert.deepEqual(h.snapshot(), after);
});

test('failed terminal audit rolls back clock, row revision, boundary and hold award atomically', async () => {
  for (const hold of [false, true]) {
    const h = harness({ offline: false, failAudit: true });
    startTickFixture(h, { hold });
    const before = h.snapshot();
    await assert.rejects(h.service.tick(), /audit unavailable/);
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
    assert.equal(h.service.ticking, false, 'a failed audit does not disable later timer ticks');
  }
});

test('an ordinary online clock advance changes no command revision or transition event/audit', async () => {
  const h = harness({ offline: false });
  startTickFixture(h);
  h.mutate((saved) => {
    saved.row.clockAnchorMs = Number(process.hrtime.bigint() / 1000000n) - 20;
  });
  const before = h.snapshot();
  await h.service.tick();
  const after = h.snapshot();
  assert.equal(after.row.state.status, 'RUNNING');
  assert.ok(after.row.state.elapsedMs >= 20 && after.row.state.elapsedMs < rules.durationMs);
  assert.equal(after.row.state.version, before.row.state.version + 1);
  assert.equal(after.row.revision, before.row.revision);
  assert.deepEqual(after.row.state.awards, before.row.state.awards);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.audit, before.audit);
  assert.deepEqual(after.mat, before.mat);
});
