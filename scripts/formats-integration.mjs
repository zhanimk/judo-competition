import { placements, resolveMatches } from '@judo/engine/draw';
import { categoryResults } from '../apps/api/dist/modules/protocols/protocol-model.js';
import { drawPlaces } from '../apps/api/dist/modules/protocols/pdf-draw-places.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTestUser } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let owner,
  tournament,
  cookie = '';
async function call(path, data, auth = cookie) {
  const r = await fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
    body: data ? JSON.stringify(data) : undefined,
  });
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
      name: 'FORMATS QA Әлихан',
      city: 'Алматы',
      venue: 'Test arena',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 3,
    })
  ).id;
  assert.equal(
    (await call(`/tournaments/${tournament}/start`, {})).body.message,
    'ALL_DRAWS_REQUIRED',
  );
  assert.equal((await call(`/tournaments/${tournament}/start`, {}, '')).status, 401);
  for (const [format, count] of [
    ['REPECHAGE', 8],
    ['MIXED', 12],
    ['ROUND_ROBIN', 2],
    ['ROUND_ROBIN', 5],
    ['REPECHAGE', 7],
  ]) {
    const c = await post(`/tournaments/${tournament}/categories`, {
      name: format + count,
      format,
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 50000,
      durationSeconds: 180,
    });
    for (let i = 0; i < count; i++)
      await post(`/tournaments/${tournament}/categories/${c.id}/entries`, {
        firstName: 'Әлихан',
        lastName: 'QA' + i,
        club: 'Клуб' + (i % 3),
        birthYear: 2012,
      });
    const preview = await post(`/categories/${c.id}/draw/preview`);
    if (count < 8) assert.equal(preview.snapshot.algorithm, 'custom-round-robin-v1');
    else assert.equal(preview.snapshot.matches.filter((m) => m.stage === 'BRONZE').length, 2);
    assert.equal((await call(`/tournaments/${tournament}/start`, {})).status, 409);
    await post(`/categories/${c.id}/draw/confirm`, { version: preview.version });
    await post(`/categories/${c.id}/draw/publication`, { published: true, expectedRevision: 0 });
  }
  await post(`/tournaments/${tournament}/publish`);
  await post(`/tournaments/${tournament}/start`);
  await post(`/tournaments/${tournament}/start`);
  assert.equal(
    await db.auditEvent.count({
      where: { tournamentId: tournament, action: 'TOURNAMENT_STARTED' },
    }),
    1,
  );
  assert.equal(
    await db.contest.count({
      where: { draw: { category: { tournamentId: tournament } }, status: 'READY', tatamiId: null },
    }),
    0,
  );
  const frozen = (await db.tournament.findUniqueOrThrow({ where: { id: tournament } }))
    .rulesSnapshot;
  assert.equal(frozen.version, 'custom-2026-v3');
  assert.equal(frozen.drawPolicy, 'REPECHAGE_ONLY');
  for (const c of await db.category.findMany({
    where: { tournamentId: tournament },
    include: { _count: { select: { entries: true } } },
  })) {
    assert.equal(
      frozen.categories[c.id].resolvedFormat,
      c._count.entries < 8 ? 'ROUND_ROBIN' : c.format,
    );
  }
  const mats = (await call(`/tournaments/${tournament}/tatamis`)).body;
  let completed = 0;
  while (true) {
    const rows = await db.contest.findMany({
      where: { draw: { category: { tournamentId: tournament } }, status: 'READY' },
      orderBy: { queueOrder: 'asc' },
    });
    if (!rows.length) break;
    const queues = await Promise.all(
      mats.map(
        async (mat) => (await call(`/tournaments/${tournament}/tatamis/${mat.id}`)).body.queue,
      ),
    );
    const next = queues.map((q) => q[0]).find((c) => c && !c.blockedByRound);
    assert.ok(next, 'ready matches must have an eligible earliest round');
    const row = rows.find((c) => c.id === next.id);
    assert.ok(row);
    assert.ok(row.tatamiId);
    // Only disposable QA records get accelerated rest; clocks and real tournaments are untouched.
    await db.contest.updateMany({
      where: { draw: { category: { tournamentId: tournament } }, status: 'CONFIRMED' },
      data: { confirmedAt: new Date(Date.now() - 601000) },
    });
    let result = await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, {
      id: randomUUID(),
      type: 'START',
      expectedVersion: row.revision,
    });
    result = await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, {
      id: randomUUID(),
      type: 'AWARD',
      expectedVersion: result.revision,
      side: row.whiteEntryId < row.blueEntryId ? 'WHITE' : 'BLUE',
      kind: 'IPPON',
    });
    const confirm = { id: randomUUID(), type: 'CONFIRM', expectedVersion: result.revision };
    await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirm);
    await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirm);
    const saved = await db.contest.findUniqueOrThrow({ where: { id: row.id } });
    const publicNow = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
    const publicBout = publicNow.categories
      .flatMap((c) => c.draw.contests)
      .find((m) => m.id === row.id);
    assert.equal(publicBout.winnerEntryId, saved.winnerEntryId);
    assert.equal(publicBout.resultReason, saved.resultReason);
    assert.deepEqual(publicBout.state.awards, saved.state.awards);
    assert.deepEqual(publicBout.state.outcome, saved.state.outcome);
    completed++;
    assert.ok(completed < 150);
  }
  const snapshots = await db.drawRecord.findMany({
    where: { category: { tournamentId: tournament } },
  });
  const extra = snapshots.reduce(
    (n, d) => n + d.snapshot.matches.filter((m) => m.tieBreakRound).length,
    0,
  );
  assert.equal(completed, 66 + extra);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'FINISHED',
  );
  assert.equal(
    await db.contest.count({
      where: { draw: { category: { tournamentId: tournament } }, status: { not: 'CONFIRMED' } },
    }),
    0,
  );
  // Correct both kinds of bronze after completion: old podium disappears immediately,
  // then the replacement confirmed winner reaches public results and PDF data.
  for (const format of ['REPECHAGE', 'MIXED']) {
    const category = await db.category.findFirstOrThrow({
      where: { tournamentId: tournament, name: format + (format === 'MIXED' ? 12 : 8) },
      include: { entries: true, draw: { include: { contests: true } } },
    });
    const bronze = category.draw.contests.find((m) => m.key === 'bronze-a');
    const beforeWinner = bronze.winnerEntryId;
    const impact = (await call(`/tournaments/${tournament}/control/${bronze.id}/impact`)).body;
    await post(`/tournaments/${tournament}/control/${bronze.id}/command`, {
      id: randomUUID(),
      type: 'REOPEN',
      expectedRevision: impact.revision,
      impactToken: impact.impactToken,
      reason: 'QA correction of bronze winner',
    });
    const reopened = await db.category.findUniqueOrThrow({
      where: { id: category.id },
      include: { entries: true, draw: { include: { contests: true } } },
    });
    assert.equal(drawPlaces(reopened).complete, false);
    const publicReopened = (
      await call(`/public/tournaments/${tournament}`, undefined, '')
    ).body.categories.find((c) => c.id === category.id);
    const pendingWinners = Object.fromEntries(
      publicReopened.draw.contests
        .filter((c) => c.status === 'CONFIRMED')
        .map((c) => [c.key, c.winnerEntryId]),
    );
    assert.equal(placements(publicReopened.draw.snapshot, pendingWinners), null);
    const send = async (type, extra = {}) => {
      const current = await db.contest.findUniqueOrThrow({ where: { id: bronze.id } });
      return post(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
        id: randomUUID(),
        type,
        expectedVersion: current.revision,
        ...extra,
      });
    };
    await send('REVOKE', {
      awardId: bronze.state.awards.find((a) => a.active && a.kind === 'IPPON').id,
    });
    await send('AWARD', {
      side: beforeWinner === bronze.whiteEntryId ? 'BLUE' : 'WHITE',
      kind: 'IPPON',
    });
    await send('CONFIRM');
    assert.notEqual(
      (await db.contest.findUniqueOrThrow({ where: { id: bronze.id } })).winnerEntryId,
      beforeWinner,
    );
  }
  const publicView = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(publicView.tatamis.flatMap((t) => t.queue).length, 0);
  assert.equal(
    publicView.categories.flatMap((c) => c.draw.contests).filter((c) => c.winnerEntryId).length,
    completed,
  );
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'FINISHED',
  );
  const categories = await db.category.findMany({
    where: { tournamentId: tournament },
    include: { entries: true, draw: { include: { contests: true } } },
  });
  for (const c of categories) {
    const result = categoryResults(c);
    const pub = publicView.categories.find((p) => p.id === c.id);
    const winners = Object.fromEntries(
      pub.draw.contests
        .filter((m) => m.status === 'CONFIRMED')
        .map((m) => [m.key, m.winnerEntryId]),
    );
    assert.deepEqual(result.places, placements(pub.draw.snapshot, winners));
    const printed = drawPlaces(c);
    assert.equal(printed.complete, true);
    assert.deepEqual(
      printed.rows.map((r) => r.entry.id),
      result.places.filter((p) => p.place <= 3).map((p) => p.entryId),
    );
    if (c.entries.length >= 8) {
      assert.deepEqual(
        printed.rows.map((r) => r.place),
        [1, 2, 3, 3],
      );
      const rows = resolveMatches(result.draw, result.winners);
      for (const bronze of rows.filter((m) => m.stage === 'BRONZE')) {
        const provisional = structuredClone(c);
        provisional.draw.contests.find((m) => m.key === bronze.id).status = 'PROVISIONAL';
        assert.equal(drawPlaces(provisional).complete, false);
      }
    }
  }
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile(
    'tmp/pdfs/formats-expected.json',
    JSON.stringify(
      categories.map((c) => ({
        category: c.name,
        places: drawPlaces(c).rows.map((r) => ({
          place: r.place,
          name: r.entry.lastName + ' ' + r.entry.firstName,
        })),
      })),
      null,
      2,
    ) + '\n',
  );
  for (const lang of ['kk', 'ru']) {
    const pdf = await fetch(base + `/tournaments/${tournament}/protocol.pdf?lang=${lang}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(pdf.status, 200);
    await mkdir('tmp/pdfs', { recursive: true });
    await writeFile(`tmp/pdfs/formats-results-${lang}.pdf`, Buffer.from(await pdf.arrayBuffer()));
  }
  console.log(
    'PASS: five new-policy categories through authenticated scoreboard API, start gate, automatic queues, all original and additional confirmed results, repechage/bronze/pool qualifiers, idempotent confirmation, FINISHED lifecycle, public results and RU/KK PDFs.',
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
