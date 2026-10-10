import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';

// Real HTTP requests and PostgreSQL row queues in a disposable rehearsal schema.
// No default API/DB target: the developer's running application is never used.
const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const userIds = [],
  tournamentIds = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, data, cookie = '') {
  const response = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
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

async function fixture(label) {
  const owner = await createTestUser(db);
  userIds.push(owner.id);
  const login = await call('/auth/login', { email: owner.email, password: owner.password });
  assert.equal(login.status, 201);
  const cookie = login.cookie;
  const session = await db.session.findUniqueOrThrow({
    where: {
      tokenHash: createHash('sha256').update(cookie.slice('judo_session='.length)).digest('hex'),
    },
  });
  const tournament = await ok(
    '/tournaments',
    {
      name: 'QA · Assignment Session race · ' + label,
      city: 'QA',
      venue: 'Isolated rehearsal',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    },
    cookie,
  );
  tournamentIds.push(tournament.id);
  const [mat] = await ok(`/tournaments/${tournament.id}/tatamis`, undefined, cookie);
  const category = await ok(
    `/tournaments/${tournament.id}/categories`,
    {
      name: 'QA Assignment race U15',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
    },
    cookie,
  );
  const club = await ok(
    `/tournaments/${tournament.id}/clubs`,
    {
      id: randomUUID(),
      expectedRevision: 0,
      name: 'QA Assignment race club',
    },
    cookie,
  );
  await ok(
    `/tournaments/${tournament.id}/roster`,
    {
      id: randomUUID(),
      expectedRevision: club.revision,
      clubId: club.club.id,
      entries: [1, 2].map((index) => ({
        firstName: 'Assignment QA',
        lastName: 'Athlete-' + index,
        birthYear: 2012,
        gender: 'MALE',
        categoryId: category.id,
      })),
    },
    cookie,
  );
  const preview = await ok(`/categories/${category.id}/draw/preview`, {}, cookie);
  await ok(`/categories/${category.id}/draw/confirm`, { version: preview.version }, cookie);
  const contest = await db.contest.findFirstOrThrow({
    where: { draw: { categoryId: category.id }, status: 'READY' },
  });
  assert.equal(contest.tatamiId, null, 'the assignment fixture has not been scheduled or started');
  assert.equal(
    mat.controllerSessionId,
    null,
    'logout discovers no held mat before the Session barrier',
  );
  return {
    owner,
    cookie,
    sessionId: session.id,
    tournamentId: tournament.id,
    categoryId: category.id,
    matId: mat.id,
    contestId: contest.id,
    command: { id: randomUUID(), expectedRevision: contest.revision, tatamiId: mat.id },
  };
}

async function snapshot(c) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({ where: { id: c.tournamentId } }),
    mat: await db.tatami.findUniqueOrThrow({ where: { id: c.matId } }),
    category: await db.category.findUniqueOrThrow({ where: { id: c.categoryId } }),
    contest: await db.contest.findUniqueOrThrow({ where: { id: c.contestId } }),
    draw: await db.drawRecord.findUniqueOrThrow({ where: { categoryId: c.categoryId } }),
    entries: await db.entry.findMany({
      where: { categoryId: c.categoryId },
      orderBy: { id: 'asc' },
    }),
    session: await db.session.findUnique({ where: { id: c.sessionId } }),
    receipts: await db.matchEvent.findMany({
      where: { contestId: c.contestId },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    accessCommands: await db.accessCommand.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    rosterCommands: await db.rosterCommand.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
  };
}

async function waitForSessionBlock(blockerPids, excludedPids = []) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const waiting = await db.$queryRaw`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user
        AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM "Session"%'
    `;
    const blocked = waiting.find(
      (row) =>
        !excludedPids.includes(row.pid) && row.blockers.some((pid) => blockerPids.includes(pid)),
    );
    if (blocked) return blocked.pid;
    await wait(15);
  }
  assert.fail('Both HTTP operations must reach the actual PostgreSQL Session lock queue');
}

function withoutSession(state) {
  const { session: _session, ...rest } = state;
  return rest;
}

