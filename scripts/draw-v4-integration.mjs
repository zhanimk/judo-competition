import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { fixtureRequest } from './test-access.mjs';
import { createTestUser } from './test-user.mjs';
import { drawProgress } from '@judo/engine/draw';

// Real API + PostgreSQL only in an explicitly configured disposable rehearsal.
const db = new PrismaClient(),
  base = process.env.TEST_API_URL;
const tournamentIds = [],
  userIds = [];

async function call(path, data, cookie = '') {
  const response = await fixtureRequest(base, path, data, cookie);
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, data, cookie) {
  const response = await call(path, data, cookie);
  assert.ok(response.status < 300, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
async function fixture(format, count, label) {
  const owner = await createTestUser(db);
  userIds.push(owner.id);
  const login = await call('/auth/login', { email: owner.email, password: owner.password });
  assert.equal(login.status, 201);
  const cookie = login.cookie;
  const tournament = await ok(
    '/tournaments',
    {
      name: 'QA · v4 ties · ' + label,
      city: 'QA',
      venue: 'Isolated rehearsal',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    },
    cookie,
  );
  tournamentIds.push(tournament.id);
  const category = await ok(
    `/tournaments/${tournament.id}/categories`,
    {
      name: 'QA ' + format,
      format,
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
    },
    cookie,
  );
  for (let i = 0; i < count; i++)
    await ok(
      `/tournaments/${tournament.id}/categories/${category.id}/entries`,
      {
        firstName: 'Әлихан',
        lastName: 'v4 QA-' + i,
        birthYear: 2012,
        club: 'v4 QA club-' + i,
      },
      cookie,
    );
  const preview = await ok(`/categories/${category.id}/draw/preview`, {}, cookie);
  assert.equal(preview.snapshot.tieRanking, 'WINS_ONLY');
  assert.equal(preview.snapshot.tieMany, 'ADMIN_REVIEW');
  await ok(`/categories/${category.id}/draw/confirm`, { version: preview.version }, cookie);
  await ok(`/tournaments/${tournament.id}/start`, {}, cookie);
  const [mat] = await ok(`/tournaments/${tournament.id}/tatamis`, undefined, cookie);
  return { tournamentId: tournament.id, categoryId: category.id, owner, cookie, matId: mat.id };
}
async function state(c) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({ where: { id: c.tournamentId } }),
    draw: await db.drawRecord.findUniqueOrThrow({ where: { categoryId: c.categoryId } }),
    contests: await db.contest.findMany({
      where: { draw: { categoryId: c.categoryId } },
      orderBy: { id: 'asc' },
    }),
    commands: await db.drawCommand.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    outbox: await db.liveOutbox.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
      select: { id: true, tournamentId: true, tatamiId: true, kind: true, createdAt: true },
    }),
  };
}
async function accelerateRest(c) {
  const old = new Date(Date.now() - 601000);
  await db.contest.updateMany({
    where: { draw: { category: { tournamentId: c.tournamentId } }, status: 'CONFIRMED' },
    data: { endedAt: old, confirmedAt: old },
  });
}
function cycleWinner(a, b, members) {
  assert.equal(members.length % 2, 1);
  const delta = (members.indexOf(b) - members.indexOf(a) + members.length) % members.length;
  return delta <= (members.length - 1) / 2 ? a : b;
}
async function play(c, winnerFor, only) {
  let count = 0;
  for (;;) {
    const dashboard = await ok(
      `/tournaments/${c.tournamentId}/tatamis/${c.matId}`,
      undefined,
      c.cookie,
    );
    const next = dashboard.queue.find((row) => !row.blockedByRound && (!only || only(row)));
    if (!next) break;
    const row = await db.contest.findUniqueOrThrow({ where: { id: next.id } });
    const draw = (await db.drawRecord.findUniqueOrThrow({ where: { id: row.drawId } })).snapshot;
    const winner = await winnerFor(row, draw);
    assert.ok([row.whiteEntryId, row.blueEntryId].includes(winner));
    await accelerateRest(c);
    let result = await ok(
      `/tatamis/${c.matId}/live/${row.id}/command`,
      { id: randomUUID(), type: 'START', expectedVersion: row.revision },
      c.cookie,
    );
    result = await ok(
      `/tatamis/${c.matId}/live/${row.id}/command`,
      {
        id: randomUUID(),
        type: 'AWARD',
        expectedVersion: result.revision,
        side: winner === row.whiteEntryId ? 'WHITE' : 'BLUE',
        kind: 'IPPON',
      },
      c.cookie,
    );
    const dto = { id: randomUUID(), type: 'CONFIRM', expectedVersion: result.revision };
    const response = await ok(`/tatamis/${c.matId}/live/${row.id}/command`, dto, c.cookie);
    assert.deepEqual(
      await ok(`/tatamis/${c.matId}/live/${row.id}/command`, dto, c.cookie),
      response,
    );
    count++;
    assert.ok(count < 80, 'fixture cannot append an unbounded loop');
  }
  return count;
}
async function impact(c) {
  return ok(`/categories/${c.categoryId}/draw/tiebreak-impact`, undefined, c.cookie);
}
const command = (preview, review = preview.reviews[0]) => ({
  id: randomUUID(),
  expectedVersion: preview.expectedVersion,
  impactToken: review.impactToken,
  reason: 'Administrator explicitly approved QA additional round',
  procedure: review.procedure,
  parent: review.parent,
  ...(review.pool ? { pool: review.pool } : {}),
  members: [...review.members],
});

