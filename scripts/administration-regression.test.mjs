import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

const dist = process.env.JUDO_TEST_API_DIST ?? 'apps/api/dist';
const load = (path) => import(pathToFileURL(resolve(dist, path)).href);
const { TournamentsService } = await load('modules/tournaments/tournaments.service.js');
const { CreateTournamentDto, CreateCategoryDto, AdministrationCommandDto } = await load(
  'modules/tournaments/dto.js',
);
const owner = {
  id: randomUUID(),
  sessionId: randomUUID(),
  role: 'ORGANIZER',
  name: 'QA',
  tatamiId: null,
};
const other = {
  id: randomUUID(),
  sessionId: randomUUID(),
  role: 'SUPER_ADMIN',
  name: 'Other QA',
  tatamiId: null,
};
const tournamentId = randomUUID(),
  matId = randomUUID(),
  categoryId = randomUUID();
const errorIs = (status, message) => (error) =>
  error.getStatus() === status && error.message === message;
const createCommand = () => ({
  id: randomUUID(),
  name: 'QA competition',
  city: 'Алматы',
  venue: 'QA arena',
  startDate: '2026-10-10',
  endDate: '2026-10-10',
  tatamiCount: 2,
});
const categoryCommand = (revision = 0) => ({
  id: randomUUID(),
  expectedRevision: revision,
  name: 'QA U15 -30',
  format: 'ROUND_ROBIN',
  gender: 'MALE',
  birthYearFrom: 2012,
  birthYearTo: 2013,
  maxWeightGrams: 30000,
  minWeightGrams: null,
  durationSeconds: 180,
});

