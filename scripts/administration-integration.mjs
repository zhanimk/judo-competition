import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';

const db = new PrismaClient(),
  base = process.env.TEST_API_URL;
const userIds = [],
  tournamentIds = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(path, data, cookie = '') {
  const response = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
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
async function login(user) {
  const response = await call('/auth/login', { email: user.email, password: user.password });
  assert.equal(response.status, 201);
  return response.cookie;
}
async function actor(role = 'ORGANIZER') {
  const user = await createTestUser(db, role);
  userIds.push(user.id);
  return { user, cookie: await login(user) };
}
const createDto = (name) => ({
  id: randomUUID(),
  name: 'QA · Administration · ' + name,
  city: 'QA',
  venue: 'Isolated rehearsal',
  startDate: '2026-10-10',
  endDate: '2026-10-10',
  tatamiCount: 1,
});
const categoryDto = (revision, name = 'QA U15 -30') => ({
  id: randomUUID(),
  expectedRevision: revision,
  name,
  gender: 'MALE',
  format: 'ROUND_ROBIN',
  birthYearFrom: 2012,
  birthYearTo: 2013,
  maxWeightGrams: 30000,
  durationSeconds: 180,
});
async function fixture(name) {
  const { user, cookie } = await actor(),
    dto = createDto(name),
    created = await ok('/tournaments', dto, cookie);
  tournamentIds.push(created.id);
  return { user, cookie, tournamentId: created.id, dto };
}
async function snapshot(c) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({ where: { id: c.tournamentId } }),
    categories: await db.category.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    mats: await db.tatami.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    contests: await db.contest.findMany({
      where: { draw: { category: { tournamentId: c.tournamentId } } },
      orderBy: { id: 'asc' },
    }),
    draws: await db.drawRecord.findMany({
      where: { category: { tournamentId: c.tournamentId } },
      orderBy: { id: 'asc' },
    }),
    receipts: await db.tournamentCommand.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    drawReceipts: await db.drawCommand.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
    }),
    outbox: await db.liveOutbox.findMany({
      where: { tournamentId: c.tournamentId },
      orderBy: { id: 'asc' },
      select: { id: true, tournamentId: true, tatamiId: true, kind: true, createdAt: true },
    }),
  };
}
async function waitForSessionBlock(blockerPids, excludedPids = []) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const waiting =
      await db.$queryRaw`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock'
        AND query LIKE '%SELECT id FROM "Session"%'`;
    const row = waiting.find(
      (row) =>
        !excludedPids.includes(row.pid) && row.blockers.some((pid) => blockerPids.includes(pid)),
    );
    if (row) return row.pid;
    await wait(15);
  }
  assert.fail('the HTTP operation must reach the actual PostgreSQL Session lock queue');
}

