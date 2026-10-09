import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4318/api/v1';
const name = 'ТЕСТ-150 · вымышленные участники · v1';
const config = [
  ['Юноши U11 · −30 кг', 2, 'MALE', 2016, 2017, 30000],
  ['Девочки U11 · −28 кг', 3, 'FEMALE', 2016, 2017, 28000],
  ['Юноши U13 · −38 кг', 5, 'MALE', 2014, 2015, 38000],
  ['Девочки U13 · −36 кг', 8, 'FEMALE', 2014, 2015, 36000],
  ['Юноши U15 · −46 кг', 13, 'MALE', 2012, 2013, 46000],
  ['Девушки U15 · −44 кг', 16, 'FEMALE', 2012, 2013, 44000],
  ['Юноши U15 · −50 кг', 32, 'MALE', 2012, 2013, 50000],
  ['Девушки U15 · −48 кг', 71, 'FEMALE', 2012, 2013, 48000],
];
let cookie = '',
  fixture,
  tournamentId;
async function call(path, data) {
  const r = await fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(body)}`);
  return { body, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
try {
  const admin = await db.user.findUnique({ where: { email: 'admin@judo.local' } });
  assert.equal(admin?.role, 'SUPER_ADMIN');
  const existing = await db.tournament.findFirst({ where: { name, ownerId: admin.id } });
  if (!existing) {
    fixture = await createTestUser(db);
    cookie = (await call('/auth/login', { email: fixture.email, password: fixture.password }))
      .cookie;
    tournamentId = (
      await call('/tournaments', {
        name,
        city: 'Алматы',
        venue: 'Тестовая площадка · не реальные соревнования',
        startDate: '2026-10-10',
        endDate: '2026-10-11',
        tatamiCount: 4,
      })
    ).body.id;
    let ordinal = 0,
      assigned = 0;
    const mats = (await call(`/tournaments/${tournamentId}/tatamis`)).body;
    for (const [categoryName, n, gender, from, to, weight] of config) {
      const c = (
        await call(`/tournaments/${tournamentId}/categories`, {
          name: categoryName,
          gender,
          birthYearFrom: from,
          birthYearTo: to,
          maxWeightGrams: weight,
          durationSeconds: from >= 2016 ? 120 : 180,
        })
      ).body;
      for (let i = 0; i < n; i++) {
        ordinal++;
        const club = n === 8 ? (i < 5 ? 0 : i - 4) : n === 5 ? 0 : i % 8;
        await call(`/tournaments/${tournamentId}/categories/${c.id}/entries`, {
          lastName: `Тест-${String(ordinal).padStart(3, '0')}`,
          firstName:
            gender === 'MALE'
              ? ['Арман', 'Данияр', 'Ерлан', 'Аслан'][i % 4]
              : ['Аружан', 'Айша', 'Амина', 'Дана'][i % 4],
          club: `Тест-клуб ${String.fromCharCode(65 + club)}`,
          birthYear: i % 2 ? to : from,
        });
      }
      const preview = (await call(`/categories/${c.id}/draw/preview`, {})).body;
      const draw = (await call(`/categories/${c.id}/draw/confirm`, { version: preview.version }))
        .body;
      for (const contest of draw.contests.filter((m) => m.status === 'READY'))
        await call(`/contests/${contest.id}/assign`, {
          tatamiId: mats[assigned++ % mats.length].id,
        });
    }
    assert.equal(ordinal, 150);
    await db.tournament.update({ where: { id: tournamentId }, data: { ownerId: admin.id } });
  } else tournamentId = existing.id;
  const t = await db.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    include: {
      categories: { include: { entries: true, draw: { include: { contests: true } } } },
      tatamis: true,
    },
  });
  assert.equal(t.categories.length, 8);
  assert.equal(
    t.categories.reduce((n, c) => n + c.entries.length, 0),
    150,
  );
  const rows = [];
  for (const [categoryName, n] of config) {
    const c = t.categories.find((c) => c.name === categoryName);
    assert.ok(c);
    assert.equal(c.entries.length, n);
    assert.equal(c.draw?.status, 'CONFIRMED');
    assert.equal(c.draw.contests.length, n - 1);
    const snap = c.draw.snapshot;
    assert.equal(new Set(snap.positions.filter(Boolean).map((e) => e.id)).size, n);
    const counts = {};
    for (const e of c.entries) counts[e.club] = (counts[e.club] ?? 0) + 1;
    const lowerBound = Math.max(0, Math.max(...Object.values(counts)) - snap.size / 2);
    assert.equal(snap.firstRoundClubPairs, lowerBound);
    rows.push({
      category: c.name,
      participants: n,
      bracketSize: snap.size,
      byes: snap.size - n,
      matches: c.draw.contests.length,
      clubPairs: snap.firstRoundClubPairs,
      minimumClubPairs: lowerBound,
      queued: c.draw.contests.filter((m) => m.tatamiId).length,
    });
  }
  const queues = [];
  for (const mat of t.tatamis) {
    const r = await fetch(`${base}/tournaments/${t.id}/tatamis/${mat.id}`);
    assert.equal(r.status, 200);
    const pub = await r.json();
    assert.equal(pub.controlAvailable, false);
    assert.equal(pub.currentMatch, null);
    assert.ok(pub.queue.every((m) => m.white && m.blue));
    queues.push({ number: mat.number, count: pub.queue.length });
  }
  const unauth = await fetch(base + '/tournaments/' + t.id);
  assert.equal(unauth.status, 401);
  const report = {
    generatedAt: new Date().toISOString(),
    tournamentId,
    url: `http://127.0.0.1:4318/tournaments/${t.id}`,
    participants: 150,
    categories: rows,
    queues,
    checks: {
      persisted: true,
      uniqueEntries: true,
      byeCorrect: true,
      minimumOpeningClubPairs: true,
      publicQueue: true,
      privateTournamentProtected: true,
    },
    notImplemented: [
      'Repechage',
      'Round robin final ranking',
      'Mixed formats',
      'Final standings for repechage and round robin',
    ],
    note: 'Test draw, not completed competition. Athlete ages are fixture parameters, not an official category template.',
  };
  await mkdir('docs/reports', { recursive: true });
  await writeFile('docs/reports/test-150.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (fixture) {
    if (tournamentId)
      await db.tournament.updateMany({
        where: { id: tournamentId, ownerId: fixture.id },
        data: { ownerId: (await db.user.findUnique({ where: { email: 'admin@judo.local' } })).id },
      });
    await db.user.delete({ where: { id: fixture.id } });
  }
  await db.$disconnect();
}
