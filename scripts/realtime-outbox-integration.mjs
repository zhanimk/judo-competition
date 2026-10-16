import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';
import { fixtureRequest } from './test-access.mjs';
import { liveSocket, connectLive } from './test-live.mjs';
import { enqueueLive } from '../apps/api/dist/modules/matches/live-outbox.js';

// Never connect this destructive fixture cleanup to the working tournament schema.
const target = new URL(process.env.DATABASE_URL);
assert.match(target.searchParams.get('schema') ?? 'public', /^qa_rehearsal_[a-f0-9]{32}$/);
const db = new PrismaClient(),
  base = process.env.TEST_API_URL;
assert.ok(base && new URL(base).pathname === '/api/v1');
const sockets = new Set();
const tournamentIds = [];
let owner, foreign, cookie;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test, name, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await test()) return;
    await pause(25);
  }
  throw new Error(`LIVE_ASSERTION_TIMEOUT: ${name}`);
}
async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(base, path, data, auth);
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(user) {
  const response = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(response.status, 201);
  assert.ok(response.cookie);
  return response.cookie;
}
async function stream(tournamentId, options) {
  const socket = liveSocket(base, tournamentId, options);
  sockets.add(socket);
  const notices = [];
  socket.on('notice', (notice) => notices.push(notice));
  await connectLive(socket);
  await waitFor(
    () => notices.some((e) => e.kind === 'connected' || e.kind === 'resync'),
    'stream boundary',
  );
  return { socket, notices };
}
async function writeNotice(tournamentId, kind, venue) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
    if (venue !== undefined)
      await tx.tournament.update({ where: { id: tournamentId }, data: { venue } });
    await enqueueLive(tx, { tournamentId, kind });
  });
  return db.liveOutbox.findFirstOrThrow({ where: { tournamentId }, orderBy: { id: 'desc' } });
}
try {
  const schema = await db.$queryRaw`SELECT current_schema() AS schema`;
  assert.equal(schema[0].schema, target.searchParams.get('schema'));
  owner = await createTestUser(db);
  foreign = await createTestUser(db);
  cookie = await login(owner);
  const foreignCookie = await login(foreign);
  const created = await call('/tournaments', {
    name: `Outbox QA ${randomUUID()}`,
    city: 'Алматы',
    venue: 'Private synthetic venue',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 1,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  tournamentIds.push(id);
  for (const options of [{}, { cookie: foreignCookie }, { cookie, cursor: '-1' }]) {
    const denied = liveSocket(base, id, options);
    sockets.add(denied);
    await assert.rejects(connectLive(denied));
    denied.disconnect();
  }
  const wrongOrigin = liveSocket(base, id, { cookie, origin: 'https://attacker.invalid' });
  sockets.add(wrongOrigin);
  await assert.rejects(connectLive(wrongOrigin));
  wrongOrigin.disconnect();
  const privateStream = await stream(id, { cookie });
  const baseline = await db.tournament.findUniqueOrThrow({ where: { id } });
  const before = await db.liveOutbox.count({ where: { tournamentId: id } });
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
      await tx.tournament.update({ where: { id }, data: { venue: 'Must roll back' } });
      await enqueueLive(tx, { tournamentId: id, kind: 'roster' });
      throw new Error('synthetic transaction rollback');
    }),
    /synthetic transaction rollback/,
  );
  assert.equal(await db.liveOutbox.count({ where: { tournamentId: id } }), before);
  assert.equal((await db.tournament.findUniqueOrThrow({ where: { id } })).venue, baseline.venue);
  const committed = await writeNotice(id, 'roster', 'Committed private synthetic venue');
  await waitFor(
    () => privateStream.notices.some((e) => e.cursor === committed.id.toString()),
    'committed notification',
  );
  await waitFor(
    async () =>
      !!(await db.liveOutbox.findUniqueOrThrow({ where: { id: committed.id } })).publishedAt,
    'publication mark',
  );
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id } })).venue,
    'Committed private synthetic venue',
  );
  const lastCursor = committed.id.toString();
  privateStream.socket.disconnect();
  assert.equal((await call(`/tournaments/${id}/publish`, {})).status, 201);
  const publication = await db.liveOutbox.findFirstOrThrow({
    where: { tournamentId: id, id: { gt: committed.id } },
    orderBy: { id: 'asc' },
  });
  assert.ok(publication.id > committed.id, 'actual API publication has a durable outbox row');
  const disconnected = [await writeNotice(id, 'access'), await writeNotice(id, 'protocol')];
  const replay = await stream(id, { cursor: lastCursor });
  const expected = (
    await db.liveOutbox.findMany({
      where: { tournamentId: id, id: { gt: committed.id, lte: disconnected.at(-1).id } },
      orderBy: { id: 'asc' },
    })
  ).map((e) => e.id.toString());
  const received = [
    ...new Set(
      replay.notices.filter((e) => !['connected', 'resync'].includes(e.kind)).map((e) => e.cursor),
    ),
  ];
  assert.deepEqual(received.slice(0, expected.length), expected);
  const allowedFields = new Set(['kind', 'tournamentId', 'tatamiId', 'cursor']);
  for (const event of replay.notices) {
    assert.equal(event.tournamentId, id);
    assert.ok(
      Object.keys(event).every((key) => allowedFields.has(key)),
      'LIVE contains invalidation metadata only',
    );
    assert.ok(!JSON.stringify(event).includes('Committed private synthetic'));
  }
  replay.socket.emit('mutate', { type: 'START' });
  await waitFor(() => !replay.socket.connected, 'read-only socket enforcement');
  const restored = await stream(id, { cursor: '9223372036854775807' });
  assert.equal(restored.notices[0].kind, 'resync');
  assert.equal(restored.notices[0].cursor, disconnected.at(-1).id.toString());
  restored.socket.disconnect();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
    for (let i = 0; i < 101; i++) await enqueueLive(tx, { tournamentId: id, kind: 'queue' });
  });
  const gap = await stream(id, { cursor: disconnected.at(-1).id.toString() });
  assert.equal(gap.notices[0].kind, 'resync');
  assert.equal(
    gap.notices[0].cursor,
    (
      await db.liveOutbox.findFirstOrThrow({ where: { tournamentId: id }, orderBy: { id: 'desc' } })
    ).id.toString(),
  );
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.ok(['redis', 'local'].includes(readyBody.realtime));
  assert.equal(readyBody.status, 'ok');
  console.log(
    'PASS real PostgreSQL/Socket.IO: private/public origin and Session admission, transactional outbox commit/rollback, publication persistence, decimal cursor replay, metadata privacy, read-only stream, bounded gap and restored-backup resync, readiness.',
  );
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const id of tournamentIds) {
    await db.auditEvent.deleteMany({ where: { tournamentId: id } });
    await db.tatami.deleteMany({ where: { tournamentId: id } });
    await db.tournament.delete({ where: { id } });
  }
  for (const user of [owner, foreign]) if (user) await db.user.delete({ where: { id: user.id } });
  await db.$disconnect();
}
