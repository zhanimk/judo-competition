import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';

// This suite deliberately alters clocks and corrupts one synthetic participant pair.
// Those actions are restricted to the runner's random, disposable PostgreSQL schema.
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') ?? '';
if (!/^qa_rehearsal_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_API_URL)
  throw new Error('ATHLETE_IDENTITY_REQUIRES_ISOLATED_REHEARSAL');
const db = new PrismaClient();
const base = process.env.TEST_API_URL;
let cookie = '';
async function call(path, data, auth = cookie) {
  const response = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, data, auth = cookie) {
  const result = await call(path, data, auth);
  assert.equal(
    result.status,
    data === undefined ? 200 : 201,
    `${path}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
}
async function login(role = 'ORGANIZER') {
  const user = await createTestUser(db, role);
  const result = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(result.status, 201);
  return { ...user, cookie: result.cookie };
}
const fields = (categoryId, lastName, extra = {}) => ({
  categoryId,
  firstName: 'Әлихан',
  lastName,
  birthYear: 2012,
  gender: 'MALE',
  ...extra,
});
const revision = async (id) => (await ok(`/tournaments/${id}/clubs`)).revision;
const entryPath = (id, entryId, action) => `/tournaments/${id}/roster/entries/${entryId}/${action}`;
async function setup(label, athletes = []) {
  const tournament = await ok('/tournaments', {
    name: 'Identity isolated QA — ' + label,
    city: 'Алматы',
    venue: 'Удаляемый стенд',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 1,
  });
  const category = await ok(`/tournaments/${tournament.id}/categories`, {
    name: label + ' U15 −30 кг',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 30000,
    durationSeconds: 180,
    format: 'ROUND_ROBIN',
  });
  const club = (
    await ok(`/tournaments/${tournament.id}/clubs`, {
      id: randomUUID(),
      expectedRevision: 0,
      name: 'Клуб ' + label,
    })
  ).club;
  const context = { id: tournament.id, category, club };
  if (athletes.length)
    context.entries = (
      await add(
        context,
        athletes.map((athlete, index) =>
          fields(
            category.id,
            athlete.lastName ?? label + '-' + index,
            athlete.athleteId ? { athleteId: athlete.athleteId } : {},
          ),
        ),
      )
    ).entries;
  return context;
}
async function add(context, entries, extra = {}) {
  return ok(`/tournaments/${context.id}/roster`, {
    id: randomUUID(),
    expectedRevision: await revision(context.id),
    clubId: context.club.id,
    entries,
    ...extra,
  });
}
async function mutate(context, entry, action, data = {}) {
  const payload = {
    id: randomUUID(),
    expectedRevision: await revision(context.id),
    reason: 'Проверка сохранности идентичности',
    ...data,
  };
  return { payload, receipt: await ok(entryPath(context.id, entry.id, action), payload) };
}
async function snapshot(id) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({ where: { id } }),
    entries: await db.entry.findMany({
      where: { category: { tournamentId: id } },
      orderBy: { id: 'asc' },
    }),
    identities: await db.athlete.findMany({ orderBy: { id: 'asc' } }),
    draws: await db.drawRecord.findMany({
      where: { category: { tournamentId: id } },
      orderBy: { id: 'asc' },
    }),
    receipts: await db.rosterCommand.findMany({
      where: { tournamentId: id },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({ where: { tournamentId: id }, orderBy: { id: 'asc' } }),
  };
}
function assertRowError(result, code) {
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.ok(
    result.body.rows?.some((row) => row.errors.includes(code)),
    JSON.stringify(result.body),
  );
}
function assertPreviewError(result, code) {
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.canSave, false, JSON.stringify(result.body));
  assert.ok(
    result.body.rows?.some((row) => row.errors.includes(code)),
    JSON.stringify(result.body),
  );
}
async function ready(context) {
  const preview = await ok(`/categories/${context.category.id}/draw/preview`, {});
  await ok(`/categories/${context.category.id}/draw/confirm`, { version: preview.version });
  await ok(`/tournaments/${context.id}/start`, {});
  context.contest = await db.contest.findFirstOrThrow({
    where: { draw: { categoryId: context.category.id }, status: 'READY' },
  });
  return context;
}
async function sportingPayload(context, type, extra = {}) {
  const contest = await db.contest.findUniqueOrThrow({ where: { id: context.contest.id } });
  return { id: randomUUID(), type, expectedVersion: contest.revision, ...extra };
}
const sportingPath = (context) =>
  `/tatamis/${context.contest.tatamiId}/live/${context.contest.id}/command`;
async function sporting(context, type, extra = {}) {
  return ok(sportingPath(context), await sportingPayload(context, type, extra));
}
async function controlPayload(context, type) {
  const impact = await ok(`/tournaments/${context.id}/control/${context.contest.id}/impact`);
  return {
    id: randomUUID(),
    type,
    expectedRevision: impact.revision,
    impactToken: impact.impactToken,
    reason: 'Изолированная проверка занятости',
  };
}
const controlPath = (context) => `/tournaments/${context.id}/control/${context.contest.id}/command`;
async function sportingSnapshot(context) {
  return {
    contest: await db.contest.findUniqueOrThrow({ where: { id: context.contest.id } }),
    events: await db.matchEvent.findMany({
      where: { contestId: context.contest.id },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: context.id },
      orderBy: { id: 'asc' },
    }),
  };
}

try {
  const owner = await login();
  cookie = owner.cookie;
  const historical = await setup('источник', [
    { lastName: 'Общий спортсмен' },
    { lastName: 'Партнёр источника' },
  ]);
  const original = historical.entries[0];
  assert.ok(original.athleteId);
  assert.notEqual(original.athleteId, historical.entries[1].athleteId);
  const originalSnapshot = await db.entry.findUniqueOrThrow({ where: { id: original.id } });
  const next = await setup('следующий турнир', [
    { lastName: original.lastName, athleteId: original.athleteId },
    { lastName: 'Партнёр следующего' },
  ]);
  assert.equal(next.entries[0].athleteId, original.athleteId);
  assert.notEqual(next.entries[0].id, original.id);
  assert.deepEqual(
    await db.entry.findUniqueOrThrow({ where: { id: original.id } }),
    originalSnapshot,
  );

  const otherCategory = await ok(`/tournaments/${next.id}/categories`, {
    name: 'Другая категория',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 34000,
    durationSeconds: 180,
  });
  let before = await snapshot(next.id);
  const repeated = {
    clubId: next.club.id,
    entries: [fields(otherCategory.id, 'Повтор', { athleteId: original.athleteId })],
  };
  assertPreviewError(
    await call(`/tournaments/${next.id}/roster/preview`, repeated),
    'ATHLETE_ALREADY_REGISTERED',
  );
  assertRowError(
    await call(`/tournaments/${next.id}/roster`, {
      ...repeated,
      id: randomUUID(),
      expectedRevision: await revision(next.id),
    }),
    'ATHLETE_ALREADY_REGISTERED',
  );
  assert.deepEqual(await snapshot(next.id), before);
  const batch = await setup('две строки');
  before = await snapshot(batch.id);
  assertRowError(
    await call(`/tournaments/${batch.id}/roster`, {
      id: randomUUID(),
      expectedRevision: await revision(batch.id),
      clubId: batch.club.id,
      entries: [
        fields(batch.category.id, 'Первая', { athleteId: original.athleteId }),
        fields(batch.category.id, 'Вторая', { athleteId: original.athleteId }),
      ],
    }),
    'ATHLETE_ALREADY_REGISTERED',
  );
  assert.deepEqual(
    await snapshot(batch.id),
    before,
    'invalid batch must not leave identities or receipts',
  );

  const directory = await ok(
    `/tournaments/${next.id}/athletes?query=${encodeURIComponent(original.lastName)}`,
  );
  assert.ok(
    directory.athletes.some(
      (athlete) =>
        athlete.id === original.athleteId && athlete.activeEntry?.entryId === next.entries[0].id,
    ),
  );
  const foreign = await login();
  cookie = foreign.cookie;
  const foreignContext = await setup('чужой владелец');
  assert.equal(
    (
      await ok(
        `/tournaments/${foreignContext.id}/athletes?query=${encodeURIComponent(original.lastName)}`,
      )
    ).athletes.length,
    0,
  );
  const foreignResult = await call(`/tournaments/${foreignContext.id}/roster/preview`, {
    clubId: foreignContext.club.id,
    entries: [
      fields(foreignContext.category.id, original.lastName, { athleteId: original.athleteId }),
    ],
  });
  assertPreviewError(foreignResult, 'ATHLETE_NOT_FOUND');
  const superadmin = await login('SUPER_ADMIN');
  const scopedDirectory = await ok(
    `/tournaments/${foreignContext.id}/athletes?query=${encodeURIComponent(original.lastName)}`,
    undefined,
    superadmin.cookie,
  );
  assert.equal(scopedDirectory.athletes.length, 0, 'SUPER_ADMIN must use tournament owner scope');
  cookie = owner.cookie;

  const drafts = await setup('привязка и архив', [
    { lastName: 'Отдельная запись' },
    { lastName: 'Партнёр привязки' },
  ]);
  const draft = drafts.entries[0];
  const previewDraw = await ok(`/categories/${drafts.category.id}/draw/preview`, {});
  const frozenDraw = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: drafts.category.id },
  });
  const identityPreview = await ok(entryPath(drafts.id, draft.id, 'identity/preview'), {
    athleteId: original.athleteId,
  });
  assert.equal(identityPreview.canSave, true);
  assert.equal(identityPreview.before.athleteId, draft.athleteId);
  assert.equal(identityPreview.proposed.athleteId, original.athleteId);
  const bind = await mutate(drafts, draft, 'identity', { athleteId: original.athleteId });
  assert.equal(bind.receipt.entry.id, draft.id);
  assert.equal(bind.receipt.entry.athleteId, original.athleteId);
  for (const key of [
    'firstName',
    'lastName',
    'birthYear',
    'gender',
    'categoryId',
    'clubId',
    'club',
  ])
    assert.equal(
      bind.receipt.entry[key],
      draft[key],
      key + ' must remain the registration snapshot',
    );
  const staleDraw = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: drafts.category.id },
  });
  assert.equal(staleDraw.status, 'STALE');
  assert.equal(staleDraw.version, previewDraw.version + 1);
  assert.equal(staleDraw.fingerprint, frozenDraw.fingerprint);
  assert.deepEqual(staleDraw.snapshot, frozenDraw.snapshot);
  await mutate(drafts, draft, 'archive');
  const replacement = (
    await add(drafts, [
      fields(drafts.category.id, 'Заявка вместо архивной', { athleteId: original.athleteId }),
    ])
  ).entries[0];
  before = await snapshot(drafts.id);
  const restore = await call(entryPath(drafts.id, draft.id, 'restore'), {
    id: randomUUID(),
    expectedRevision: await revision(drafts.id),
    reason: 'Проверка дублирующего восстановления',
  });
  assertRowError(restore, 'ATHLETE_ALREADY_REGISTERED');
  assert.deepEqual(await snapshot(drafts.id), before);
  assert.deepEqual(
    await ok(entryPath(drafts.id, draft.id, 'identity'), bind.payload),
    bind.receipt,
    'identity replay must return its original receipt even after archival',
  );
  assert.equal(
    (
      await call(entryPath(drafts.id, draft.id, 'identity'), {
        ...bind.payload,
        athleteId: replacement.athleteId,
        reason: 'Изменённый payload',
      })
    ).status,
    409,
  );
  await mutate(drafts, replacement, 'archive');
  await mutate(drafts, draft, 'restore');
  const activeDraft = await db.entry.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(activeDraft.athleteId, original.athleteId);
  const newPreview = await ok(`/categories/${drafts.category.id}/draw/preview`, {});
  await ok(`/categories/${drafts.category.id}/draw/confirm`, { version: newPreview.version });
  before = await snapshot(drafts.id);
  assert.equal(
    (
      await call(entryPath(drafts.id, draft.id, 'identity'), {
        id: randomUUID(),
        expectedRevision: await revision(drafts.id),
        athleteId: historical.entries[1].athleteId,
        reason: 'После подтверждения нельзя',
      })
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(drafts.id), before);

  // Same tournament, different category, same identity: only one concurrent command may commit.
  const race = await setup('одна категория атомарно');
  const raceCategory = await ok(`/tournaments/${race.id}/categories`, {
    name: 'Конкурирующая категория',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 34000,
    durationSeconds: 180,
  });
  const raceRevision = await revision(race.id);
  const admissions = await Promise.all(
    [race.category.id, raceCategory.id].map((categoryId) =>
      call(`/tournaments/${race.id}/roster`, {
        id: randomUUID(),
        expectedRevision: raceRevision,
        clubId: race.club.id,
        entries: [fields(categoryId, 'Конкурирующая заявка', { athleteId: original.athleteId })],
      }),
    ),
  );
  assert.deepEqual(admissions.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    await db.entry.count({
      where: {
        athleteId: original.athleteId,
        archivedAt: null,
        category: { tournamentId: race.id },
      },
    }),
    1,
  );

  // The empty category existed only to test duplicate admissions. Starting a
  // tournament requires a confirmed draw for every remaining category.
  await db.category.delete({ where: { id: otherCategory.id } });
  await ready(historical);
  await ready(next);
  const starts = await Promise.all(
    [historical, next].map(async (context) => {
      const before = await sportingSnapshot(context);
      const payload = await sportingPayload(context, 'START');
      return { context, payload, before, response: await call(sportingPath(context), payload) };
    }),
  );
  assert.deepEqual(starts.map((result) => result.response.status).sort(), [201, 409]);
  const winner = starts.find((result) => result.response.status === 201);
  const loser = starts.find((result) => result.response.status === 409);
  assert.equal(loser.response.body.message, 'TATAMI_OR_ATHLETE_BUSY');
  assert.deepEqual(await sportingSnapshot(loser.context), loser.before);
  await sporting(winner.context, 'STOP');
  const sessionId = randomUUID();
  await sporting(winner.context, 'OFFLINE_OPEN', { sessionId });
  let losingBefore = await sportingSnapshot(loser.context);
  assert.equal(
    (await call(sportingPath(loser.context), await sportingPayload(loser.context, 'START'))).body
      .message,
    'TATAMI_OR_ATHLETE_BUSY',
  );
  assert.deepEqual(
    await sportingSnapshot(loser.context),
    losingBefore,
    'offline ownership keeps the athlete reservation',
  );
  await sporting(winner.context, 'OFFLINE_RELEASE', { sessionId });
  await sporting(winner.context, 'AWARD', { side: 'WHITE', kind: 'IPPON' });
  await sporting(winner.context, 'CONFIRM');
  assert.equal(
    (await call(sportingPath(loser.context), await sportingPayload(loser.context, 'START'))).body
      .message,
    'REST_REQUIRED',
  );
  assert.deepEqual(await sportingSnapshot(loser.context), losingBefore);
  // A saved command receipt remains exact after subsequent mutations in both tournaments.
  assert.deepEqual(await ok(sportingPath(winner.context), winner.payload), winner.response.body);
  await db.contest.update({
    where: { id: winner.context.contest.id },
    data: { confirmedAt: new Date(Date.now() - 601000) },
  });
  const reservationRace = await Promise.all([
    call(sportingPath(loser.context), await sportingPayload(loser.context, 'START')),
    call(controlPath(winner.context), await controlPayload(winner.context, 'REOPEN')),
  ]);
  assert.deepEqual(
    reservationRace.map((result) => result.status).sort(),
    [201, 409],
    'START and REOPEN must share one atomic identity reservation',
  );
  assert.equal(
    reservationRace.find((result) => result.status === 409).body.message,
    'TATAMI_OR_ATHLETE_BUSY',
  );
  const active = reservationRace[0].status === 201 ? loser.context : winner.context;
  const inactive = active === loser.context ? winner.context : loser.context;
  await ok(controlPath(active), await controlPayload(active, 'RESET'));
  if (
    (await db.contest.findUniqueOrThrow({ where: { id: inactive.contest.id } })).status ===
    'CONFIRMED'
  )
    await ok(controlPath(inactive), await controlPayload(inactive, 'REOPEN'));
  else {
    await sporting(inactive, 'START');
    await sporting(inactive, 'AWARD', { side: 'WHITE', kind: 'IPPON' });
  }
  const releaseRace = await Promise.all([
    call(sportingPath(inactive), await sportingPayload(inactive, 'CONFIRM')),
    call(sportingPath(active), await sportingPayload(active, 'START')),
  ]);
  assert.equal(releaseRace[0].status, 201);
  assert.equal(releaseRace[1].status, 409);
  assert.ok(
    ['TATAMI_OR_ATHLETE_BUSY', 'REST_REQUIRED'].includes(releaseRace[1].body.message),
    JSON.stringify(releaseRace),
  );

  // Homonyms are separate identities and can compete concurrently in different tournaments.
  const homonymA = await ready(
    await setup('однофамилец A', [{ lastName: 'Одинаковая фамилия' }, { lastName: 'Партнёр А' }]),
  );
  const homonymB = await ready(
    await setup('однофамилец B', [{ lastName: 'Одинаковая фамилия' }, { lastName: 'Партнёр Б' }]),
  );
  assert.notEqual(homonymA.entries[0].athleteId, homonymB.entries[0].athleteId);
  const independent = await Promise.all(
    [homonymA, homonymB].map(async (context) =>
      call(sportingPath(context), await sportingPayload(context, 'START')),
    ),
  );
  assert.deepEqual(
    independent.map((result) => result.status),
    [201, 201],
  );

  console.log(
    'PASS athlete identities: owner-scoped explicit reuse, one category, archive/restore/bind, immutable history, receipts, global START/REOPEN/CONFIRM races, offline reservation, rest and homonyms',
  );
} finally {
  // The enclosing rehearsal removes the entire disposable schema, including retained history.
  await db.$disconnect();
}