async function operations() {
  const owner = await actor(),
    dto = createDto('lost response'),
    [first, retry] = await Promise.all([
      call('/tournaments', dto, owner.cookie),
      call('/tournaments', dto, owner.cookie),
    ]);
  assert.equal(first.status, 201);
  assert.deepEqual(retry, first);
  assert.notEqual(first.body.id, dto.id);
  const c = { ...owner, tournamentId: first.body.id };
  tournamentIds.push(c.tournamentId);
  assert.equal(first.body.administrationRevision, 0);
  const created = await snapshot(c);
  assert.equal(created.receipts.length, 1);
  assert.equal(created.audits.length, 1);
  assert.equal(created.outbox.length, 1);
  assert.deepEqual(await ok('/tournaments', dto, c.cookie), first.body);
  assert.deepEqual(await snapshot(c), created);
  const other = await actor('SUPER_ADMIN');
  const stolen = await call('/tournaments', dto, other.cookie);
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await snapshot(c), created);
  const changed = await call('/tournaments', { ...dto, venue: 'Another arena' }, c.cookie);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await snapshot(c), created);

  const category = categoryDto(0),
    pair = await Promise.all([
      call(`/tournaments/${c.tournamentId}/categories`, category, c.cookie),
      call(`/tournaments/${c.tournamentId}/categories`, category, c.cookie),
    ]);
  assert.equal(pair[0].status, 201);
  assert.deepEqual(pair[1], pair[0]);
  assert.equal(pair[0].body.administrationRevision, 1);
  const categoryAfter = await snapshot(c);
  assert.equal(categoryAfter.categories.length, 1);
  const stale = await call(
    `/tournaments/${c.tournamentId}/categories`,
    categoryDto(0, 'QA stale category'),
    c.cookie,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.message, 'ADMINISTRATION_STALE');
  assert.deepEqual(await snapshot(c), categoryAfter);
  const foreignType = await call(
    `/tournaments/${c.tournamentId}/publish`,
    { id: category.id, expectedRevision: 1 },
    c.cookie,
  );
  assert.equal(foreignType.status, 409);
  assert.equal(foreignType.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await snapshot(c), categoryAfter);
  for (let i = 1; i <= 2; i++)
    await ok(
      `/tournaments/${c.tournamentId}/categories/${pair[0].body.id}/entries`,
      {
        firstName: 'Administration QA',
        id: randomUUID(),
        expectedRosterRevision: i - 1,
        lastName: 'Athlete-' + i,
        birthYear: 2012,
        club: 'QA Club',
      },
      c.cookie,
    );
  const drawPath = `/categories/${pair[0].body.id}/draw`,
    previewDto = { id: randomUUID(), expectedVersion: 0 },
    beforePreview = await snapshot(c);
  const missingDrawId = await call(drawPath + '/preview', { expectedVersion: 0 }, c.cookie);
  assert.equal(missingDrawId.status, 400);
  assert.deepEqual(await snapshot(c), beforePreview);
  const previewResponses = await Promise.all([
    call(drawPath + '/preview', previewDto, c.cookie),
    call(drawPath + '/preview', previewDto, c.cookie),
  ]);
  assert.equal(previewResponses[0].status, 201);
  assert.deepEqual(previewResponses[1], previewResponses[0]);
  const preview = previewResponses[0].body,
    afterPreview = await snapshot(c);
  assert.equal(
    afterPreview.drawReceipts.filter((command) => command.type === 'DRAW_PREVIEW').length,
    1,
  );
  assert.deepEqual(await ok(drawPath + '/preview', previewDto, c.cookie), preview);
  assert.deepEqual(
    await snapshot(c),
    afterPreview,
    'lost preview response preserves the original random seed and version',
  );
  const confirmDto = { id: randomUUID(), version: preview.version },
    confirmResponses = await Promise.all([
      call(drawPath + '/confirm', confirmDto, c.cookie),
      call(drawPath + '/confirm', confirmDto, c.cookie),
    ]);
  assert.equal(confirmResponses[0].status, 201);
  assert.deepEqual(confirmResponses[1], confirmResponses[0]);
  const confirmed = confirmResponses[0].body,
    afterConfirm = await snapshot(c);
  assert.equal(afterConfirm.contests.length, 1);
  assert.equal(
    afterConfirm.drawReceipts.filter((command) => command.type === 'DRAW_CONFIRM').length,
    1,
  );
  assert.deepEqual(await ok(drawPath + '/confirm', confirmDto, c.cookie), confirmed);
  assert.deepEqual(await ok(drawPath + '/preview', previewDto, c.cookie), preview);
  assert.deepEqual(
    await snapshot(c),
    afterConfirm,
    'historical preview must not regenerate the confirmed draw',
  );

  const publicationDto = { id: randomUUID(), expectedRevision: 0, published: true },
    publishedResponses = await Promise.all([
      call(drawPath + '/publication', publicationDto, c.cookie),
      call(drawPath + '/publication', publicationDto, c.cookie),
    ]);
  assert.equal(publishedResponses[0].status, 201);
  assert.deepEqual(publishedResponses[1], publishedResponses[0]);
  assert.equal(publishedResponses[0].body.publicationRevision, 1);
  await ok(
    drawPath + '/publication',
    { id: randomUUID(), expectedRevision: 1, published: false },
    c.cookie,
  );
  const hidden = await snapshot(c);
  assert.equal(hidden.draws[0].publishedAt, null);
  assert.equal(hidden.draws[0].publicationRevision, 2);
  assert.deepEqual(
    await ok(drawPath + '/publication', publicationDto, c.cookie),
    publishedResponses[0].body,
  );
  assert.deepEqual(
    await snapshot(c),
    hidden,
    'acknowledging an old published receipt cannot republish a later hidden draw',
  );
  const staleVisibility = await call(
    drawPath + '/publication',
    {
      id: randomUUID(),
      expectedRevision: 0,
      published: false,
    },
    c.cookie,
  );
  assert.equal(staleVisibility.status, 409);
  assert.equal(staleVisibility.body.message, 'PUBLICATION_STALE');
  assert.deepEqual(await snapshot(c), hidden);
  const rosterReceipt = await db.auditEvent.findFirstOrThrow({
    where: { tournamentId: c.tournamentId, action: 'ENTRY_ADDED' },
  });
  assert.ok(rosterReceipt);
  const drawReceipt = await db.drawCommand.findFirstOrThrow({
    where: { tournamentId: c.tournamentId, type: 'DRAW_CONFIRM' },
  });
  const collisionBefore = await snapshot(c);
  const collision = await call(
    `/tournaments/${c.tournamentId}/publish`,
    { id: drawReceipt.id, expectedRevision: 1 },
    c.cookie,
  );
  assert.equal(collision.status, 409);
  assert.equal(collision.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await snapshot(c), collisionBefore);

  let revision = 1;
  for (const operation of ['schedule', 'start', 'publish']) {
    const command = { id: randomUUID(), expectedRevision: revision },
      path = `/tournaments/${c.tournamentId}/${operation}`;
    const result = await ok(path, command, c.cookie);
    revision++;
    assert.equal(result.administrationRevision, revision);
    const after = await snapshot(c);
    assert.deepEqual(await ok(path, command, c.cookie), result);
    assert.deepEqual(await snapshot(c), after);
    const wrong = await call(path, { ...command, id: randomUUID() }, c.cookie);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.message, 'ADMINISTRATION_STALE');
    assert.deepEqual(await snapshot(c), after);
  }
  const later = await snapshot(c);
  assert.deepEqual(await ok(drawPath + '/confirm', confirmDto, c.cookie), confirmed);
  assert.deepEqual(await ok(drawPath + '/preview', previewDto, c.cookie), preview);
  assert.deepEqual(await ok('/tournaments', dto, c.cookie), first.body);
  assert.deepEqual(
    await ok(`/tournaments/${c.tournamentId}/categories`, category, c.cookie),
    pair[0].body,
  );
  assert.deepEqual(
    await snapshot(c),
    later,
    'historical receipts do not change current tournament state',
  );
  assert.equal(later.audits.filter((event) => event.action === 'TOURNAMENT_STARTED').length, 1);
  assert.equal(later.audits.filter((event) => event.action === 'TOURNAMENT_PUBLISHED').length, 1);
  console.log(
    'PASS real PostgreSQL CREATE/category/SCHEDULE/START/PUBLISH and draw PREVIEW/CONFIRM/PUBLICATION lost-response receipts, actors, namespaces, stale versions and immutable historical responses',
  );
}