async function twoPairs() {
  const c = await fixture('ROUND_ROBIN', 4, 'two deciding pairs');
  const initial = await state(c),
    [a, b, d, e] = initial.draw.snapshot.positions.map((entry) => entry.id);
  const results = new Map([
    [[a, b].sort().join('|'), a],
    [[a, d].sort().join('|'), a],
    [[a, e].sort().join('|'), e],
    [[b, d].sort().join('|'), b],
    [[b, e].sort().join('|'), b],
    [[d, e].sort().join('|'), d],
  ]);
  assert.equal(
    await play(
      c,
      (row, draw) => {
        const match = draw.matches.find((match) => match.id === row.key);
        if (!match.tieBreakRound)
          return results.get([row.whiteEntryId, row.blueEntryId].sort().join('|'));
        return [row.whiteEntryId, row.blueEntryId].includes(b) ? b : e;
      },
      (row) => row.round <= 3,
    ),
    6,
  );
  const pending = await state(c);
  assert.equal(pending.tournament.status, 'RUNNING');
  assert.equal(pending.draw.version, initial.draw.version + 1);
  assert.equal(pending.draw.snapshot.tieRounds.length, 2);
  assert.deepEqual(
    pending.contests.filter((row) => row.key.startsWith('tb-')).map((row) => row.round),
    [4, 4],
  );
  assert.equal(
    (await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie)).places,
    null,
  );
  assert.equal(
    await play(c, (row) => ([row.whiteEntryId, row.blueEntryId].includes(b) ? b : e)),
    2,
  );
  const final = await state(c),
    progress = await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie);
  assert.equal(final.tournament.status, 'FINISHED');
  assert.equal(progress.complete, true);
  assert.deepEqual(
    progress.places.map((place) => place.entryId),
    [b, a, e, d],
  );
  assert.deepEqual(
    final.contests
      .filter((row) => initial.contests.some((old) => old.id === row.id))
      .map((row) => row.winnerEntryId)
      .sort(),
    [...results.values()].sort(),
  );
  console.log(
    'PASS v4 RR4: two new deciding bouts despite old personal outcomes, real circle four, rest checks and exact confirmation retries',
  );
}

