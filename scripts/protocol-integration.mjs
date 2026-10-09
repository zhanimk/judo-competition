import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { generateDraw, resolveMatches, bracketNodes } from '@judo/engine/draw';
import { createMatch } from '@judo/engine/match';
import { drawPlaces } from '../apps/api/dist/modules/protocols/pdf-draw-places.js';
import { teamStandings } from '../apps/api/dist/modules/protocols/protocol-model.js';
import { createTestUser } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let owner, foreign, tournament;
async function login(u) {
  const r = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web' },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}
try {
  owner = await createTestUser(db);
  foreign = await createTestUser(db);
  const cookie = await login(owner),
    foreignCookie = await login(foreign);
  tournament = await db.tournament.create({
    data: {
      name: 'EXPORT QA · Қазақша Әлия',
      city: 'Алматы',
      venue: 'QA arena',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      ownerId: owner.id,
      tatamiCount: 1,
    },
  });
  const categories = [];
  for (const [format, count, complete] of [
    ['ROUND_ROBIN', 2, true],
    ['ROUND_ROBIN', 5, true],
    ['REPECHAGE', 8, true],
    ['MIXED', 8, true],
    ['SINGLE_ELIMINATION', 128, false],
    ['SINGLE_ELIMINATION', 7, false],
  ]) {
    const c = await db.category.create({
      data: {
        tournamentId: tournament.id,
        name: `${format} ${count} · U15 −50 кг`,
        gender: 'MALE',
        birthYearFrom: 2012,
        birthYearTo: 2013,
        maxWeightGrams: 50000,
        durationSeconds: 180,
        format,
      },
    });
    categories.push(c);
    const entries = [];
    for (let i = 0; i < count; i++)
      entries.push({
        id: randomUUID(),
        categoryId: c.id,
        lastName: `Спортшы${String(i + 1).padStart(3, '0')}`,
        firstName: 'Әлия',
        birthYear: 2012,
        club: ['Клуб А', 'Клуб Б', ' КЛУБ  А '][i % 3],
      });
    await db.entry.createMany({ data: entries });
    const draw = generateDraw(
      format,
      entries.map((e) => ({
        id: e.id,
        clubId: e.club.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
      })),
      123,
    );
    const record = await db.drawRecord.create({
      data: {
        categoryId: c.id,
        version: 1,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        fingerprint: randomUUID(),
        snapshot: draw,
      },
    });
    const winners = {};
    if (complete)
      for (const m of draw.matches) {
        const row = resolveMatches(draw, winners).find((r) => r.id === m.id);
        assert.ok(row.whiteEntryId);
        winners[m.id] = row.whiteEntryId;
      }
    const resolved = resolveMatches(draw, winners);
    await db.contest.createMany({
      data: resolved.map((m) => {
        const state = createMatch({
          durationMs: 180000,
          shidoLimit: 3,
          wazaForIppon: 2,
          enabledScores: ['IPPON', 'WAZA_ARI', 'YUKO'],
          holdThresholds: [
            { ms: 10000, score: 'WAZA_ARI' },
            { ms: 20000, score: 'IPPON' },
          ],
        });
        if (complete) {
          state.status = 'CONFIRMED';
          state.elapsedMs = 75000;
          state.awards = [{ id: randomUUID(), side: 'WHITE', kind: 'IPPON', active: true }];
          state.outcome = { winner: 'WHITE', reason: 'IPPON' };
        }
        return {
          drawId: record.id,
          key: m.id,
          round: m.round,
          status: complete ? 'CONFIRMED' : 'WAITING',
          whiteEntryId: m.whiteEntryId ?? null,
          blueEntryId: m.blueEntryId ?? null,
          winnerEntryId: m.winnerEntryId ?? null,
          resultReason: complete ? 'IPPON' : null,
          confirmedAt: complete ? new Date() : null,
          state,
        };
      }),
    });
    if (format === 'SINGLE_ELIMINATION') assert.equal(bracketNodes(draw).length, draw.size - 1);
  }
  const snapshot = await db.category.findMany({
    where: { tournamentId: tournament.id },
    include: { entries: true, draw: { include: { contests: true } } },
  });
  for (const c of snapshot) {
    const block = drawPlaces(c);
    if (c.format === 'REPECHAGE')
      assert.deepEqual(
        block.rows.map((r) => r.place),
        [1, 2, 3, 3],
      );
    if (c.format === 'MIXED' || c.entries.length === 2)
      assert.deepEqual(
        block.rows.map((r) => r.place),
        [1, 2],
      );
    if (c.format === 'ROUND_ROBIN' && c.entries.length === 5)
      assert.deepEqual(
        block.rows.map((r) => r.place),
        [1, 2, 3],
      );
    const unfinished = structuredClone(c);
    unfinished.draw.contests.find(
      (m) => m.key === unfinished.draw.snapshot.matches.at(-1).id,
    ).status = 'PROVISIONAL';
    const hidden = drawPlaces(unfinished);
    assert.equal(hidden.complete, false);
    assert.ok(
      hidden.rows.every((r) => r.entry === undefined),
      'Never print provisional medalists',
    );
    assert.equal(block.complete, c.format !== 'SINGLE_ELIMINATION');
  }
  const summary = teamStandings(snapshot);
  assert.equal(summary.complete, 4);
  assert.equal(summary.teams.length, 2);
  assert.equal(
    summary.teams.reduce((n, t) => n + t.gold, 0),
    4,
  );
  assert.equal(
    summary.teams.reduce((n, t) => n + t.silver, 0),
    4,
  );
  assert.equal(
    summary.teams.reduce((n, t) => n + t.bronze, 0),
    3,
  );
  // Ties share competition rank, including a bronze winner after two tied gold teams.
  const tieCategory = (a, b) => {
    const entries = [a, b].map((club, i) => ({
      id: club + ':' + i,
      club,
      firstName: 'QA',
      lastName: club,
    }));
    const draw = generateDraw(
      'ROUND_ROBIN',
      entries.map((e) => ({ id: e.id, clubId: e.club })),
      7,
    );
    const m = draw.matches[0];
    return {
      entries,
      draw: {
        status: 'CONFIRMED',
        snapshot: draw,
        contests: [{ status: 'CONFIRMED', key: m.id, winnerEntryId: entries[0].id }],
      },
    };
  };
  const tied = teamStandings([tieCategory('А', 'В'), tieCategory('Б', 'Г')]);
  assert.deepEqual(
    tied.teams.map((t) => t.rank),
    [1, 1, 3, 3],
  );
  const incomplete = structuredClone(snapshot);
  for (const c of incomplete)
    if (c.draw) c.draw.contests.forEach((m) => (m.status = 'PROVISIONAL'));
  assert.ok(
    teamStandings(incomplete).teams.every(
      (t) => t.rank === null && t.gold === 0 && t.silver === 0 && t.bronze === 0,
    ),
  );
  const url = `${base}/tournaments/${tournament.id}/protocol.pdf`;
  const get = (query = '', auth = cookie) =>
    fetch(url + '?' + query, { headers: { Cookie: auth } });
  for (const [query, status] of [
    ['kind=UNKNOWN', 400],
    ['categoryIds=oops', 400],
    [`categoryIds=${categories[0].id},${categories[0].id}`, 400],
    [`categoryIds=${foreign.id}`, 404],
    [`categoryId=${categories[0].id}&categoryIds=${categories[0].id}`, 400],
  ])
    assert.equal((await get(query)).status, status, query);
  assert.equal((await get('kind=DRAW', '')).status, 401);
  assert.equal((await get('kind=TEAMS', foreignCookie)).status, 403);
  await mkdir('tmp/pdfs/exports', { recursive: true });
  for (const lang of ['ru', 'kk'])
    for (const kind of ['DRAW', 'PARTICIPANTS']) {
      const r = await get(`lang=${lang}&kind=${kind}`);
      assert.equal(r.status, 200, `${kind} ${lang}`);
      assert.match(r.headers.get('content-type'), /application\/pdf/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      await writeFile(`tmp/pdfs/exports/${kind.toLowerCase()}-${lang}.pdf`, bytes);
    }
  for (const kind of ['BOUTS', 'RESULTS', 'TEAMS', 'MEDALS', 'ALL']) {
    const disabled = await get(`kind=${kind}`);
    assert.equal(disabled.status, 409);
    assert.equal((await disabled.json()).message, 'PROTOCOL_NOT_AVAILABLE');
  }
  assert.equal((await get()).status, 200, 'Default download is the draw');
  const subset = await get(`kind=PARTICIPANTS&categoryIds=${categories[0].id},${categories[1].id}`);
  assert.equal(subset.status, 200);
  const subsetBytes = Buffer.from(await subset.arrayBuffer());
  assert.equal(
    (subsetBytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length,
    2,
    'Two small categories must use two pages; footers must not create extra pages',
  );
  await writeFile('tmp/pdfs/exports/subset.pdf', subsetBytes);
  assert.equal((await get(`kind=DRAW&categoryId=${categories[0].id}`)).status, 200);
  console.log(
    'PASS exports: DRAW/PARTICIPANTS × RU/KK, five deferred kinds rejected, 2/5 round robin, 8 repechage/mixed, 7 BYE and 128 bracket, club normalization, medal totals/ties, no provisional medals, subset scope, legacy category scope, 401/403/400/404.',
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament.id } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.category.deleteMany({ where: { tournamentId: tournament.id } });
    await db.tournament.delete({ where: { id: tournament.id } });
  }
  if (owner) await db.user.delete({ where: { id: owner.id } });
  if (foreign) await db.user.delete({ where: { id: foreign.id } });
  await db.$disconnect();
}
