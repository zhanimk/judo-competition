import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';
import { fixtureRequest } from './test-access.mjs';
import { pdfText } from './pdf-text.mjs';

const connection = new URL(process.env.DATABASE_URL);
const schema = connection.searchParams.get('schema');
const base = process.env.TEST_API_URL;
assert.match(schema ?? '', /^qa_rehearsal_[a-f0-9]{32}$/);
assert.ok(base, 'Name correction requires the isolated rehearsal API');
const db = new PrismaClient();
const users = [],
  tournaments = [];
let cookie = '',
  tournament,
  mat,
  contest,
  entry,
  socket;

async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(base, path, data, auth);
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, data, auth = cookie) {
  const response = await call(path, data, auth);
  assert.equal(response.status, data === undefined ? 200 : 201, JSON.stringify(response.body));
  return response.body;
}
async function login(role = 'ORGANIZER') {
  const user = await createTestUser(db, role);
  users.push(user.id);
  const response = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(response.status, 201);
  return { user, cookie: response.cookie };
}
async function snapshot() {
  return {
    contests: await db.contest.findMany({
      where: { draw: { category: { tournamentId: tournament } } },
      orderBy: { id: 'asc' },
    }),
    draws: await db.drawRecord.findMany({
      where: { category: { tournamentId: tournament } },
      orderBy: { id: 'asc' },
    }),
    mats: await db.tatami.findMany({ where: { tournamentId: tournament }, orderBy: { id: 'asc' } }),
    matchEvents: await db.matchEvent.findMany({
      where: { contest: { draw: { category: { tournamentId: tournament } } } },
      orderBy: { id: 'asc' },
    }),
  };
}
async function payload(firstName, lastName) {
  return {
    id: randomUUID(),
    expectedRevision: (await ok(`/tournaments/${tournament}/clubs`)).revision,
    firstName,
    lastName,
    reason: 'QA: исправление опечатки в имени',
  };
}
const endpoint = () => `/tournaments/${tournament}/roster/entries/${entry.id}/name`;
async function correction(firstName, lastName) {
  const command = await payload(firstName, lastName),
    before = await snapshot();
  const response = await ok(endpoint(), command);
  assert.deepEqual(
    await snapshot(),
    before,
    'Name-only correction must not modify bouts, clocks, leases, events or draws',
  );
  assert.equal(response.revision, command.expectedRevision + 1);
  assert.equal(response.entry.id, entry.id);
  assert.equal(response.entry.athleteId, entry.athleteId);
  assert.deepEqual(response.invalidatedCategoryIds, []);
  for (const key of [
    'categoryId',
    'clubId',
    'club',
    'birthYear',
    'gender',
    'archivedAt',
    'createdAt',
  ])
    assert.deepEqual(response.entry[key], entry[key], `Name correction changed ${key}`);
  entry = response.entry;
  return { command, response };
}
async function sport(type, extra = {}) {
  const row = await db.contest.findUniqueOrThrow({ where: { id: contest } });
  return ok(`/tatamis/${mat}/live/${contest}/command`, {
    id: randomUUID(),
    expectedVersion: row.revision,
    type,
    ...extra,
  });
}
async function pdf(kind, lang = 'ru') {
  const response = await fixtureRequest(
    base,
    `/tournaments/${tournament}/protocol.pdf?kind=${kind}&lang=${lang}`,
    undefined,
    cookie,
  );
  assert.equal(response.status, 200);
  return pdfText(Buffer.from(await response.arrayBuffer()));
}
async function reject(command, status, message, auth = cookie) {
  const before = await snapshot();
  const revision = (await db.tournament.findUniqueOrThrow({ where: { id: tournament } }))
    .rosterRevision;
  const audits = await db.auditEvent.count({ where: { tournamentId: tournament } });
  const response = await call(endpoint(), command, auth);
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (message) assert.equal(response.body.message, message);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).rosterRevision,
    revision,
  );
  assert.equal(await db.auditEvent.count({ where: { tournamentId: tournament } }), audits);
}
try {
  const [{ schema: actual }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(actual, schema);
  const owner = await login(),
    foreign = await login();
  cookie = owner.cookie;
  tournament = (
    await ok('/tournaments', {
      name: 'NAME CORRECTION QA',
      city: 'Алматы',
      venue: 'Изолированный QA',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    })
  ).id;
  tournaments.push(tournament);
  const category = await ok(`/tournaments/${tournament}/categories`, {
    name: 'U15 −50',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
    format: 'ROUND_ROBIN',
  });
  for (let i = 0; i < 2; i++)
    await ok(`/tournaments/${tournament}/categories/${category.id}/entries`, {
      firstName: 'ИмяДо',
      lastName: 'ФамилияДо' + i,
      birthYear: 2012,
      club: 'Клуб QA' + i,
    });
  const entries = (await ok(`/tournaments/${tournament}`)).categories[0].entries;
  entry = entries[0];
  await reject(await payload('Исправленное', 'ДоСетки'), 409, 'NAME_CORRECTION_NOT_ALLOWED');
  const preview = await ok(`/categories/${category.id}/draw/preview`, {});
  await reject(await payload('Исправленное', 'Preview'), 409, 'NAME_CORRECTION_NOT_ALLOWED');
  const draw = await ok(`/categories/${category.id}/draw/confirm`, { version: preview.version });
  contest = draw.contests[0].id;
  const beforeStarted = await correction('Әли', 'СохранённыйДоСтарта');
  await ok(`/tournaments/${tournament}/publish`, {});
  await ok(`/categories/${category.id}/draw/publication`, { published: true, expectedRevision: 0 });
  await ok(`/tournaments/${tournament}/start`, {});
  mat = (await ok(`/tournaments/${tournament}/tatamis`))[0].id;

  // A previous tournament retains its independent spelling for the same Athlete ID.
  const historical = await db.tournament.create({
    data: {
      name: 'NAME HISTORICAL QA',
      city: 'QA',
      venue: 'QA',
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      tatamiCount: 1,
      status: 'FINISHED',
      ownerId: owner.user.id,
    },
  });
  tournaments.push(historical.id);
  const historyCategory = await db.category.create({
    data: {
      tournamentId: historical.id,
      name: 'Historical U15',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 50000,
      durationSeconds: 180,
    },
  });
  const historyEntry = await db.entry.create({
    data: {
      athleteId: entry.athleteId,
      categoryId: historyCategory.id,
      firstName: 'ИсторическоеИмя',
      lastName: 'ИсторическаяФамилия',
      birthYear: entry.birthYear,
      club: 'ИсторическийКлуб',
    },
  });
  const inviteToken = randomBytes(32).toString('hex');
  await ok(`/auth/tatamis/${mat}/invitations`, {
    label: 'Name judge QA',
    hours: 1,
    token: inviteToken,
  });
  const judge = await call(
    '/auth/invitations/accept',
    { token: inviteToken, name: 'QA judge' },
    '',
  );
  assert.equal(judge.status, 201);
  users.push((await ok('/auth/me', undefined, judge.cookie)).id);
  await reject(await payload('Чужое', 'Имя'), 403, undefined, foreign.cookie);
  await reject(await payload('Судья', 'Имя'), 403, undefined, judge.cookie);
  await reject(await payload('Гость', 'Имя'), 401, undefined, '');
  await reject({ ...(await payload('Оценки', 'Нельзя')), categoryId: category.id }, 400);
  await reject(await payload('   ', 'Пустое'), 400);
  await reject(await payload('А'.repeat(81), 'Длинное'), 400);
  await reject({ ...(await payload('Без', 'Причины')), reason: 'a' }, 400);

  // Observe the actual notification independently of HTTP reads.
  const liveURL = new URL(base.replace(/^http/, 'ws'));
  const notices = [];
  socket = io(new URL(base).origin, {
    path: '/api/v1/live',
    addTrailingSlash: false,
    transports: ['websocket'],
    auth: { tournamentId: tournament },
    extraHeaders: { Origin: 'http://127.0.0.1:4318', Cookie: cookie },
  });
  socket.on('notice', (notice) => notices.push(notice));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await sport('START');
  await sport('AWARD', { side: 'WHITE', kind: 'YUKO' });
  await sport('STOP');
  const opened = await sport('OFFLINE_OPEN', { sessionId: randomUUID() });
  const reserved = await db.contest.findUniqueOrThrow({ where: { id: contest } });
  await sport('OFFLINE_SYNC', {
    sessionId: reserved.offlineSessionId,
    events: [{ id: randomUUID(), expectedVersion: reserved.state.version, type: 'START' }],
  });
  const offline = await db.contest.findUniqueOrThrow({ where: { id: contest } });
  assert.ok(offline.offlineSessionId);
  assert.equal(offline.state.status, 'RUNNING');
  const oldPDF = await pdf('DRAW');
  assert.ok(oldPDF.includes('СохранённыйДоСтарта'));
  const renamed = await correction('  Әлихан  ', '  Новая\u00a0  Фамилия  ');
  assert.equal(entry.firstName, 'Әлихан');
  assert.equal(entry.lastName, 'Новая Фамилия');
  const deadline = Date.now() + 2000;
  while (!notices.some((n) => n.kind === 'roster') && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(notices.some((n) => n.kind === 'roster' && n.tournamentId === tournament));
  const live = await ok(`/tatamis/${mat}/live`);
  const person = [live.currentMatch.white, live.currentMatch.blue].find((p) => p.id === entry.id);
  assert.equal(person.lastName, 'Новая Фамилия');
  assert.deepEqual(live.currentMatch.state, { ...offline.state, receipts: {} });
  const publicly = await ok(`/public/tournaments/${tournament}`, undefined, '');
  assert.equal(
    publicly.categories[0].entries.find((p) => p.id === entry.id).lastName,
    'Новая Фамилия',
  );
  const publicPerson = [
    publicly.tatamis[0].currentMatch.white,
    publicly.tatamis[0].currentMatch.blue,
  ].find((p) => p.id === entry.id);
  assert.equal(publicPerson.firstName, 'Әлихан');
  for (const kind of ['DRAW', 'PARTICIPANTS'])
    for (const lang of ['ru', 'kk']) {
      const text = await pdf(kind, lang);
      assert.ok(text.includes('Новая Фамилия'), `${kind}/${lang} must contain the current name`);
      assert.ok(
        !text.includes('СохранённыйДоСтарта'),
        `${kind}/${lang} must not reuse an old cached name`,
      );
    }
  assert.ok(
    oldPDF.includes('СохранённыйДоСтарта'),
    'The previously downloaded PDF is an immutable historical artifact',
  );
  assert.deepEqual(
    await db.entry.findUniqueOrThrow({ where: { id: historyEntry.id } }),
    historyEntry,
  );
  assert.deepEqual(
    await ok(endpoint(), beforeStarted.command),
    beforeStarted.response,
    'An old exact receipt is still returned after start',
  );
  await reject({ ...renamed.command, lastName: 'Different retry' }, 409, 'COMMAND_ID_REUSED');
  await reject(
    { ...(await payload('Stale', 'Attempt')), expectedRevision: renamed.command.expectedRevision },
    409,
    'VERSION_CONFLICT',
  );
  await reject(await payload('Әлихан', 'Новая Фамилия'), 409, 'NAME_UNCHANGED');

  // Leave the offline reservation with the original identity and grant; names did not invalidate it.
  await sport('OFFLINE_SYNC', {
    sessionId: offline.offlineSessionId,
    events: [{ id: randomUUID(), expectedVersion: offline.state.version, type: 'STOP' }],
  });
  await sport('OFFLINE_RELEASE', { sessionId: offline.offlineSessionId, events: [] });
  assert.equal(opened.state.awards.length, 1);
  await sport('AWARD', {
    side: offline.whiteEntryId === entry.id ? 'WHITE' : 'BLUE',
    kind: 'IPPON',
  });
  await sport('CONFIRM');
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'FINISHED',
  );
  const final = await correction('Әлихан', 'ИтоговаяФамилия');
  const recent = await ok(`/tatamis/${mat}/live`);
  assert.equal(recent.lastResult.winner.id, entry.id);
  assert.equal(recent.lastResult.winner.lastName, 'ИтоговаяФамилия');
  const results = await ok(`/public/tournaments/${tournament}`, undefined, '');
  assert.equal(results.categories[0].draw.contests[0].winnerEntryId, entry.id);
  assert.equal(
    results.categories[0].entries.find((p) => p.id === entry.id).lastName,
    'ИтоговаяФамилия',
  );
  for (const kind of ['DRAW', 'PARTICIPANTS', 'TEAMS'])
    for (const lang of ['ru', 'kk']) {
      const text = await pdf(kind, lang);
      if (kind !== 'TEAMS')
        assert.ok(text.includes('ИтоговаяФамилия'), `${kind}/${lang} has the final name`);
    }
  assert.deepEqual(
    await ok(endpoint(), renamed.command),
    renamed.response,
    'An old reply cannot overwrite the current final spelling',
  );
  assert.equal(
    (await db.entry.findUniqueOrThrow({ where: { id: entry.id } })).lastName,
    final.response.entry.lastName,
  );
  const audits = await db.auditEvent.findMany({
    where: { tournamentId: tournament, action: 'ENTRY_NAME_CORRECTED' },
  });
  assert.equal(audits.length, 3);
  assert.ok(
    audits.every((a) => a.entityId === entry.id && a.actorId === owner.user.id && a.payload.reason),
  );
  await ok('/auth/logout', {});
  await reject(final.command, 401);
  console.log(
    'PASS roster name: locked draft, running/offline, finalized names → live/public/draw/PDF; stable sporting state, historical Entry, receipts, permissions and live Session',
  );
} finally {
  socket?.disconnect();
  // Delete only this guarded suite's generated fixtures.
  for (const id of tournaments) {
    await db.matchEvent.deleteMany({
      where: { contest: { draw: { category: { tournamentId: id } } } },
    });
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: id } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: id } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: id } } });
    await db.category.deleteMany({ where: { tournamentId: id } });
    await db.invitation.deleteMany({ where: { tatami: { tournamentId: id } } });
    await db.tatami.deleteMany({ where: { tournamentId: id } });
    await db.auditEvent.deleteMany({ where: { tournamentId: id } });
    await db.tournament.delete({ where: { id } });
  }
  await db.session.deleteMany({
    where: { OR: [{ userId: { in: users } }, { tatamiId: mat ?? '' }] },
  });
  await db.athlete.deleteMany({ where: { ownerId: { in: users }, entries: { none: {} } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
