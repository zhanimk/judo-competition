import { fixtureRequest } from './test-access.mjs';
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
      name: 'REMATCH QA Әлихан',
      city: 'Алматы',
      venue: 'Test arena',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 3,
    })
  ).id;
  assert.equal(
    (await call(`/tournaments/${tournament}/start`, {})).body.message,
    'NO_ACTIVE_CATEGORIES',
  );
  assert.equal((await call(`/tournaments/${tournament}/start`, {}, '')).status, 401);
  for (const [format, count] of [
    ['MIXED', 12],
    ['ROUND_ROBIN', 3],
  ]) {
    const c = await post(`/tournaments/${tournament}/categories`, {
      name: format,
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
  assert.equal(frozen.tieBreak, 'REMATCH');
  assert.ok(frozen.approvedAt);
  await post(`/tournaments/${tournament}/start`);
  assert.deepEqual(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).rulesSnapshot,
    frozen,
  );
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
      side: await (async () => {
        const draw = (await db.drawRecord.findUniqueOrThrow({ where: { id: row.drawId } }))
          .snapshot;
        const match = draw.matches.find((m) => m.id === row.key);
        const ids = match.pool
          ? draw.pools.find((p) => p.id === match.pool).entries
          : draw.positions.map((p) => p.id);
        const a = row.whiteEntryId,
          b = row.blueEntryId;
        if (!match.tieBreakRound && (match.pool || draw.algorithm === 'custom-round-robin-v1'))
          return (ids.indexOf(a) + 1) % 3 === ids.indexOf(b) ? 'WHITE' : 'BLUE';
        return a < b ? 'WHITE' : 'BLUE';
      })(),
      kind: 'IPPON',
    });
    const confirm = { id: randomUUID(), type: 'CONFIRM', expectedVersion: result.revision };
    await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirm);
    await post(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirm);
    completed++;
    assert.ok(completed < 50);
  }
  assert.equal(completed, 41); // 12 pool + 12 rematches + 7 knockout + 4 medal bouts; RR 3 + 3 rematches.
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
  const mixed = await db.category.findFirstOrThrow({
    where: { tournamentId: tournament, format: 'MIXED' },
    include: { draw: { include: { contests: true } } },
  });
  assert.ok(mixed.draw.snapshot.tieRounds.length);
  for (const key of [mixed.draw.snapshot.matches.find((m) => m.pool).id, 'bronze-a']) {
    const bout = mixed.draw.contests.find((c) => c.key === key);
    const impact = (await call(`/tournaments/${tournament}/control/${bout.id}/impact`)).body;
    const response = await call(`/tournaments/${tournament}/control/${bout.id}/command`, {
      id: randomUUID(),
      type: 'REOPEN',
      expectedRevision: impact.revision,
      impactToken: impact.impactToken,
      reason: 'QA medal correction after group rematches',
    });
    if (key !== 'bronze-a') {
      assert.equal(response.status, 409);
      assert.equal(response.body.message, 'TIEBREAK_REVIEW_REQUIRED');
    } else {
      assert.equal(response.status, 201);
      const current = await db.contest.findUniqueOrThrow({ where: { id: bout.id } });
      await post(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
        id: randomUUID(),
        type: 'CONFIRM',
        expectedVersion: current.revision,
      });
    }
  }
  const publicView = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(publicView.tatamis.flatMap((t) => t.queue).length, 0);
  assert.equal(
    publicView.categories.flatMap((c) => c.draw.contests).filter((c) => c.winnerEntryId).length,
    41,
  );
  for (const lang of ['kk', 'ru']) {
    const pdf = await fetch(base + `/tournaments/${tournament}/protocol.pdf?lang=${lang}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(pdf.status, 200);
    await mkdir('tmp/pdfs', { recursive: true });
    await writeFile(`tmp/pdfs/rematches-results-${lang}.pdf`, Buffer.from(await pdf.arrayBuffer()));
  }
  console.log(
    'PASS: automatic additional rounds in mixed and round robin, frozen profile; all new formats through authenticated API, start gate, automatic queues, 41 real confirmed results, repechage/bronze/pool qualifiers, idempotent confirmation, FINISHED lifecycle, public results and RU/KK PDFs.',
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
