import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';
import { fixtureRequest } from './test-access.mjs';

const configuredSchema = new URL(process.env.DATABASE_URL).searchParams.get('schema'),
  base = process.env.TEST_API_URL;
assert.match(configuredSchema ?? '', /^qa_rehearsal_[a-f0-9]{32}$/);
assert.ok(base, 'Auth safety needs the disposable rehearsal API');
const db = new PrismaClient(),
  users = [],
  tournaments = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(path, body, cookie = '') {
  const r = await fixtureRequest(base, path, body, cookie);
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(role = 'ORGANIZER') {
  const user = await createTestUser(db, role);
  users.push(user.id);
  const response = await call('/auth/login', { email: user.email, password: user.password });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { user, cookie: response.cookie };
}
async function session(cookie) {
  const token = cookie.slice('judo_session='.length);
  return db.session.findUniqueOrThrow({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
  });
}
async function waitBlocked(blockers, excluded = []) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows =
      await db.$queryRaw`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM "Session"%'`;
    const blocked = rows.find(
      (row) => !excluded.includes(row.pid) && row.blockers.some((id) => blockers.includes(id)),
    );
    if (blocked) return blocked.pid;
    await wait(15);
  }
  assert.fail('Auth request must reach the actual PostgreSQL Session lock queue');
}
const registration = () => ({
  email: `${randomUUID()}@test.example`,
  name: 'QA новый администратор',
  password: randomBytes(24).toString('hex'),
});
async function registrationRace(order) {
  const admin = await login('SUPER_ADMIN'),
    live = await session(admin.cookie),
    dto = registration();
  let creation, logout;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${live.id} FOR UPDATE`;
        let first;
        if (order === 'register-first') {
          creation = call('/auth/users', dto, admin.cookie);
          creation.catch(() => {});
          first = await waitBlocked([pid]);
          logout = call('/auth/logout', {}, admin.cookie);
          logout.catch(() => {});
        } else {
          logout = call('/auth/logout', {}, admin.cookie);
          logout.catch(() => {});
          first = await waitBlocked([pid]);
          creation = call('/auth/users', dto, admin.cookie);
          creation.catch(() => {});
        }
        await waitBlocked([pid, first], [first]);
      },
      { timeout: 15000 },
    );
    const [created, loggedOut] = await Promise.all([creation, logout]);
    assert.equal(loggedOut.status, 201, JSON.stringify(loggedOut.body));
    if (order === 'register-first') {
      assert.equal(created.status, 201, JSON.stringify(created.body));
      users.push(created.body.id);
      assert.equal(created.body.role, 'ORGANIZER');
      assert.equal('passwordHash' in created.body, false);
      assert.equal('password' in created.body, false);
    } else {
      assert.equal(created.status, 401, JSON.stringify(created.body));
      assert.equal(created.body.message, 'AUTH_REQUIRED');
      assert.equal(await db.user.count({ where: { email: dto.email } }), 0);
    }
    assert.equal((await call('/auth/users', registration(), admin.cookie)).status, 401);
    assert.equal(await db.session.findUnique({ where: { id: live.id } }), null);
  } finally {
    await Promise.allSettled([creation, logout].filter(Boolean));
  }
}
async function changedWhileHashing(kind) {
  const admin = await login('SUPER_ADMIN'),
    live = await session(admin.cookie),
    dto = registration();
  let pending;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${live.id} FOR UPDATE`;
        pending = call('/auth/users', dto, admin.cookie);
        pending.catch(() => {});
        await waitBlocked([pid]);
        if (kind === 'expiry')
          await tx.session.update({ where: { id: live.id }, data: { expiresAt: new Date(0) } });
        else await tx.user.update({ where: { id: admin.user.id }, data: { role: 'ORGANIZER' } });
      },
      { timeout: 15000 },
    );
    const result = await pending;
    assert.equal(result.status, 401, JSON.stringify(result.body));
    assert.equal(result.body.message, 'AUTH_REQUIRED');
    assert.equal(await db.user.count({ where: { email: dto.email } }), 0);
  } finally {
    if (pending) await Promise.allSettled([pending]);
  }
}
try {
  const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(schema, configuredSchema);
  const owner = await login();
  const successful = await Promise.all(
    Array.from({ length: 32 }, () =>
      call('/auth/login', { email: owner.user.email, password: owner.user.password }),
    ),
  );
  assert.ok(
    successful.every((r) => r.status === 201),
    '32 valid sign-ins from the same trusted venue address must succeed',
  );
  for (const r of successful) {
    assert.equal(r.body.workRole, 'ADMIN');
    assert.equal('passwordHash' in r.body, false);
  }
  assert.equal((await call('/auth/users', registration(), owner.cookie)).status, 403);
  const tournament = (
    await db.tournament.create({
      data: {
        ownerId: owner.user.id,
        name: 'AUTH VENUE QA',
        city: 'QA',
        venue: 'Isolated 32-device venue',
        startDate: '2026-10-10',
        endDate: '2026-10-10',
        tatamiCount: 1,
      },
    })
  ).id;
  tournaments.push(tournament);
  const mat = (await db.tatami.create({ data: { tournamentId: tournament, number: 1 } })).id;
  const tokens = Array.from({ length: 32 }, () => randomBytes(32).toString('hex'));
  for (let i = 0; i < tokens.length; i++) {
    const created = await call(
      `/auth/tatamis/${mat}/invitations`,
      { label: `QA venue judge ${i}`, hours: 1, token: tokens[i] },
      owner.cookie,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const accepted = await Promise.all(
    tokens.map((token, i) => call('/auth/invitations/accept', { token, name: `QA судья ${i}` })),
  );
  assert.ok(
    accepted.every((r) => r.status === 201),
    '32 valid invitation redemptions from one venue must succeed',
  );
  for (const r of accepted) {
    const me = await call('/auth/me', undefined, r.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.workRole, 'JUDGE');
    users.push(me.body.id);
    assert.equal('token' in r.body, false);
  }
  const lockTarget = await createTestUser(db);
  users.push(lockTarget.id);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await call('/auth/login', { email: lockTarget.email, password: 'incorrect' })).status,
      401,
    );
  assert.equal(
    (
      await call('/auth/login', {
        email: lockTarget.email.toUpperCase(),
        password: lockTarget.password,
      })
    ).status,
    429,
    'Normalized credential failure budget applies across casing',
  );
  assert.equal(
    (await call('/auth/login', { email: owner.user.email, password: owner.user.password })).status,
    201,
    'One bad credential must not block valid users sharing a venue',
  );
  await registrationRace('logout-first');
  await registrationRace('register-first');
  await changedWhileHashing('expiry');
  await changedWhileHashing('role');
  console.log(
    'PASS auth safety: 32 valid venue logins +32 invitation redemptions, failure-only normalized credential throttling, global account creation fresh Session, both real PostgreSQL logout orders, expiry/role loss during async hashing, no credential leaks',
  );
} finally {
  for (const tournamentId of tournaments) {
    await db.invitation.deleteMany({ where: { tatami: { tournamentId } } });
    await db.auditEvent.deleteMany({ where: { tournamentId } });
    await db.tatami.deleteMany({ where: { tournamentId } });
    await db.tournament.delete({ where: { id: tournamentId } });
  }
  if (users.length) {
    await db.session.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
  await db.$disconnect();
}