async function race(order) {
  const c = await fixture(order);
  const before = await snapshot(c);
  const requests = {
    assign: () => call(`/contests/${c.contestId}/assign`, c.command, c.cookie),
    logout: () => call('/auth/logout', {}, c.cookie),
  };
  const sequence = order === 'assign-first' ? ['assign', 'logout'] : ['logout', 'assign'];
  const pending = [];
  let outcome;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${c.sessionId} FOR UPDATE`;
        pending.push(requests[sequence[0]]());
        pending[0].catch(() => {});
        const firstPid = await waitForSessionBlock([pid]);
        pending.push(requests[sequence[1]]());
        pending[1].catch(() => {});
        const secondPid = await waitForSessionBlock([pid, firstPid], [firstPid]);
        assert.notEqual(
          firstPid,
          secondPid,
          'two HTTP transactions have passed initial authentication',
        );
      },
      { timeout: 10000 },
    );
    const responses = await Promise.all(pending);
    outcome = Object.fromEntries(sequence.map((action, index) => [action, responses[index]]));
  } finally {
    await Promise.allSettled(pending);
  }
  const after = await snapshot(c);
  assert.equal(outcome.logout.status, 201, JSON.stringify(outcome.logout.body));
  assert.equal(after.session, null);
  if (order === 'logout-first') {
    assert.equal(outcome.assign.status, 401, JSON.stringify(outcome.assign.body));
    assert.equal(outcome.assign.body.message, 'AUTH_REQUIRED');
    assert.deepEqual(
      withoutSession(after),
      withoutSession(before),
      'lost Session cannot pin a category, queue a bout or create receipt/audit',
    );
  } else {
    assert.equal(outcome.assign.status, 201, JSON.stringify(outcome.assign.body));
    const receipt = after.receipts.find((event) => event.id === c.command.id);
    assert.ok(receipt);
    assert.equal(receipt.actorId, c.owner.id);
    assert.equal(receipt.type, 'MATCH_ASSIGNED');
    assert.deepEqual(receipt.payload, { command: c.command, response: outcome.assign.body });
    assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.equal(after.audits.length, before.audits.length + 1);
    const audit = after.audits.find((event) => !before.audits.some((old) => old.id === event.id));
    assert.equal(audit.action, 'MATCH_ASSIGNED');
    assert.equal(audit.actorId, c.owner.id);
    assert.deepEqual(audit.payload.after, outcome.assign.body);
    assert.deepEqual(after.contest, {
      ...before.contest,
      tatamiId: c.matId,
      queueOrder: 1,
      revision: before.contest.revision + 1,
      updatedAt: after.contest.updatedAt,
    });
    assert.deepEqual(after.category, { ...before.category, homeTatamiId: c.matId });
    for (const key of ['tournament', 'mat', 'draw', 'entries', 'accessCommands', 'rosterCommands'])
      assert.deepEqual(after[key], before[key], key + ' is unchanged by assignment/logout');

    // Exact retry from the logged-out cookie is denied. A new live session of
    // this author can recover the immutable receipt without writing again.
    assert.equal((await requests.assign()).status, 401);
    const renewed = await call('/auth/login', { email: c.owner.email, password: c.owner.password });
    assert.equal(renewed.status, 201);
    assert.deepEqual(
      await ok(`/contests/${c.contestId}/assign`, c.command, renewed.cookie),
      outcome.assign.body,
    );
    assert.deepEqual(await snapshot(c), after);
  }
  assert.equal((await call('/auth/me', undefined, c.cookie)).status, 401);
  console.log('PASS real PostgreSQL assignment Session barrier: ' + order);
}

async function expiresWhileWaiting() {
  const c = await fixture('expiry');
  const before = await snapshot(c);
  let pending, response;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${c.sessionId} FOR UPDATE`;
        pending = call(`/contests/${c.contestId}/assign`, c.command, c.cookie);
        pending.catch(() => {});
        await waitForSessionBlock([pid]);
        // This commits before the waiting assignment obtains the Session lock.
        await tx.session.update({ where: { id: c.sessionId }, data: { expiresAt: new Date(0) } });
      },
      { timeout: 10000 },
    );
    response = await pending;
  } finally {
    if (pending) await Promise.allSettled([pending]);
  }
  assert.equal(response.status, 401, JSON.stringify(response.body));
  assert.equal(response.body.message, 'AUTH_REQUIRED');
  const after = await snapshot(c);
  assert.equal(after.session.expiresAt.getTime(), 0);
  assert.deepEqual(
    withoutSession(after),
    withoutSession(before),
    'expiry during the wait rolls back every assignment effect',
  );
  console.log('PASS real PostgreSQL assignment Session barrier: expiry while waiting');
}

try {
  assert.ok(base, 'TEST_API_URL for the isolated rehearsal API is required');
  const configuredSchema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(
    configuredSchema ?? '',
    /^qa_[a-z0-9_]+$/,
    'only a disposable qa_ schema is allowed',
  );
  const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(schema, configuredSchema, 'PostgreSQL must use the configured disposable schema');
  await race('assign-first');
  await race('logout-first');
  await expiresWhileWaiting();
  console.log(
    'PASS: both real logout/assignment orders, expiry, initial authorization gap, atomic rollback and immutable receipt after renewed login.',
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
