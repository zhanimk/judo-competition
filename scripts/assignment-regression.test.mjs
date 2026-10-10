import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthService } from '../apps/api/dist/modules/auth/auth.service.js';
import { DrawsService } from '../apps/api/dist/modules/draws/draws.service.js';
import { AssignDto } from '../apps/api/dist/modules/draws/draws.dto.js';

const owner = { id: randomUUID(), role: 'ORGANIZER' };
const tournamentId = randomUUID();
const categoryId = randomUUID();
const matA = randomUUID();
const matB = randomUUID();
const matchA = randomUUID();
const matchB = randomUUID();
const httpError = (status, message) => (error) =>
  error.getStatus() === status && (!message || error.message === message);

function harness({ legacyEvents = [], collision = false, failAudit = false } = {}) {
  const makeRow = (id) => ({
    id,
    drawId: 'confirmed-draw',
    whiteEntryId: randomUUID(),
    blueEntryId: randomUUID(),
    status: 'READY',
    revision: 0,
    tatamiId: null,
    queueOrder: null,
    state: null,
    offlineSessionId: null,
    updatedAt: new Date('2026-10-09T02:00:00.000Z'),
    draw: { status: 'CONFIRMED', categoryId },
  });
  let saved = {
    rows: { [matchA]: makeRow(matchA), [matchB]: makeRow(matchB) },
    category: { id: categoryId, tournamentId, homeTatamiId: null },
    events: structuredClone(legacyEvents),
    audit: [],
  };
  const notices = [];
  let chain = Promise.resolve();
  const readRow = (data, id) => {
    const row = data.rows[id];
    return row ? structuredClone({ ...row, draw: { ...row.draw, category: data.category } }) : null;
  };
  const db = {
    contest: { findUnique: async ({ where }) => readRow(saved, where.id) },
    tournament: {
      findFirst: async ({ where }) =>
        where.id === tournamentId && where.ownerId === owner.id ? { id: tournamentId } : null,
    },
    async $transaction(callback) {
      const operation = chain.then(async () => {
        const staged = structuredClone(saved);
        const tx = {
          $queryRaw: async () => [],
          accessCommand: { findFirst: async () => null },
          rosterCommand: { findFirst: async () => null },
          contest: {
            findUniqueOrThrow: async ({ where }) => readRow(staged, where.id),
            aggregate: async ({ where }) => ({
              _max: {
                queueOrder:
                  Math.max(
                    0,
                    ...Object.values(staged.rows)
                      .filter((row) => row.tatamiId === where.tatamiId)
                      .map((row) => row.queueOrder ?? 0),
                  ) || null,
              },
            }),
            update: async ({ where, data }) => {
              const row = staged.rows[where.id];
              staged.rows[where.id] = {
                ...row,
                ...data,
                revision: row.revision + (data.revision?.increment ?? 0),
                updatedAt: new Date(row.updatedAt.getTime() + 1),
              };
              return readRow(staged, where.id);
            },
          },
          tatami: {
            findFirst: async ({ where }) =>
              [matA, matB].includes(where.id) && where.tournamentId === tournamentId
                ? { id: where.id, tournamentId }
                : null,
          },
          category: {
            findUniqueOrThrow: async () => structuredClone(staged.category),
            update: async ({ data }) => {
              staged.category = { ...staged.category, ...data };
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
            create: async ({ data }) => {
              if (collision || staged.events.some((event) => event.id === data.id))
                throw new Prisma.PrismaClientKnownRequestError('duplicate command', {
                  code: 'P2002',
                  clientVersion: 'test',
                });
              staged.events.push(structuredClone(data));
            },
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
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
  const createService = () =>
    new DrawsService({ notify: (notice) => notices.push(notice) }, db, new AuthService(db));
  let service = createService();
  return {
    notices,
    snapshot: () => structuredClone(saved),
    mutateRow: (id, changes) => {
      saved.rows[id] = { ...saved.rows[id], ...structuredClone(changes) };
    },
    command: (extra = {}) => ({ id: randomUUID(), expectedRevision: 0, tatamiId: matA, ...extra }),
    send: (dto, id = matchA, user = owner) => service.assign(id, dto, user),
    restart: () => {
      service = createService();
    },
  };
}

test('assignment DTO requires command ID, safe revision and destination UUID', async () => {
  const valid = { id: randomUUID(), expectedRevision: 0, tatamiId: matA };
  const invalid = [
    { ...valid, id: undefined },
    { ...valid, id: 'invalid' },
    { ...valid, tatamiId: undefined },
    { ...valid, tatamiId: 'another-mat' },
    { ...valid, expectedRevision: undefined },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 0.5 },
    { ...valid, expectedRevision: '0' },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  assert.equal((await validate(plainToInstance(AssignDto, valid))).length, 0);
  for (const payload of invalid)
    assert.ok((await validate(plainToInstance(AssignDto, payload))).length > 0);
});

test('assignment atomically pins category, queues bout, increments revision and records receipt/audit', async () => {
  const h = harness();
  const dto = h.command();
  const result = await h.send(dto);
  const saved = h.snapshot();
  assert.deepEqual(result, {
    id: matchA,
    revision: 1,
    status: 'READY',
    tatamiId: matA,
    queueOrder: 1,
    updatedAt: '2026-10-09T02:00:00.001Z',
  });
  assert.equal(saved.category.homeTatamiId, matA);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.audit.length, 1);
  assert.deepEqual(saved.events[0].payload, { command: dto, response: result });
  assert.equal(saved.audit[0].payload.before.revision, 0);
  assert.deepEqual(saved.audit[0].payload.after, result);
});

test('lost assignment response can be retried after service restart without rewriting active bout', async () => {
  const h = harness();
  const dto = h.command();
  const first = await h.send(dto);
  h.mutateRow(matchA, {
    status: 'ACTIVE',
    revision: 9,
    tatamiId: matB,
    queueOrder: 8,
    state: { awards: [], status: 'RUNNING', elapsedMs: 1900 },
    updatedAt: new Date('2026-10-09T02:10:00.000Z'),
  });
  const before = h.snapshot();
  h.restart();
  assert.deepEqual(await h.send(dto), first);
  assert.deepEqual(h.snapshot(), before);
});

test('same command ID with changed destination, revision or contest is rejected', async () => {
  const h = harness();
  const dto = h.command();
  await h.send(dto);
  const before = h.snapshot();
  for (const payload of [
    { ...dto, tatamiId: matB },
    { ...dto, expectedRevision: 1 },
  ])
    await assert.rejects(h.send(payload), httpError(409, 'COMMAND_ID_REUSED'));
  await assert.rejects(h.send(dto, matchB), httpError(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
});

test('parallel duplicate assignment requests return one exact response and one audit entry', async () => {
  const h = harness();
  const dto = h.command();
  const results = await Promise.all([h.send(dto), h.send(dto)]);
  assert.deepEqual(results[0], results[1]);
  const saved = h.snapshot();
  assert.equal(saved.rows[matchA].revision, 1);
  assert.equal(saved.rows[matchA].queueOrder, 1);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.audit.length, 1);
});

test('parallel competing assignments accept only the current revision', async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.send(h.command()),
    h.send(h.command({ tatamiId: matB })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.message,
    'VERSION_CONFLICT',
  );
  assert.equal(h.snapshot().events.length, 1);
  assert.equal(h.snapshot().audit.length, 1);
});

test('a stale snapshot or a new command for an already assigned bout cannot reorder its queue', async () => {
  const h = harness();
  await h.send(h.command());
  const before = h.snapshot();
  await assert.rejects(h.send(h.command()), httpError(409, 'VERSION_CONFLICT'));
  await assert.rejects(
    h.send(h.command({ expectedRevision: 1 })),
    httpError(409, 'MATCH_NOT_ASSIGNABLE'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('foreign tatami, fixed-category mismatch and non-ready dependencies leave the bout unchanged', async () => {
  const h = harness();
  const before = h.snapshot();
  await assert.rejects(
    h.send(h.command({ tatamiId: randomUUID() })),
    httpError(400, 'TATAMI_MISMATCH'),
  );
  assert.deepEqual(h.snapshot(), before);
  await h.send(h.command());
  const pinned = h.snapshot();
  await assert.rejects(
    h.send(h.command({ tatamiId: matB }), matchB),
    httpError(409, 'CATEGORY_TATAMI_LOCKED'),
  );
  assert.deepEqual(h.snapshot(), pinned);
  for (const changes of [
    { status: 'WAITING' },
    { status: 'ACTIVE', tatamiId: matA, state: { awards: [], status: 'PAUSED' } },
    { status: 'CONFIRMED', tatamiId: matA },
    { whiteEntryId: null },
    { blueEntryId: null },
    { draw: { status: 'PREVIEW', categoryId } },
    { offlineSessionId: randomUUID() },
  ]) {
    const blocked = harness();
    blocked.mutateRow(matchA, changes);
    const saved = blocked.snapshot();
    await assert.rejects(blocked.send(blocked.command()), httpError(409, 'MATCH_NOT_ASSIGNABLE'));
    assert.deepEqual(blocked.snapshot(), saved);
  }
});

test('assignment is reserved for the tournament admin and cannot be replayed by another owner or a judge', async () => {
  const h = harness();
  const dto = h.command();
  await h.send(dto);
  const before = h.snapshot();
  for (const user of [
    { id: randomUUID(), role: 'ORGANIZER' },
    { id: randomUUID(), role: 'OPERATOR', tatamiId: matA },
  ])
    await assert.rejects(h.send(dto, matchA, user), httpError(403));
  assert.deepEqual(h.snapshot(), before);
  await h.send(h.command(), matchB, { id: randomUUID(), role: 'SUPER_ADMIN' });
  assert.equal(h.snapshot().rows[matchB].tatamiId, matA);
});

test('legacy nested command IDs from other contests cannot be reused for assignment', async () => {
  const oldId = randomUUID();
  const h = harness({
    legacyEvents: [
      {
        id: randomUUID(),
        contestId: 'another-contest',
        type: 'OFFLINE_SYNC',
        payload: { events: [{ id: oldId, type: 'START' }] },
      },
    ],
  });
  const before = h.snapshot();
  await assert.rejects(h.send(h.command({ id: oldId })), httpError(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
});

test('receipt uniqueness collision returns 409 and rolls back category, bout, receipt and audit', async () => {
  const h = harness({ collision: true });
  const before = h.snapshot();
  await assert.rejects(h.send(h.command()), httpError(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});

test('audit storage failure rolls back the entire assignment instead of leaving an unaudited queue change', async () => {
  const h = harness({ failAudit: true });
  const before = h.snapshot();
  await assert.rejects(h.send(h.command()), /audit unavailable/);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});