async function manualNested() {
  const c = await fixture('ROUND_ROBIN', 3, 'manual nested review');
  const members = (await state(c)).draw.snapshot.positions.map((entry) => entry.id);
  assert.equal(await play(c, (row) => cycleWinner(row.whiteEntryId, row.blueEntryId, members)), 3);
  const waiting = await state(c),
    progress = await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie);
  assert.equal(waiting.tournament.status, 'RUNNING');
  assert.equal(waiting.contests.length, 3);
  assert.equal(progress.phase, 'ADMIN_REVIEW');
  assert.equal(progress.roundBarrier, 4);
  assert.equal(progress.places, null);
  const preview = await impact(c),
    dto = command(preview);
  const namespace = await db.accessCommand.findFirstOrThrow({
    where: { tournamentId: c.tournamentId },
  });
  const collisionBefore = await state(c);
  const collision = await call(
    `/categories/${c.categoryId}/draw/tiebreak`,
    { ...dto, id: namespace.id },
    c.cookie,
  );
  assert.equal(collision.status, 409);
  assert.equal(collision.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await state(c), collisionBefore);
  const stale = await call(
    `/categories/${c.categoryId}/draw/tiebreak`,
    { ...dto, id: randomUUID(), impactToken: '0'.repeat(64) },
    c.cookie,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.message, 'IMPACT_CHANGED');
  assert.deepEqual(await state(c), collisionBefore);
  const [first, retry] = await Promise.all([
    call(`/categories/${c.categoryId}/draw/tiebreak`, dto, c.cookie),
    call(`/categories/${c.categoryId}/draw/tiebreak`, dto, c.cookie),
  ]);
  assert.equal(first.status, 201);
  assert.deepEqual(retry, first);
  const approved = await state(c);
  assert.equal(
    approved.commands.filter((command) => command.type === 'APPROVE_TIE_ROUND').length,
    1,
  );
  assert.deepEqual(
    approved.commands.filter((command) => command.type !== 'APPROVE_TIE_ROUND'),
    waiting.commands,
    'approval preserves the original preview/confirmation receipts',
  );
  assert.equal(first.body.version, waiting.draw.version + 1);
  assert.deepEqual(
    approved.contests
      .filter((row) => row.key.startsWith('tb-'))
      .map((row) => row.round)
      .sort(),
    [4, 5, 6],
  );
  const altered = await call(
    `/categories/${c.categoryId}/draw/tiebreak`,
    { ...dto, reason: 'Different review intent' },
    c.cookie,
  );
  assert.equal(altered.status, 409);
  assert.equal(altered.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await state(c), approved);
  assert.equal(await play(c, (row) => cycleWinner(row.whiteEntryId, row.blueEntryId, members)), 3);
  const nested = await impact(c),
    nestedProgress = await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie);
  assert.equal(nestedProgress.phase, 'ADMIN_REVIEW');
  assert.equal(nestedProgress.roundBarrier, 7);
  assert.equal(nested.reviews[0].parent, 'tb-1');
  assert.deepEqual(
    await ok(`/categories/${c.categoryId}/draw/tiebreak`, dto, c.cookie),
    first.body,
  );
  const staleBefore = await state(c);
  const oldVersion = await call(
    `/categories/${c.categoryId}/draw/tiebreak`,
    { ...dto, id: randomUUID() },
    c.cookie,
  );
  assert.equal(oldVersion.status, 409);
  assert.equal(oldVersion.body.message, 'DRAW_STALE');
  assert.deepEqual(await state(c), staleBefore);
  await ok(`/categories/${c.categoryId}/draw/tiebreak`, command(nested), c.cookie);
  assert.equal(await play(c, (row) => [row.whiteEntryId, row.blueEntryId].sort()[0]), 3);
  const final = await state(c);
  assert.equal(final.tournament.status, 'FINISHED');
  assert.equal(final.commands.filter((command) => command.type === 'APPROVE_TIE_ROUND').length, 2);
  assert.deepEqual(
    final.commands.filter((command) => command.type !== 'APPROVE_TIE_ROUND'),
    waiting.commands,
  );
  assert.equal(
    (await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie)).complete,
    true,
  );
  const winners = Object.fromEntries(final.contests.map((row) => [row.key, row.winnerEntryId]));
  assert.equal(drawProgress(final.draw.snapshot, winners).complete, true);
  console.log(
    'PASS v4 RR3: no premature finish/champion, manual reviewed circles, concurrent immutable receipt, global UUID collisions and nested re-review',
  );
}

