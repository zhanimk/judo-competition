import { fixtureRequest } from './test-access.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let cookie = '',
  owner,
  outsider,
  tournament;
async function raw(path, data, auth = cookie) {
  return fixtureRequest(base, path, data, auth);
}
async function call(path, data, auth = cookie) {
  const r = await raw(path, data, auth);
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
try {
  owner = await createTestUser(db);
  outsider = await createTestUser(db);
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password })).cookie;
  const foreign = (
    await call('/auth/login', { email: outsider.email, password: outsider.password })
  ).cookie;
  const t = await call('/tournaments', {
    name: 'QA — Ә Ғ Қ Ң Ө Ұ Ү Һ І / Протокол',
    city: 'Алматы',
    venue: 'Тестовый зал',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
    tatamiCount: 2,
  });
  assert.equal(t.status, 201);
  tournament = t.body.id;
  assert.equal((await call(`/public/tournaments/${tournament}`, undefined, '')).status, 404);
  assert.equal(
    (await call('/public/tournaments', undefined, '')).body.some((t) => t.id === tournament),
    false,
  );
  assert.equal((await call(`/tournaments/${tournament}/publish`, {}, foreign)).status, 403);
  assert.equal((await call(`/tournaments/${tournament}/publish`, {}, '')).status, 401);
  const cats = [];
  for (const n of [2, 5]) {
    const c = await call(`/tournaments/${tournament}/categories`, {
      name: `Круговая ${n}`,
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 50000,
      durationSeconds: 180,
      format: 'ROUND_ROBIN',
    });
    assert.equal(c.status, 201);
    cats.push(c.body.id);
    for (let i = 0; i < n; i++)
      assert.equal(
        (
          await call(`/tournaments/${tournament}/categories/${c.body.id}/entries`, {
            firstName: 'Әлихан-Нұрсұлтан'.repeat(3),
            lastName: `Қатысушы ${i} ` + 'Ұзынтегі'.repeat(5),
            club: 'Бір клуб / Один клуб',
            birthYear: 2012,
          })
        ).status,
        201,
      );
    const d = await call(`/categories/${c.body.id}/draw/preview`, {});
    assert.equal(d.status, 201);
    assert.equal(d.body.snapshot.matches.length, (n * (n - 1)) / 2);
  }
  await Promise.all([
    call(`/tournaments/${tournament}/publish`, {}),
    call(`/tournaments/${tournament}/publish`, {}),
  ]);
  assert.equal(
    await db.auditEvent.count({
      where: { tournamentId: tournament, action: 'TOURNAMENT_PUBLISHED' },
    }),
    1,
  );
  let pub = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(pub.tatamis.length, 2);
  assert.equal(
    pub.categories.every((c) => c.draw === null),
    true,
  );
  assert.equal(pub.categories.flatMap((c) => c.entries).length, 7);
  assert.equal(JSON.stringify(pub).includes('birthYear'), false);
  assert.equal('ownerId' in pub, false);
  for (const id of cats) {
    const d = (await call(`/categories/${id}/draw`)).body.draw;
    const c = await call(`/categories/${id}/draw/confirm`, { version: d.version });
    assert.equal(c.status, 201);
    assert.equal(
      (await call(`/public/tournaments/${tournament}`, undefined, '')).body.categories.find(
        (x) => x.id === id,
      ).draw,
      null,
    );
    await call(`/categories/${id}/draw/publication`, { published: true, expectedRevision: 0 });
    assert.equal(c.body.contests.length, id === cats[0] ? 1 : 10);
    const ready = c.body.contests.find((contest) => contest.status === 'READY');
    assert.equal(
      (
        await call(`/contests/${ready.id}/assign`, {
          id: randomUUID(),
          expectedRevision: ready.revision,
          tatamiId: pub.tatamis[0].id,
        })
      ).status,
      201,
    );
  }
  pub = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(pub.tatamis[0].queue.length, 2);
  assert.equal(
    pub.categories.every((c) => c.draw.status === 'CONFIRMED'),
    true,
  );
  assert.equal((await raw(`/tournaments/${tournament}/protocol.pdf`, undefined, '')).status, 401);
  assert.equal(
    (await raw(`/tournaments/${tournament}/protocol.pdf`, undefined, foreign)).status,
    403,
  );
  assert.equal(
    (await raw(`/tournaments/${tournament}/protocol.pdf?categoryId=${owner.id}`)).status,
    404,
  );
  assert.equal((await raw(`/tournaments/${tournament}/protocol.pdf?lang=en`)).status, 400);
  await mkdir('tmp/pdfs', { recursive: true });
  for (const [file, query] of [
    ['qa-all-kk', 'lang=kk'],
    ['qa-single-ru', `lang=ru&categoryId=${cats[0]}`],
  ]) {
    const r = await raw(`/tournaments/${tournament}/protocol.pdf?${query}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    await writeFile(`tmp/pdfs/${file}.pdf`, buf);
  }
  console.log(
    'PASS: publication ownership/idempotency/audit, anonymous catalog, hidden previews, sanitized participants, round robin 2/5 persisted, shared queues, PDF access/filter/languages.',
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
  for (const u of [owner, outsider]) if (u) await db.user.delete({ where: { id: u.id } });
  await db.$disconnect();
}
