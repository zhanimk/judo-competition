import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { drawProgress, resolveMatches } from '@judo/engine/draw';
import { applyCommand, createMatch } from '@judo/engine/match';
import {
  categoryResults,
  teamStandings,
} from '../apps/api/dist/modules/protocols/protocol-model.js';
import { drawPlaces } from '../apps/api/dist/modules/protocols/pdf-draw-places.js';
import { fixtureControl, fixtureRequest } from './test-access.mjs';
import { createTestUser } from './test-user.mjs';

// This is a scale test of actual HTTP admission/queue/final propagation.
// Exactly 8,127 earlier results are synthetic isolated history, not HTTP bouts.
const db = new PrismaClient(),
  base = process.env.TEST_API_URL;
let owner, tournament;
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

async function seedSyntheticConfirmedHistory(categoryId, record, rows, lastId, ranking, rules) {
  assert.equal(rows.length, 8128);
  const old = new Date(Date.now() - 700000),
    updates = rows
      .filter((row) => row.id !== lastId)
      .map((row) => {
        assert.equal(row.status, 'READY');
        assert.equal(row.state, null);
        assert.equal(row.offlineSessionId, null);
        assert.equal(row.offlineActorId, null);
        assert.equal(row.offlineControlGeneration, null);
        const winner =
          ranking.get(row.whiteEntryId) < ranking.get(row.blueEntryId)
            ? row.whiteEntryId
            : row.blueEntryId;
        let state = createMatch(rules);
        for (const command of [
          { type: 'START' },
          { type: 'AWARD', kind: 'IPPON', side: winner === row.whiteEntryId ? 'WHITE' : 'BLUE' },
          { type: 'CONFIRM' },
        ])
          state = applyCommand(state, {
            ...command,
            id: randomUUID(),
            expectedVersion: state.version,
          });
        state.receipts = {};
        return { id: row.id, winner, state };
      });
  assert.equal(updates.length, 8127);
  await db.$transaction(
    async (tx) => {
      const category = await tx.category.findUniqueOrThrow({ where: { id: categoryId } });
      assert.equal(category.tournamentId, tournament.id);
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournament.id} FOR UPDATE`;
      const changed = await tx.$executeRaw`UPDATE "Contest" AS c SET
      status='CONFIRMED', "winnerEntryId"=fixture.winner, state=fixture.state,
      "resultReason"='IPPON', "confirmedAt"=${old}, "endedAt"=${old}, revision=revision+1
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        AS fixture(id text, winner text, state jsonb)
      WHERE c.id::text=fixture.id AND c."drawId"=${record.id}
        AND c.status='READY' AND c.state IS NULL AND c."offlineSessionId" IS NULL
        AND c."offlineActorId" IS NULL AND c."offlineControlGeneration" IS NULL`;
      assert.equal(changed, 8127, 'the fixture may only seed its own fresh ready rows');
      // Use Prisma's timestamp codec for the synthetic dates. Confirmation is
      // deliberately recent: only the already elapsed sporting finish permits
      // admission, rather than a backdated administrative confirmation.
      const stamped = await tx.contest.updateMany({
        where: { drawId: record.id, id: { not: lastId }, status: 'CONFIRMED' },
        data: { endedAt: old, confirmedAt: new Date() },
      });
      assert.equal(stamped.count, 8127);
      const newest = await tx.contest.aggregate({
        where: { drawId: record.id, status: 'CONFIRMED' },
        _max: { endedAt: true },
      });
      assert.equal(newest._max.endedAt.getTime(), old.getTime());
      await tx.auditEvent.create({
        data: {
          tournamentId: tournament.id,
          actorId: owner.id,
          entityId: record.id,
          action: 'QA_SYNTHETIC_HISTORY',
          payload: { count: 8127, retainedActualContestId: lastId },
        },
      });
    },
    { timeout: 20000 },
  );
}

try {
  assert.ok(base, 'explicit TEST_API_URL is required');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(schema ?? '', /^qa_[a-z0-9_]+$/, 'only disposable qa_ schemas are allowed');
  const [{ actual }] = await db.$queryRaw`SELECT current_schema()::text AS actual`;
  assert.equal(actual, schema);
  owner = await createTestUser(db);
  const login = await call('/auth/login', { email: owner.email, password: owner.password });
  assert.equal(login.status, 201);
  const cookie = login.cookie;
  tournament = await ok(
    '/tournaments',
    {
      name: 'QA · RR128 · 8127 synthetic histories + one actual final bout',
      city: 'QA',
      venue: 'Isolated scale rehearsal',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    },
    cookie,
  );
  const category = await ok(
    `/tournaments/${tournament.id}/categories`,
    {
      name: 'QA RR128 U15 -30',
      format: 'ROUND_ROBIN',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
    },
    cookie,
  );
  for (let i = 0; i < 128; i++)
    await ok(
      `/tournaments/${tournament.id}/categories/${category.id}/entries`,
      {
        firstName: 'Әлихан',
        lastName: 'Scale-' + String(i + 1).padStart(3, '0'),
        birthYear: 2012,
        club: 'QA Scale Club ' + String((i % 4) + 1),
      },
      cookie,
    );
  const preview = await ok(`/categories/${category.id}/draw/preview`, {}, cookie);
  assert.equal(preview.snapshot.tieRanking, 'WINS_ONLY');
  assert.equal(preview.snapshot.matches.length, 8128);
  const confirmed = await ok(
    `/categories/${category.id}/draw/confirm`,
    { version: preview.version },
    cookie,
  );
  assert.equal(confirmed.contests.length, 8128);
  const [mat] = await ok(`/tournaments/${tournament.id}/tatamis`, undefined, cookie);
  const first = confirmed.contests.find((row) => row.round === 1);
  await ok(
    `/contests/${first.id}/assign`,
    {
      id: randomUUID(),
      expectedRevision: first.revision,
      tatamiId: mat.id,
    },
    cookie,
  );
  await ok(`/tournaments/${tournament.id}/start`, {}, cookie);
  const grant = await fixtureControl(base, mat.id, cookie);
  const startedAt = Date.now(),
    dashboard = await ok(`/tournaments/${tournament.id}/tatamis/${mat.id}`, undefined, cookie),
    queueMilliseconds = Date.now() - startedAt;
  assert.equal(dashboard.currentMatch, null);
  assert.equal(dashboard.queue.length, 8128);
  assert.equal(dashboard.queue.filter((row) => !row.blockedByRound).length, 64);
  assert.ok(dashboard.queue.slice(0, 64).every((row) => row.round === 1 && !row.blockedByRound));
  assert.ok(dashboard.queue.slice(64).every((row) => row.round > 1 && row.blockedByRound));
  const later = dashboard.queue.find((row) => row.round === 2),
    beforeLater = await db.contest.findUniqueOrThrow({ where: { id: later.id } }),
    blocked = await call(
      `/tatamis/${mat.id}/live/${later.id}/command`,
      {
        id: randomUUID(),
        type: 'START',
        expectedVersion: later.revision,
        ...grant,
      },
      cookie,
    );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.message, 'PREVIOUS_ROUND_PENDING');
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: later.id } }), beforeLater);

  const record = await db.drawRecord.findUniqueOrThrow({ where: { categoryId: category.id } }),
    rows = await db.contest.findMany({ where: { drawId: record.id } }),
    last = rows.find((row) => row.key === record.snapshot.matches.at(-1).id),
    ordered = record.snapshot.positions.map((entry) => entry.id),
    ranking = new Map(ordered.map((id, index) => [id, index])),
    storedTournament = await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } });
  const rules = storedTournament.rulesSnapshot;
  await seedSyntheticConfirmedHistory(category.id, record, rows, last.id, ranking, {
    durationMs: 180000,
    shidoLimit: rules.shidoLimit,
    wazaForIppon: rules.wazaForIppon,
    enabledScores: rules.enabledScores,
    holdThresholds: rules.holdThresholds,
  });
  const pending = await ok(`/categories/${category.id}/draw/progress`, undefined, cookie);
  assert.equal(pending.complete, false);
  assert.equal(pending.places, null);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } })).status,
    'RUNNING',
  );
  const tail = await ok(`/tournaments/${tournament.id}/tatamis/${mat.id}`, undefined, cookie);
  assert.deepEqual(
    tail.queue.map((row) => [row.id, row.round, row.blockedByRound]),
    [[last.id, 127, false]],
  );
  let result = await ok(
    `/tatamis/${mat.id}/live/${last.id}/command`,
    {
      id: randomUUID(),
      type: 'START',
      expectedVersion: last.revision,
      ...grant,
    },
    cookie,
  );
  const winner =
    ranking.get(last.whiteEntryId) < ranking.get(last.blueEntryId)
      ? last.whiteEntryId
      : last.blueEntryId;
  result = await ok(
    `/tatamis/${mat.id}/live/${last.id}/command`,
    {
      id: randomUUID(),
      type: 'AWARD',
      expectedVersion: result.revision,
      kind: 'IPPON',
      side: winner === last.whiteEntryId ? 'WHITE' : 'BLUE',
      ...grant,
    },
    cookie,
  );
  const confirmDto = {
    id: randomUUID(),
    type: 'CONFIRM',
    expectedVersion: result.revision,
    ...grant,
  };
  result = await ok(`/tatamis/${mat.id}/live/${last.id}/command`, confirmDto, cookie);
  assert.deepEqual(
    await ok(`/tatamis/${mat.id}/live/${last.id}/command`, confirmDto, cookie),
    result,
  );
  const source = await db.category.findUniqueOrThrow({
    where: { id: category.id },
    include: { entries: true, draw: { include: { contests: true } } },
  });
  assert.ok(source.draw.contests.every((row) => row.status === 'CONFIRMED'));
  assert.equal(source.draw.contests.length, 8128);
  const winners = Object.fromEntries(
      source.draw.contests.map((row) => [row.key, row.winnerEntryId]),
    ),
    progress = await ok(`/categories/${category.id}/draw/progress`, undefined, cookie);
  assert.deepEqual(
    progress.places.map((row) => row.entryId),
    ordered,
  );
  assert.equal(progress.complete, true);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } })).status,
    'FINISHED',
  );
  assert.equal(drawProgress(source.draw.snapshot, winners).complete, true);
  assert.equal(resolveMatches(source.draw.snapshot, winners).length, 8128);
  assert.deepEqual(categoryResults(source).places, progress.places);
  assert.deepEqual(
    drawPlaces(source).rows.map((row) => row.entry.id),
    ordered.slice(0, 3),
  );
  const teams = teamStandings([source]);
  assert.equal(teams.complete, 1);
  assert.equal(
    teams.teams.reduce((sum, team) => sum + team.gold, 0),
    1,
  );
  assert.equal(
    teams.teams.reduce((sum, team) => sum + team.silver, 0),
    1,
  );
  assert.equal(
    teams.teams.reduce((sum, team) => sum + team.bronze, 0),
    1,
  );
  const pdf = await fetch(`${base}/tournaments/${tournament.id}/protocol.pdf?kind=TEAMS&lang=ru`, {
    headers: { Cookie: cookie },
  });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  await mkdir('tmp/engine-audit-2026-10-10', { recursive: true });
  await writeFile(
    'tmp/engine-audit-2026-10-10/rr128-pg-report.json',
    JSON.stringify(
      {
        admittedViaHttp: 128,
        readyPairs: 8128,
        firstCirclePairs: 64,
        syntheticConfirmedHistory: 8127,
        actualFinalHttpBouts: 1,
        httpQueueMilliseconds: queueMilliseconds,
        finalPlaces: 128,
        checks: [
          'round-order atomic rollback',
          'final confirmed propagation',
          'tournament completion',
          'PDF source medal consistency',
          'actual TEAMS PDF download',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS RR128: actual HTTP128 admission/preview/confirm/assign/start/8128 queue (${queueMilliseconds}ms), 8127 synthetic confirmed histories + one actual final HTTP bout, completion/128 places/PDF source consistency`,
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament.id } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.category.deleteMany({ where: { tournamentId: tournament.id } });
    await db.club.deleteMany({ where: { tournamentId: tournament.id } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament.id } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament.id } });
    await db.tournament.delete({ where: { id: tournament.id } });
  }
  if (owner) {
    await db.athlete.deleteMany({ where: { ownerId: owner.id } });
    await db.user.delete({ where: { id: owner.id } });
  }
  await db.$disconnect();
}