async function mixedBarrier() {
  const c = await fixture('MIXED', 12, 'all-group stage barrier');
  const initial = await state(c),
    pools = initial.draw.snapshot.pools;
  assert.equal(
    await play(c, (row, draw) => {
      const match = draw.matches.find((match) => match.id === row.key);
      assert.ok(match.pool, 'knockout cannot start during unresolved group stage');
      const members = pools.find((pool) => pool.id === match.pool).entries;
      return match.pool === pools[0].id
        ? cycleWinner(row.whiteEntryId, row.blueEntryId, members)
        : [row.whiteEntryId, row.blueEntryId].sort()[0];
    }),
    12,
  );
  const baseFinished = await state(c),
    ko = baseFinished.contests.filter(
      (row) => !baseFinished.draw.snapshot.matches.find((match) => match.id === row.key).pool,
    );
  assert.ok(ko.every((row) => row.status === 'WAITING' && !row.whiteEntryId && !row.blueEntryId));
  const preview = await impact(c);
  assert.equal(preview.reviews.length, 1);
  const expected = preview.reviews[0].changedRounds;
  assert.equal(expected.length, ko.length);
  const response = await ok(
      `/categories/${c.categoryId}/draw/tiebreak`,
      command(preview),
      c.cookie,
    ),
    approved = await state(c);
  assert.equal(response.progress.poolStageComplete, false);
  for (const change of expected) {
    const row = approved.contests.find((row) => row.id === change.id),
      previous = ko.find((row) => row.id === change.id);
    assert.equal(row.round, change.afterRound);
    assert.equal(row.round - previous.round, 3);
    assert.equal(row.revision, previous.revision + 1);
    assert.equal(row.status, 'WAITING');
  }
  assert.equal(
    await play(c, async (row, draw) => {
      const match = draw.matches.find((match) => match.id === row.key);
      if (!match.pool) {
        const results = await db.contest.findMany({
          where: { drawId: row.drawId, status: 'CONFIRMED' },
        });
        const winners = Object.fromEntries(
          results.map((confirmed) => [confirmed.key, confirmed.winnerEntryId]),
        );
        assert.equal(
          drawProgress(draw, winners).poolStageComplete,
          true,
          'no knockout START is attempted until every pool/tie stage resolves',
        );
      }
      return [row.whiteEntryId, row.blueEntryId].sort()[0];
    }),
    14,
  ); // three approved pool bouts plus eleven knockout/medal bouts.
  const final = await state(c);
  assert.equal(final.tournament.status, 'FINISHED');
  assert.equal(final.contests.length, 26);
  assert.ok(final.contests.every((row) => row.status === 'CONFIRMED'));
  assert.equal(
    (await ok(`/categories/${c.categoryId}/draw/progress`, undefined, c.cookie)).complete,
    true,
  );
  console.log(
    'PASS v4 MIXED12: every playoff waits for all pools, approved circles shift stable KO/medal rows with versions, all 26 actual bouts confirmed',
  );
}

try {
  assert.ok(base, 'TEST_API_URL for a disposable rehearsal API is required');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(schema ?? '', /^qa_[a-z0-9_]+$/, 'only disposable qa_ schemas are allowed');
  const [{ actual }] = await db.$queryRaw`SELECT current_schema()::text AS actual`;
  assert.equal(actual, schema);
  await twoPairs();
  await manualNested();
  await mixedBarrier();
  console.log(
    'PASS: v4 winner-only draw policy through authenticated HTTP + real PostgreSQL, tie commands, snapshot propagation and completion barriers',
  );
} finally {
  for (const tournamentId of tournamentIds) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId } } });
    await db.entry.deleteMany({ where: { category: { tournamentId } } });
    await db.category.deleteMany({ where: { tournamentId } });
    await db.club.deleteMany({ where: { tournamentId } });
    await db.auditEvent.deleteMany({ where: { tournamentId } });
    await db.tatami.deleteMany({ where: { tournamentId } });
    await db.tournament.delete({ where: { id: tournamentId } });
  }
  if (userIds.length) {
    await db.athlete.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}
