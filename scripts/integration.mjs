import { fixtureRequest } from './test-access.mjs';
import { createTestUser, createTestEntries } from './test-user.mjs';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let id;
let userId;
let cookie = '';
async function post(path, data) {
  const r = await fixtureRequest(base, path, data, cookie);
  return { status: r.status, body: await r.json() };
}
try {
  const fixture = await createTestUser(db);
  userId = fixture.id;
  const registration = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web' },
    body: JSON.stringify({ email: fixture.email, password: fixture.password }),
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get('set-cookie').split(';')[0];
  userId = (await (await fetch(base + '/auth/me', { headers: { Cookie: cookie } })).json()).id;
  const invalid = await post('/tournaments', {
    name: 'Test',
    city: 'Test',
    venue: 'Test',
    startDate: '2026-10-11',
    endDate: '2026-10-10',
    tatamiCount: 2,
  });
  assert.equal(invalid.status, 400);
  const result = await post('/tournaments', {
    name: 'Integration test ' + crypto.randomUUID(),
    city: 'Test',
    venue: 'Test',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
    tatamiCount: 2,
  });
  assert.equal(result.status, 201);
  id = result.body.id;
  const tatamis = await (
    await fetch(base + `/tournaments/${id}/tatamis`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(tatamis.length, 2);
  assert.deepEqual(
    tatamis.map((t) => t.number),
    [1, 2],
  );
  assert.equal((await fetch(base + `/tournaments/${id}/tatamis/${tatamis[0].id}`)).status, 404);
  const display = await (
    await fetch(base + `/tournaments/${id}/tatamis/${tatamis[0].id}`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(display.tournament.id, id);
  assert.equal(display.controlAvailable, false);
  assert.equal(display.currentMatch, null);
  assert.equal(
    (await fetch(base + `/tournaments/${crypto.randomUUID()}/tatamis/${tatamis[0].id}`)).status,
    404,
  );
  const payload = {
    name: 'U15 test',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
  };
  const category = await post(`/tournaments/${id}/categories`, payload);
  assert.equal(category.status, 201);
  assert.equal((await post(`/tournaments/${id}/categories`, payload)).status, 409);
  const path = `/tournaments/${id}/categories/${category.body.id}/entries`;
  assert.equal(
    (
      await post(path, {
        firstName: 'Test',
        lastName: 'Athlete',
        club: 'Test Club',
        birthYear: 2001,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(path, {
        firstName: 'Test',
        lastName: 'Athlete',
        club: 'Test Club',
        birthYear: 2012,
      })
    ).status,
    201,
  );
  const saved = await (
    await fetch(base + `/tournaments/${id}`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(saved.categories[0].entries.length, 1);
  assert.equal(await db.entry.count({ where: { categoryId: category.body.id } }), 1);
  await createTestEntries(
    db,
    Array.from({ length: 126 }, (_, i) => ({
      categoryId: category.body.id,
      firstName: 'Capacity',
      lastName: String(i),
      club: 'Test Club',
      birthYear: 2012,
    })),
  );
  const parallel = await Promise.all([
    post(path, { firstName: 'Concurrent A', lastName: 'Test', club: 'Test Club', birthYear: 2012 }),
    post(path, { firstName: 'Concurrent B', lastName: 'Test', club: 'Test Club', birthYear: 2012 }),
  ]);
  assert.deepEqual(parallel.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await db.entry.count({ where: { categoryId: category.body.id } }), 128);
  const forbidden = await fetch(base + '/tournaments', {
    headers: { origin: 'https://untrusted.example' },
  });
  assert.equal(forbidden.status, 403);
  const open = await post(`/tournaments/${id}/categories`, {
    ...payload,
    name: 'Open +55',
    maxWeightGrams: null,
    minWeightGrams: 55000,
  });
  assert.equal(open.status, 201);
  const persistedOpen = await db.category.findUniqueOrThrow({ where: { id: open.body.id } });
  assert.equal(persistedOpen.maxWeightGrams, null);
  assert.equal(persistedOpen.minWeightGrams, 55000);
  for (const bounds of [
    { maxWeightGrams: null },
    { maxWeightGrams: 50000, minWeightGrams: 55000 },
    { maxWeightGrams: null, minWeightGrams: -55000 },
    { maxWeightGrams: null, minWeightGrams: 55000.5 },
    { maxWeightGrams: undefined, minWeightGrams: 55000 },
  ]) {
    assert.equal(
      (
        await post(`/tournaments/${id}/categories`, {
          ...payload,
          name: 'Invalid weight',
          ...bounds,
        })
      ).status,
      400,
    );
  }
  console.log(
    'PASS: tournament/category/entry persistence, open-weight bounds, invalid dates/age, duplicate category, concurrent capacity limit, origin rejection.',
  );
} finally {
  if (id) {
    await db.entry.deleteMany({ where: { category: { tournamentId: id } } });
    await db.category.deleteMany({ where: { tournamentId: id } });
    await db.tatami.deleteMany({ where: { tournamentId: id } });
    await db.tournament.delete({ where: { id } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
}
