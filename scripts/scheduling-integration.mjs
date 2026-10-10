import { fixtureRequest } from './test-access.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser, useLegacyRules } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let owner,
  tournament,
  cookie = '';
async function call(path, data, auth = cookie) {
  const r = await fixtureRequest(base, path, data, auth);
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function post(path, data = {}) {
  const r = await call(path, data);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
try {
  owner = await createTestUser(db);
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password })).cookie;
  tournament = (
    await post('/tournaments', {
      name: 'SCHEDULE QA',
      city: 'Алматы',
      venue: 'QA',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 2,
    })
  ).id;
  await useLegacyRules(db, tournament);
  assert.equal((await call(`/tournaments/${tournament}/schedule`, {}, '')).status, 401);
  assert.equal(
    (await call(`/tournaments/${tournament}/schedule`, {})).body.message,
    'NO_ACTIVE_CATEGORIES',
  );
  const empty = await post(`/tournaments/${tournament}/categories`, {
    name: 'Empty saved configuration',
    gender: 'MALE',
    birthYearFrom: 2016,
    birthYearTo: 2017,
    maxWeightGrams: 20000,
    durationSeconds: 120,
  });
  const lone = await post(`/tournaments/${tournament}/categories`, {
    name: 'One active athlete',
    gender: 'MALE',
    birthYearFrom: 2016,
    birthYearTo: 2017,
    maxWeightGrams: 30000,
    durationSeconds: 120,
  });
  const loneEntry = await post(`/tournaments/${tournament}/categories/${lone.id}/entries`, {
    firstName: 'QA',
    lastName: 'Single',
    club: 'Fixture club',
    birthYear: 2016,
  });
  const beforeRejectedStart = await db.tournament.findUniqueOrThrow({ where: { id: tournament } });
  for (const action of ['start', 'schedule']) {
    const rejected = await call(`/tournaments/${tournament}/${action}`, {});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.message, 'CATEGORY_NEEDS_OPPONENT');
    assert.deepEqual(rejected.body.categories, [{ id: lone.id, name: lone.name }]);
    assert.deepEqual(
      await db.tournament.findUniqueOrThrow({ where: { id: tournament } }),
      beforeRejectedStart,
    );
    assert.equal(
      await db.auditEvent.count({
        where: { tournamentId: tournament, action: 'CATEGORIES_SCHEDULED' },
      }),
      0,
    );
  }
  await post(`/tournaments/${tournament}/roster/entries/${loneEntry.id}/archive`, {
    id: randomUUID(),
    expectedRevision: beforeRejectedStart.rosterRevision,
    reason: 'Archive isolated single admission for scheduling QA',
  });
  const archivedCategory = await post(`/tournaments/${tournament}/categories`, {
    name: 'Archived roster with stale preview',
    gender: 'MALE',
    birthYearFrom: 2016,
    birthYearTo: 2017,
    maxWeightGrams: 40000,
    durationSeconds: 120,
  });
  const archivedEntries = [];
  for (let index = 0; index < 2; index++)
    archivedEntries.push(
      await post(`/tournaments/${tournament}/categories/${archivedCategory.id}/entries`, {
        firstName: 'QA',
        lastName: `Archive ${index}`,
        club: 'Fixture club',
        birthYear: 2016,
      }),
    );
  await post(`/categories/${archivedCategory.id}/draw/preview`);
  for (const entry of archivedEntries) {
    const current = await db.tournament.findUniqueOrThrow({ where: { id: tournament } });
    await post(`/tournaments/${tournament}/roster/entries/${entry.id}/archive`, {
      id: randomUUID(),
      expectedRevision: current.rosterRevision,
      reason: 'Retain archived preview history while excluding empty category',
    });
  }
  const archivedDraw = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: archivedCategory.id },
  });
  assert.equal(archivedDraw.status, 'STALE');
  for (const [name, count, year, weight] of [
    ['older', 8, 2012, 20000],
    ['young', 8, 2016, 30000],
    ['heavy', 4, 2016, 40000],
    ['light', 4, 2016, 20000],
  ]) {
    const c = await post(`/tournaments/${tournament}/categories`, {
      name,
      format: 'SINGLE_ELIMINATION',
      gender: 'MALE',
      birthYearFrom: year,
      birthYearTo: year + 1,
      maxWeightGrams: weight,
      durationSeconds: 120,
    });
    for (let i = 0; i < count; i++)
      await post(`/tournaments/${tournament}/categories/${c.id}/entries`, {
        firstName: 'QA',
        lastName: String(i),
        club: 'Club' + i,
        birthYear: year,
      });
    const d = await post(`/categories/${c.id}/draw/preview`);
    await post(`/categories/${c.id}/draw/confirm`, { version: d.version });
  }
  const plan = await post(`/tournaments/${tournament}/schedule`);
  assert.deepEqual(
    plan.loads.map((m) => m.matches),
    [10, 10],
  );
  for (const excluded of [empty, lone, archivedCategory]) {
    assert.ok(!plan.assignments.some((assignment) => assignment.categoryId === excluded.id));
    assert.equal(
      (await db.category.findUniqueOrThrow({ where: { id: excluded.id } })).homeTatamiId,
      null,
    );
  }
  const saved = await db.contest.findMany({
    where: { draw: { category: { tournamentId: tournament } } },
    orderBy: { id: 'asc' },
  });
  await post(`/tournaments/${tournament}/schedule`);
  await post(`/tournaments/${tournament}/start`);
  const started = await db.tournament.findUniqueOrThrow({ where: { id: tournament } });
  assert.equal(Object.keys(started.rulesSnapshot.categories).length, 4);
  assert.deepEqual(
    await db.drawRecord.findUniqueOrThrow({ where: { categoryId: archivedCategory.id } }),
    archivedDraw,
  );
  assert.equal(
    await db.entry.count({
      where: {
        id: { in: [loneEntry.id, ...archivedEntries.map((entry) => entry.id)] },
        archivedAt: { not: null },
      },
    }),
    3,
  );
  const protocol = (query) =>
    fixtureRequest(base, `/tournaments/${tournament}/protocol.pdf?${query}`, undefined, cookie);
  const allDraws = await protocol('kind=DRAW');
  assert.equal(
    allDraws.status,
    200,
    'An empty stale preview must not block populated category PDFs',
  );
  assert.equal(
    Buffer.from(await allDraws.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  const emptyDraw = await protocol(`kind=DRAW&categoryId=${archivedCategory.id}`);
  assert.equal(emptyDraw.status, 409);
  assert.equal((await emptyDraw.json()).message, 'NO_ACTIVE_CATEGORIES');
  const emptyParticipants = await protocol(`kind=PARTICIPANTS&categoryId=${archivedCategory.id}`);
  assert.equal(
    emptyParticipants.status,
    200,
    'An explicit empty participant list remains downloadable',
  );
  assert.equal(
    Buffer.from(await emptyParticipants.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  assert.equal(
    (await protocol(`kind=DRAW&categoryIds=${archivedCategory.id},${randomUUID()}`)).status,
    404,
  );
  const again = await db.contest.findMany({
    where: { draw: { category: { tournamentId: tournament } } },
    orderBy: { id: 'asc' },
  });
  assert.deepEqual(
    again.map((c) => [c.id, c.tatamiId, c.queueOrder, c.revision]),
    saved.map((c) => [c.id, c.tatamiId, c.queueOrder, c.revision]),
  );
  assert.equal(
    await db.auditEvent.count({
      where: { tournamentId: tournament, action: 'CATEGORIES_SCHEDULED' },
    }),
    1,
  );
  const mats = (await call(`/tournaments/${tournament}/tatamis`)).body;
  // Finish first-round pairs of the first mat; early second rounds must be blocked.
  const mat = mats[0].id;
  const categories = await db.category.findMany({
    where: { homeTatamiId: mat },
    orderBy: [{ birthYearFrom: 'desc' }, { maxWeightGrams: 'asc' }],
  });
  let queue = (await call(`/tournaments/${tournament}/tatamis/${mat}`)).body.queue;
  assert.equal(queue[0].category, categories[0].name);
  const initialQueue = queue.map((c) => c.id);
  let sawEarlySecond = false;
  for (const id of initialQueue) {
    const row = await db.contest.findUniqueOrThrow({ where: { id } });
    const cmd = async (type, extra = {}) => {
      const current = await db.contest.findUniqueOrThrow({ where: { id } });
      return post(`/tatamis/${mat}/live/${id}/command`, {
        id: randomUUID(),
        expectedVersion: current.revision,
        type,
        ...extra,
      });
    };
    await cmd('START');
    await cmd('AWARD', { side: 'WHITE', kind: 'IPPON' });
    await cmd('CONFIRM');
    const pending = await db.contest.findFirst({
      where: { tatamiId: mat, status: 'READY', round: 1 },
    });
    const second = await db.contest.findFirst({
      where: { tatamiId: mat, status: 'READY', round: 2 },
    });
    if (pending && second) {
      const attempt = await call(`/tatamis/${mat}/live/${second.id}/command`, {
        id: randomUUID(),
        expectedVersion: second.revision,
        type: 'START',
      });
      assert.equal(attempt.body.message, 'PREVIOUS_ROUND_PENDING');
      sawEarlySecond = true;
    }
    assert.equal(
      (await db.category.findUniqueOrThrow({ where: { id: categories[0].id } })).homeTatamiId,
      mat,
    );
  }
  assert.ok(sawEarlySecond);
  queue = (await call(`/tournaments/${tournament}/tatamis/${mat}`)).body.queue;
  assert.equal(queue[0].round, 2);
  assert.equal(queue[0].blockedByRound, false);
  const first = queue[0];
  assert.equal(
    (
      await call(`/tatamis/${mat}/live/${first.id}/command`, {
        id: randomUUID(),
        expectedVersion: first.revision,
        type: 'START',
      })
    ).body.message,
    'REST_REQUIRED',
  );
  await db.contest.updateMany({
    where: { draw: { category: { tournamentId: tournament } }, status: 'CONFIRMED' },
    data: { confirmedAt: new Date(Date.now() - 601000) },
  });
  assert.equal(
    (
      await call(`/tatamis/${mat}/live/${first.id}/command`, {
        id: randomUUID(),
        expectedVersion: first.revision,
        type: 'START',
      })
    ).status,
    201,
  );
  console.log(
    'PASS: equal 10/10 loads, fixed categories, younger/lighter queue, idempotent scheduling/start, round barrier and rest protection.',
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.category.deleteMany({ where: { tournamentId: tournament } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament } });
    await db.tournament.delete({ where: { id: tournament } });
  }
  if (owner) await db.user.delete({ where: { id: owner.id } });
  await db.$disconnect();
}
