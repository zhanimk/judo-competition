import { createTestUser } from './test-user.mjs';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
const users = [];
const tournaments = [];
async function call(path, data, cookie = '') {
  const r = await fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    header: r.headers.get('set-cookie'),
  };
}
async function register() {
  const { email, password } = await createTestUser(db);
  const r = await call('/auth/login', { email, password });
  assert.equal(r.status, 201);
  assert.ok(r.header.includes('HttpOnly'));
  assert.ok(r.header.includes('SameSite=Strict'));
  const me = await call('/auth/me', undefined, r.cookie);
  users.push(me.body.id);
  return { ...r, email, password };
}
try {
  assert.equal((await call('/tournaments')).status, 401);
  assert.notEqual(
    (
      await call('/auth/register', {
        email: 'nobody@test.example',
        password: 'abcdefghijkl',
        name: 'Nobody',
      })
    ).status,
    201,
  );
  const a = await register(),
    b = await register();
  assert.equal((await call('/auth/login', { email: a.email, password: 'incorrect' })).status, 401);
  const login = await call('/auth/login', { email: a.email, password: a.password });
  assert.equal(login.status, 201);
  assert.equal((await call('/auth/me', undefined, login.cookie)).body.id, users[0]);
  await call('/auth/logout', {}, login.cookie);
  const t = await call(
    '/tournaments',
    {
      name: 'Auth test',
      city: 'Test',
      venue: 'Test',
      startDate: '2026-10-10',
      endDate: '2026-10-11',
      tatamiCount: 2,
    },
    a.cookie,
  );
  assert.equal(t.status, 201);
  tournaments.push(t.body.id);
  assert.equal((await call('/tournaments/' + t.body.id, undefined, b.cookie)).status, 403);
  const admin = await createTestUser(db, 'SUPER_ADMIN');
  users.push(admin.id);
  const ac = (await call('/auth/login', { email: admin.email, password: admin.password })).cookie;
  assert.equal((await call('/tournaments/' + t.body.id, undefined, ac)).status, 200);
  assert.equal((await call('/auth/users', undefined, b.cookie)).status, 403);
  const created = await call(
    '/auth/users',
    {
      email: crypto.randomUUID() + '@test.example',
      name: 'Managed',
      password: crypto.randomUUID(),
    },
    ac,
  );
  assert.equal(created.status, 201);
  users.push(created.body.id);
  assert.equal(
    (
      await call(
        '/auth/users',
        {
          email: crypto.randomUUID() + '@test.example',
          name: 'Denied',
          password: crypto.randomUUID(),
        },
        b.cookie,
      )
    ).status,
    403,
  );
  const mats = (await call(`/tournaments/${t.body.id}/tatamis`, undefined, a.cookie)).body;
  assert.equal(
    (
      await call(
        `/auth/tatamis/${mats[0].id}/invitations`,
        { label: 'Operator', hours: 1 },
        b.cookie,
      )
    ).status,
    403,
  );
  const invite = await call(
    `/auth/tatamis/${mats[0].id}/invitations`,
    { label: 'Operator', hours: 1 },
    a.cookie,
  );
  assert.equal(invite.status, 201);
  const accepted = await Promise.all([
    call('/auth/invitations/accept', { token: invite.body.token, name: 'Operator A' }),
    call('/auth/invitations/accept', { token: invite.body.token, name: 'Operator B' }),
  ]);
  assert.deepEqual(accepted.map((r) => r.status).sort(), [201, 401]);
  const op = accepted.find((r) => r.status === 201);
  users.push((await call('/auth/me', undefined, op.cookie)).body.id);
  assert.equal(
    (await call(`/auth/tatamis/${mats[0].id}/control`, undefined, op.cookie)).status,
    200,
  );
  assert.equal(
    (await call(`/auth/tatamis/${mats[1].id}/control`, undefined, op.cookie)).status,
    403,
  );
  assert.equal((await call('/tournaments', undefined, op.cookie)).status, 403);
  for (const path of [
    `/tournaments/${t.body.id}/tatamis/${mats[0].id}`,
    `/tatamis/${mats[0].id}/live`,
  ]) {
    assert.equal((await call(path)).status, 404);
    assert.equal((await call(path, undefined, b.cookie)).status, 403);
    assert.equal((await call(path, undefined, a.cookie)).status, 200);
    assert.equal((await call(path, undefined, ac)).status, 200);
    assert.equal((await call(path, undefined, op.cookie)).status, 200);
  }
  assert.equal((await call(`/tatamis/${mats[1].id}/live`, undefined, op.cookie)).status, 403);
  await call(`/auth/invitations/${invite.body.id}/revoke`, {}, a.cookie);
  assert.equal(
    (await call(`/auth/tatamis/${mats[0].id}/control`, undefined, op.cookie)).status,
    401,
  );
  assert.equal((await call(`/tatamis/${mats[0].id}/live`, undefined, op.cookie)).status, 404);
  await call(`/tournaments/${t.body.id}/publish`, {}, a.cookie);
  assert.equal((await call(`/tatamis/${mats[0].id}/live`)).status, 200);
  assert.equal((await call(`/tournaments/${t.body.id}/tatamis/${mats[0].id}`)).status, 200);
  const expired = await call(
    `/auth/tatamis/${mats[0].id}/invitations`,
    { label: 'Expired', hours: 1 },
    a.cookie,
  );
  await db.invitation.update({
    where: { id: expired.body.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await call('/auth/invitations/accept', { token: expired.body.token, name: 'Expired' })).status,
    401,
  );
  const noCsrf = await fetch(base + '/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
    body: '{}',
  });
  assert.equal(noCsrf.status, 403);
  await call('/auth/logout', {}, a.cookie);
  assert.equal((await call('/auth/me', undefined, a.cookie)).status, 401);
  console.log(
    'PASS: password login, private tournament/LIVE/queue access, publication, CSRF, one-time concurrent invitation redemption, tatami scope, expiry, revocation and logout.',
  );
} finally {
  for (const id of tournaments) {
    await db.tatami.deleteMany({ where: { tournamentId: id } });
    await db.tournament.delete({ where: { id } });
  }
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