async function logoutRace(order) {
  const c = await fixture('Session ' + order);
  const session = await db.session.findUniqueOrThrow({
    where: {
      tokenHash: createHash('sha256').update(c.cookie.slice('judo_session='.length)).digest('hex'),
    },
  });
  const dto = categoryDto(0),
    before = await snapshot(c),
    requests = {
      category: () => call(`/tournaments/${c.tournamentId}/categories`, dto, c.cookie),
      logout: () => call('/auth/logout', {}, c.cookie),
    },
    sequence = order === 'write-first' ? ['category', 'logout'] : ['logout', 'category'],
    pending = [];
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${session.id} FOR UPDATE`;
        pending.push(requests[sequence[0]]());
        pending[0].catch(() => {});
        const firstPid = await waitForSessionBlock([pid]);
        pending.push(requests[sequence[1]]());
        pending[1].catch(() => {});
        await waitForSessionBlock([pid, firstPid], [firstPid]);
      },
      { timeout: 10000 },
    );
    const results = await Promise.all(pending),
      byName = Object.fromEntries(sequence.map((name, i) => [name, results[i]]));
    assert.equal(byName.logout.status, 201);
    assert.equal(await db.session.findUnique({ where: { id: session.id } }), null);
    if (order === 'logout-first') {
      assert.equal(byName.category.status, 401);
      assert.equal(byName.category.body.message, 'AUTH_REQUIRED');
      assert.deepEqual(await snapshot(c), before);
    } else {
      assert.equal(byName.category.status, 201);
      const after = await snapshot(c);
      assert.equal(after.categories.length, 1);
      assert.equal(after.receipts.length, before.receipts.length + 1);
      c.cookie = await login(c.user);
      assert.deepEqual(
        await ok(`/tournaments/${c.tournamentId}/categories`, dto, c.cookie),
        byName.category.body,
      );
      assert.deepEqual(await snapshot(c), after);
    }
  } finally {
    await Promise.allSettled(pending);
  }
  console.log('PASS real PostgreSQL administrative Session barrier: ' + order);
}

async function createExpiry() {
  const owner = await actor(),
    dto = createDto('expiry rollback');
  const session = await db.session.findUniqueOrThrow({
    where: {
      tokenHash: createHash('sha256')
        .update(owner.cookie.slice('judo_session='.length))
        .digest('hex'),
    },
  });
  let pending;
  try {
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${session.id} FOR UPDATE`;
        pending = call('/tournaments', dto, owner.cookie);
        pending.catch(() => {});
        await waitForSessionBlock([pid]);
        await tx.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
      },
      { timeout: 10000 },
    );
    const result = await pending;
    assert.equal(result.status, 401);
    assert.equal(result.body.message, 'AUTH_REQUIRED');
    assert.equal(await db.tournament.count({ where: { ownerId: owner.user.id } }), 0);
    assert.equal(await db.tournamentCommand.findUnique({ where: { id: dto.id } }), null);
  } finally {
    if (pending) await Promise.allSettled([pending]);
  }
  console.log(
    'PASS real PostgreSQL global CREATE Session expiry: no tournament, receipt, audit or outbox written',
  );
}

try {
  assert.ok(base, 'TEST_API_URL for a disposable rehearsal API is required');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(schema ?? '', /^qa_[a-z0-9_]+$/);
  const [{ actual }] = await db.$queryRaw`SELECT current_schema()::text AS actual`;
  assert.equal(actual, schema);
  await operations();
  await logoutRace('write-first');
  await logoutRace('logout-first');
  await createExpiry();
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