function harness({ failAudit = false, failOutbox = false } = {}) {
  let saved = {
    tournaments: [
      {
        id: tournamentId,
        ownerId: owner.id,
        administrationRevision: 0,
        status: 'DRAFT',
        publishedAt: null,
        rulesSnapshot: {
          version: 'custom-2026-v4',
          drawPolicy: 'REPECHAGE_ONLY',
          tieBreak: 'REMATCH',
          tieRanking: 'WINS_ONLY',
          tieMany: 'ADMIN_REVIEW',
        },
        tatamis: [{ id: matId, number: 1 }],
        categories: [],
      },
    ],
    sessions: [owner, other].map((user) => ({
      id: user.sessionId,
      userId: user.id,
      invitationId: null,
      expiresAt: new Date(Date.now() + 3600000),
      user: { id: user.id, role: user.role },
    })),
    commands: [],
    audit: [],
    outbox: [],
    foreignIds: [],
  };
  const locks = [],
    notices = [];
  let chain = Promise.resolve();
  const txFor = (data) => ({
    $queryRaw: async (strings) => {
      locks.push(strings.join('?'));
      return [];
    },
    session: {
      findUnique: async ({ where }) =>
        structuredClone(data.sessions.find((session) => session.id === where.id) ?? null),
    },
    tournament: {
      findUnique: async ({ where }) =>
        structuredClone(data.tournaments.find((t) => t.id === where.id) ?? null),
      findUniqueOrThrow: async ({ where }) => {
        const row = data.tournaments.find((t) => t.id === where.id);
        assert.ok(row);
        return structuredClone(row);
      },
      create: async ({ data: fields }) => {
        const t = {
          ...fields,
          id: randomUUID(),
          administrationRevision: 0,
          rosterRevision: 0,
          status: 'DRAFT',
          publishedAt: null,
          createdAt: new Date(0),
          tatamis: fields.tatamis.create.map((m) => ({ ...m, id: randomUUID() })),
          categories: [],
        };
        data.tournaments.push(t);
        return structuredClone(t);
      },
      update: async ({ where, data: updates }) => {
        const t = data.tournaments.find((t) => t.id === where.id);
        Object.assign(t, updates, {
          administrationRevision:
            t.administrationRevision + (updates.administrationRevision?.increment ?? 0),
        });
        return structuredClone(t);
      },
    },
    tournamentCommand: {
      findUnique: async ({ where }) =>
        structuredClone(data.commands.find((command) => command.id === where.id) ?? null),
      findFirst: async ({ where }) =>
        data.commands.find((command) => where.id.in.includes(command.id)) ?? null,
      create: async ({ data: command }) => {
        data.commands.push(structuredClone(command));
      },
    },
    category: {
      create: async ({ data: fields }) => {
        const category = {
          ...fields,
          id: randomUUID(),
          _count: { entries: 0 },
          draw: null,
          homeTatamiId: null,
        };
        data.tournaments.find((t) => t.id === fields.tournamentId).categories.push(category);
        return structuredClone(category);
      },
      update: async ({ where, data: updates }) => {
        const c = data.tournaments.flatMap((t) => t.categories).find((c) => c.id === where.id);
        Object.assign(c, updates);
        return structuredClone(c);
      },
    },
    contest: {
      aggregate: async () => ({ _max: { queueOrder: 0 } }),
      update: async ({ where, data: updates }) => {
        const row = data.tournaments
          .flatMap((t) => t.categories)
          .flatMap((c) => c.draw?.contests ?? [])
          .find((row) => row.id === where.id);
        Object.assign(row, updates, {
          revision: row.revision + (updates.revision?.increment ?? 0),
        });
        return structuredClone(row);
      },
    },
    rosterCommand: {
      findFirst: async ({ where }) =>
        data.foreignIds.some((id) => where.id.in.includes(id)) ? { id: 'foreign' } : null,
    },
    accessCommand: { findFirst: async () => null },
    drawCommand: { findFirst: async () => null },
    protocolCommand: { findFirst: async () => null },
    matchEvent: { findFirst: async () => null },
    auditEvent: {
      create: async ({ data: event }) => {
        if (failAudit) throw new Error('audit unavailable');
        data.audit.push(structuredClone(event));
      },
    },
    liveOutbox: {
      create: async ({ data: event }) => {
        if (failOutbox) throw new Error('outbox unavailable');
        data.outbox.push(structuredClone(event));
      },
    },
  });
  const db = {
    $transaction: async (callback) => {
      const operation = chain.then(async () => {
        const staged = structuredClone(saved),
          response = await callback(txFor(staged));
        saved = staged;
        return response;
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
  const service = new TournamentsService(
    db,
    { notify: (event) => notices.push(event) },
    { owner: async () => {} },
  );
  return {
    service,
    locks,
    notices,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => fn(saved),
    command: (revision = saved.tournaments[0].administrationRevision) => ({
      id: randomUUID(),
      expectedRevision: revision,
    }),
    readyCategory: () => {
      saved.tournaments[0].categories = [
        {
          id: categoryId,
          name: 'QA ready',
          homeTatamiId: null,
          _count: { entries: 2 },
          durationSeconds: 180,
          format: 'ROUND_ROBIN',
          draw: {
            status: 'CONFIRMED',
            snapshot: { algorithm: 'custom-round-robin-v1' },
            contests: [
              {
                id: randomUUID(),
                key: 'r1-m1',
                round: 1,
                status: 'READY',
                tatamiId: null,
                queueOrder: null,
                revision: 0,
              },
            ],
          },
        },
      ];
    },
  };
}

test('administrative DTOs require fresh UUIDs and integer versions; create command UUID is distinct from resource UUID', async () => {
  assert.equal((await validate(plainToInstance(CreateTournamentDto, createCommand()))).length, 0);
  assert.equal((await validate(plainToInstance(CreateCategoryDto, categoryCommand()))).length, 0);
  for (const invalid of [
    {},
    { id: randomUUID() },
    { id: 'bad', expectedRevision: 0 },
    { id: randomUUID(), expectedRevision: -1 },
    { id: randomUUID(), expectedRevision: '0' },
    { id: randomUUID(), expectedRevision: 1.5 },
  ])
    assert.ok((await validate(plainToInstance(AdministrationCommandDto, invalid))).length);
  const { id: _, ...oldCreate } = createCommand();
  assert.ok((await validate(plainToInstance(CreateTournamentDto, oldCreate))).length);
  const { id: __, expectedRevision: ___, ...oldCategory } = categoryCommand();
  assert.ok((await validate(plainToInstance(CreateCategoryDto, oldCategory))).length);
});

test('lost create response and concurrent exact retries produce one tournament, receipt, audit and outbox', async () => {
  const h = harness(),
    dto = createCommand();
  const [first, retry] = await Promise.all([
    h.service.create(dto, owner),
    h.service.create(dto, owner),
  ]);
  assert.deepEqual(retry, first);
  assert.notEqual(first.id, dto.id);
  assert.equal(first.administrationRevision, 0);
  const after = h.snapshot();
  assert.equal(after.tournaments.length, 2);
  assert.equal(after.commands.length, 1);
  assert.equal(after.audit.length, 1);
  assert.equal(after.outbox.length, 1);
  h.mutate((state) => {
    state.tournaments.find((t) => t.id === first.id).name = 'Later title';
  });
  const later = h.snapshot();
  assert.deepEqual(await h.service.create(dto, owner), first);
  assert.deepEqual(h.snapshot(), later);
  await assert.rejects(
    h.service.create({ ...dto, city: 'Other city' }, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(h.service.create(dto, other), errorIs(409, 'COMMAND_ID_REUSED'));
  assert.match(h.locks[0], /Session/);
});

test('create cannot write after Session expiry, logout, role change or global UUID collision', async () => {
  for (const change of [
    (state) => {
      state.sessions = [];
    },
    (state) => {
      state.sessions[0].expiresAt = new Date(0);
    },
    (state) => {
      state.sessions[0].user.role = 'OPERATOR';
    },
  ]) {
    const h = harness(),
      dto = createCommand();
    h.mutate(change);
    const before = h.snapshot();
    await assert.rejects(h.service.create(dto, owner), errorIs(401, 'AUTH_REQUIRED'));
    assert.deepEqual(h.snapshot(), before);
  }
  const h = harness(),
    dto = createCommand();
  h.mutate((state) => state.foreignIds.push(dto.id));
  const before = h.snapshot();
  await assert.rejects(h.service.create(dto, owner), errorIs(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
});

test('failed audit or durable notice rolls back newly created tournament and original receipt', async () => {
  for (const options of [{ failAudit: true }, { failOutbox: true }]) {
    const h = harness(options),
      before = h.snapshot();
    await assert.rejects(h.service.create(createCommand(), owner), /unavailable/);
    assert.deepEqual(h.snapshot(), before);
  }
});

test('category uses administration version, preserves exact receipt after later start and denies changed actor/target/intent', async () => {
  const h = harness(),
    dto = categoryCommand();
  const first = await h.service.category(tournamentId, dto, owner);
  assert.equal(first.administrationRevision, 1);
  assert.notEqual(first.id, dto.id);
  assert.equal(h.snapshot().tournaments[0].categories.length, 1);
  h.mutate((state) => {
    state.tournaments[0].status = 'RUNNING';
    state.tournaments[0].administrationRevision = 6;
  });
  const later = h.snapshot();
  assert.deepEqual(await h.service.category(tournamentId, dto, owner), first);
  assert.deepEqual(h.snapshot(), later);
  await assert.rejects(
    h.service.category(tournamentId, { ...dto, name: 'Changed category' }, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.service.category(tournamentId, dto, other),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(h.service.category(randomUUID(), dto, other), errorIs(403, 'FORBIDDEN'));
});

test('two fresh administrative commands from one viewed version cannot both change settings', async () => {
  const h = harness(),
    a = categoryCommand(),
    b = { ...categoryCommand(), name: 'QA another' };
  const results = await Promise.allSettled([
    h.service.category(tournamentId, a, owner),
    h.service.category(tournamentId, b, owner),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(errorIs(409, 'ADMINISTRATION_STALE')(rejected.reason));
  assert.equal(h.snapshot().tournaments[0].administrationRevision, 1);
  assert.equal(h.snapshot().commands.length, 1);
  assert.equal(h.snapshot().tournaments[0].categories.length, 1);
});

test('START receipt is immutable, fresh no-op is versioned and rules are approved only once', async () => {
  const h = harness();
  h.readyCategory();
  const dto = h.command();
  const first = await h.service.start(tournamentId, dto, owner);
  assert.equal(first.status, 'RUNNING');
  assert.equal(first.administrationRevision, 1);
  const after = h.snapshot();
  assert.ok(after.tournaments[0].rulesSnapshot.approvedAt);
  assert.equal(after.tournaments[0].categories[0].homeTatamiId, matId);
  assert.deepEqual(await h.service.start(tournamentId, dto, owner), first);
  assert.deepEqual(h.snapshot(), after);
  const noOp = await h.service.start(tournamentId, h.command(), owner);
  assert.equal(noOp.administrationRevision, 2);
  assert.deepEqual(h.snapshot().tournaments[0].rulesSnapshot, after.tournaments[0].rulesSnapshot);
  assert.equal(
    h.snapshot().audit.filter((event) => event.action === 'TOURNAMENT_STARTED').length,
    1,
  );
  assert.match(h.locks[0], /Tournament/);
  assert.match(h.locks[1], /Tatami/);
  assert.match(h.locks[2], /Session/);
});

test('SCHEDULE original response survives a lost delivery and subsequent changes; stale fresh intent rolls back', async () => {
  const h = harness();
  h.readyCategory();
  const dto = h.command();
  const first = await h.service.schedule(tournamentId, dto, owner);
  assert.equal(first.queued, 1);
  assert.equal(first.administrationRevision, 1);
  const after = h.snapshot();
  assert.deepEqual(await h.service.schedule(tournamentId, dto, owner), first);
  assert.deepEqual(h.snapshot(), after);
  await assert.rejects(
    h.service.schedule(tournamentId, { id: randomUUID(), expectedRevision: 0 }, owner),
    errorIs(409, 'ADMINISTRATION_STALE'),
  );
  assert.deepEqual(h.snapshot(), after);
});

test('PUBLISH receipt does not republish or overwrite the immutable date, and expired exact retry cannot read the receipt', async () => {
  const h = harness(),
    dto = h.command();
  const first = await h.service.publish(tournamentId, dto, owner);
  assert.equal(first.administrationRevision, 1);
  assert.ok(first.publishedAt);
  const after = h.snapshot();
  assert.deepEqual(await h.service.publish(tournamentId, dto, owner), first);
  assert.deepEqual(h.snapshot(), after);
  const second = await h.service.publish(tournamentId, h.command(), owner);
  assert.equal(second.publishedAt, first.publishedAt);
  assert.equal(second.administrationRevision, 2);
  assert.equal(
    h.snapshot().audit.filter((event) => event.action === 'TOURNAMENT_PUBLISHED').length,
    1,
  );
  h.mutate((state) => {
    state.sessions = [];
  });
  const expired = h.snapshot();
  await assert.rejects(h.service.publish(tournamentId, dto, owner), errorIs(401, 'AUTH_REQUIRED'));
  assert.deepEqual(h.snapshot(), expired);
});

test('START and category state changes roll back if command audit fails after mutation', async () => {
  const h = harness({ failAudit: true });
  h.readyCategory();
  const before = h.snapshot();
  await assert.rejects(h.service.start(tournamentId, h.command(), owner), /unavailable/);
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(h.service.category(tournamentId, categoryCommand(), owner), /unavailable/);
  assert.deepEqual(h.snapshot(), before);
});
