import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';

// This suite must run against the isolated rehearsal API and schema. It never
// connects to the developer's running API or creates fixtures in public.
const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const userIds = [];
const tournamentIds = [];
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

async function fixture(order) {
  const owner = await createTestUser(db);
  userIds.push(owner.id);
  const login = await call('/auth/login', { email: owner.email, password: owner.password });
  assert.equal(login.status, 201);
  const cookie = login.cookie;
  const token = cookie.slice('judo_session='.length);
  const session = await db.session.findUniqueOrThrow({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
  });
  const tournament = await ok(
    '/tournaments',
    {
      name: 'QA · Session race · ' + order,
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
      name: 'QA Session race U15',
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
      name: 'QA Session race club',
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
        firstName: 'Session QA',
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
  await ok(`/tournaments/${tournament.id}/start`, {}, cookie);
  const contest = await db.contest.findFirstOrThrow({
    where: { draw: { categoryId: category.id }, status: 'READY' },
  });
  assert.equal(contest.tatamiId, mat.id);
  const deviceId = randomUUID();
  const control = await ok(
    `/auth/tatamis/${mat.id}/control?deviceId=${deviceId}`,
    undefined,
    cookie,
  );
  assert.equal(control.control.held, false);
  const claim = {
    id: randomUUID(),
    expectedRevision: control.accessRevision,
    deviceId,
    type: 'CLAIM',
  };
  return {
    cookie,
    ownerId: owner.id,
    sessionId: session.id,
    tournamentId: tournament.id,
    matId: mat.id,
    contestId: contest.id,
    deviceId,
    claim,
  };
}

async function snapshot(context) {
  return {
    mat: await db.tatami.findUniqueOrThrow({ where: { id: context.matId } }),
    session: await db.session.findUnique({ where: { id: context.sessionId } }),
    contests: await db.contest.findMany({
      where: { draw: { category: { tournamentId: context.tournamentId } } },
      orderBy: { id: 'asc' },
    }),
    receipts: await db.accessCommand.findMany({
      where: { tournamentId: context.tournamentId },
      orderBy: { id: 'asc' },
    }),
    events: await db.matchEvent.findMany({
      where: { contest: { draw: { category: { tournamentId: context.tournamentId } } } },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: context.tournamentId },
      orderBy: { id: 'asc' },
    }),
  };
}

async function waitForRowBlock(table, blockerPids, excludedPids = []) {
  const deadline = Date.now() + 2500;
  const queryPattern = '%SELECT id FROM "' + table + '"%';
  while (Date.now() < deadline) {
    const waiting = await db.$queryRaw`
      SELECT pid, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user
        AND wait_event_type = 'Lock'
        AND query LIKE ${queryPattern}
    `;
    const blocked = waiting.find(
      (row) =>
        !excludedPids.includes(row.pid) && row.blockers.some((pid) => blockerPids.includes(pid)),
    );
    if (blocked) return blocked.pid;
    await wait(15);
  }
  assert.fail('Both HTTP operations must reach the actual PostgreSQL ' + table + ' lock queue');
}
const waitForSessionBlock = (blockerPids, excludedPids) =>
  waitForRowBlock('Session', blockerPids, excludedPids);

async function race(order) {
  const context = await fixture(order);
  const before = await snapshot(context);
  const requests = {
    claim: () => call(`/auth/tatamis/${context.matId}/control`, context.claim, context.cookie),
    logout: () => call('/auth/logout', {}, context.cookie),
  };
  const sequence = order === 'claim-first' ? ['claim', 'logout'] : ['logout', 'claim'];
  const pending = [];
  let outcome;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${context.sessionId} FOR UPDATE`;
        pending.push(requests[sequence[0]]());
        pending[0].catch(() => {});
        const firstPid = await waitForSessionBlock([pid]);
        pending.push(requests[sequence[1]]());
        pending[1].catch(() => {});
        const secondPid = await waitForSessionBlock([pid, firstPid], [firstPid]);
        assert.notEqual(firstPid, secondPid, 'two independent server transactions must wait');
        // FIFO tuple locking releases one HTTP operation first. The losing
        // operation has already passed AuthGuard and its initial holder lookup.
      },
      { timeout: 10000 },
    );
    const responses = await Promise.all(pending);
    outcome = Object.fromEntries(sequence.map((action, index) => [action, responses[index]]));
  } finally {
    // The barrier transaction has ended even when a queue assertion fails.
    // Drain HTTP work before inspecting or removing our own fixtures.
    await Promise.allSettled(pending);
  }
  const after = await snapshot(context);
  if (order === 'claim-first') {
    assert.equal(outcome.claim.status, 201, JSON.stringify(outcome.claim.body));
    assert.equal(outcome.logout.status, 409, JSON.stringify(outcome.logout.body));
    assert.equal(outcome.logout.body.message, 'ACCESS_CHANGED_RETRY');
    assert.deepEqual(
      after.session,
      before.session,
      'losing logout must not delete or edit the live session',
    );
    assert.deepEqual(after.contests, before.contests, 'losing logout must not alter any contest');
    assert.deepEqual(after.events, before.events, 'losing logout must not create match events');
    assert.equal(after.mat.controllerSessionId, context.sessionId);
    assert.equal(after.mat.controllerActorId, context.ownerId);
    assert.equal(after.mat.controllerDeviceId, context.deviceId);
    assert.equal(after.mat.controlGeneration, before.mat.controlGeneration + 1);
    assert.equal(after.mat.accessRevision, before.mat.accessRevision + 1);
    assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.ok(after.receipts.some((receipt) => receipt.id === context.claim.id));
    assert.equal(after.audits.length, before.audits.length + 1);
    assert.equal(
      after.audits.find((audit) => !before.audits.some((old) => old.id === audit.id)).action,
      'ACCESS_CLAIM',
    );
    assert.deepEqual(
      await ok(`/auth/tatamis/${context.matId}/control`, context.claim, context.cookie),
      outcome.claim.body,
    );
    assert.equal((await call('/auth/me', undefined, context.cookie)).status, 200);

    // Exercise the explicit retry with a real started match and an unresolved
    // hold: logout must pause, retain athlete reservation and keep hold evidence.
    const generation = outcome.claim.body.control.generation;
    async function sporting(type, extra = {}) {
      const row = await db.contest.findUniqueOrThrow({ where: { id: context.contestId } });
      return ok(
        `/tatamis/${context.matId}/live/${context.contestId}/command`,
        {
          id: randomUUID(),
          expectedVersion: row.revision,
          deviceId: context.deviceId,
          controlGeneration: generation,
          type,
          ...extra,
        },
        context.cookie,
      );
    }
    await sporting('START');
    await sporting('HOLD', { side: 'WHITE' });
    const running = await db.contest.findUniqueOrThrow({ where: { id: context.contestId } });
    assert.equal(running.state.status, 'RUNNING');
    assert.ok(running.state.hold);
    const retriedLogout = await call('/auth/logout', {}, context.cookie);
    assert.equal(retriedLogout.status, 201, JSON.stringify(retriedLogout.body));
    const final = await snapshot(context);
    assert.equal(final.session, null);
    assert.equal(
      final.mat.controllerSessionId,
      context.sessionId,
      'logout retains a sticky tombstone',
    );
    assert.equal(final.mat.controlGeneration, after.mat.controlGeneration + 1);
    assert.equal(final.mat.accessRevision, after.mat.accessRevision + 1);
    assert.deepEqual(
      final.receipts,
      after.receipts,
      'retry logout does not reissue or overwrite the claim receipt',
    );
    const paused = final.contests.find((contest) => contest.id === context.contestId);
    assert.equal(paused.status, 'ACTIVE', 'paused athletes keep the active reservation');
    assert.equal(paused.state.status, 'PAUSED');
    assert.equal(paused.clockAnchorMs, null);
    assert.equal(paused.clockEpoch, null);
    const pauseEvent = final.events.find(
      (event) => event.type === 'CONTROL_ACCESS_PAUSED' && event.payload.action === 'LOGOUT',
    );
    assert.ok(pauseEvent);
    assert.equal(pauseEvent.payload.clockUncertain, true);
    assert.deepEqual(paused.state.hold, pauseEvent.payload.before.hold);
    assert.deepEqual(paused.state.awards, pauseEvent.payload.before.awards);
    assert.equal(paused.state.elapsedMs, pauseEvent.payload.before.elapsedMs);
    assert.equal(paused.state.version, pauseEvent.payload.before.version + 1);
    assert.equal((await call('/auth/me', undefined, context.cookie)).status, 401);
  } else {
    assert.equal(outcome.logout.status, 201, JSON.stringify(outcome.logout.body));
    assert.equal(outcome.claim.status, 401, JSON.stringify(outcome.claim.body));
    assert.equal(outcome.claim.body.message, 'AUTH_REQUIRED');
    assert.equal(after.session, null);
    assert.deepEqual(
      after.mat,
      before.mat,
      'CLAIM checked a live session under the lock, then rolled back',
    );
    assert.deepEqual(after.contests, before.contests);
    assert.deepEqual(after.receipts, before.receipts, 'losing CLAIM cannot persist a receipt');
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(
      after.audits,
      before.audits,
      'unheld logout and losing CLAIM do not create control audit events',
    );
    assert.equal((await call('/auth/me', undefined, context.cookie)).status, 401);
    assert.equal(
      (await call(`/auth/tatamis/${context.matId}/control`, context.claim, context.cookie)).status,
      401,
    );
  }
  console.log('PASS real PostgreSQL Session barrier: ' + order);
}

async function concurrentLogout() {
  const context = await fixture('double-logout');
  await ok(`/auth/tatamis/${context.matId}/control`, context.claim, context.cookie);
  const before = await snapshot(context);
  const pending = [];
  let results;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${context.sessionId} FOR UPDATE`;
        pending.push(call('/auth/logout', {}, context.cookie));
        pending[0].catch(() => {});
        const firstPid = await waitForSessionBlock([pid]);
        pending.push(call('/auth/logout', {}, context.cookie));
        pending[1].catch(() => {});
        // With an existing holder, logout takes Tournament/Tatami before Session.
        // The second HTTP request has passed AuthGuard and is now behind the
        // first server transaction's Tournament lock, not behind the test row.
        const secondPid = await waitForRowBlock('Tournament', [firstPid]);
        assert.notEqual(firstPid, secondPid);
      },
      { timeout: 10000 },
    );
    results = await Promise.all(pending);
  } finally {
    await Promise.allSettled(pending);
  }
  for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.body));
  const after = await snapshot(context);
  assert.equal(after.session, null);
  assert.equal(after.mat.controllerSessionId, before.mat.controllerSessionId);
  assert.equal(after.mat.controllerActorId, before.mat.controllerActorId);
  assert.equal(after.mat.controllerDeviceId, before.mat.controllerDeviceId);
  assert.equal(
    after.mat.controlGeneration,
    before.mat.controlGeneration + 1,
    'both deliveries invalidate one session generation exactly once',
  );
  assert.equal(after.mat.accessRevision, before.mat.accessRevision + 1);
  assert.deepEqual(after.contests, before.contests);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(
    after.receipts,
    before.receipts,
    'duplicate logout must not overwrite a control receipt',
  );
  const addedAudits = after.audits.filter(
    (audit) => !before.audits.some((old) => old.id === audit.id),
  );
  assert.equal(addedAudits.length, 1);
  assert.equal(addedAudits[0].action, 'ACCESS_LOGOUT');
  assert.equal((await call('/auth/me', undefined, context.cookie)).status, 401);
  assert.equal(
    (await call('/auth/logout', {}, context.cookie)).status,
    401,
    'a later request is rejected by AuthGuard',
  );
  assert.deepEqual(await snapshot(context), after);
  console.log(
    'PASS real PostgreSQL Session barrier: concurrent duplicate logout is a single invalidation',
  );
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
  assert.equal(
    schema,
    configuredSchema,
    'the active PostgreSQL schema must be the configured disposable schema',
  );
  await race('claim-first');
  await race('logout-first');
  await concurrentLogout();
  console.log(
    'PASS: both Session/logout/CLAIM lock orders, initial lookup gap, atomic loser rollback, durable receipt, safe logout retry with running hold, and single invalidation for concurrent duplicate logout.',
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
