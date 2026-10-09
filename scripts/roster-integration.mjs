import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { createTestUser, createTestEntries } from './test-user.mjs';

// This suite writes only into the disposable schema/API created by rehearsal.mjs.
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
if (!process.env.TEST_API_URL || !/^qa_rehearsal_[a-f0-9]{32}$/.test(schema ?? ''))
  throw new Error('ROSTER_SUITE_REQUIRES_ISOLATED_REHEARSAL');
const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const tournamentIds = [];
const userIds = [];
let cookie = '';

async function call(path, data, auth = cookie) {
  const response = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function successful(path, data, auth = cookie) {
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
  userIds.push(user.id);
  const response = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(response.status, 201);
  return response.cookie;
}
async function tournament(label) {
  const result = await successful('/tournaments', {
    name: 'Roster isolated QA — ' + label,
    city: 'Алматы',
    venue: 'Удаляемый стенд',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 2,
  });
  tournamentIds.push(result.id);
  return result.id;
}
async function category(tournamentId, name, gender = 'MALE', maxWeightGrams = 30000) {
  return successful(`/tournaments/${tournamentId}/categories`, {
    name,
    gender,
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams,
    durationSeconds: 180,
    format: 'REPECHAGE',
  });
}
const directory = (id) => successful(`/tournaments/${id}/clubs`);
async function createClub(tournamentId, name) {
  const current = await directory(tournamentId);
  const command = { id: randomUUID(), expectedRevision: current.revision, name };
  const response = await successful(`/tournaments/${tournamentId}/clubs`, command);
  return { command, response, club: response.club };
}
const entrant = (categoryId, lastName, firstName = 'Әлихан', extra = {}) => ({
  lastName,
  firstName,
  birthYear: 2012,
  gender: 'MALE',
  categoryId,
  ...extra,
});
async function commit(tournamentId, clubId, entries, extra = {}) {
  const current = await directory(tournamentId);
  const command = {
    id: randomUUID(),
    expectedRevision: current.revision,
    clubId,
    entries,
    ...extra,
  };
  const response = await successful(`/tournaments/${tournamentId}/roster`, command);
  return { command, response };
}
async function rosterSnapshot(tournamentId) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: { rosterRevision: true, status: true },
    }),
    entries: await db.entry.findMany({
      where: { category: { tournamentId } },
      orderBy: { id: 'asc' },
    }),
    clubs: await db.club.findMany({ where: { tournamentId }, orderBy: { id: 'asc' } }),
    receipts: await db.rosterCommand.findMany({ where: { tournamentId }, orderBy: { id: 'asc' } }),
    auditCount: await db.auditEvent.count({ where: { tournamentId } }),
  };
}
async function invalidCommit(tournamentId, clubId, entries, error) {
  const before = await rosterSnapshot(tournamentId);
  const { revision } = await directory(tournamentId);
  const response = await call(`/tournaments/${tournamentId}/roster`, {
    id: randomUUID(),
    expectedRevision: revision,
    clubId,
    entries,
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.message, 'ROSTER_VALIDATION_FAILED');
  assert.ok(
    response.body.rows.some((row) => row.errors.includes(error)),
    JSON.stringify(response.body),
  );
  assert.deepEqual(await rosterSnapshot(tournamentId), before);
}

try {
  const migration = readFileSync(
    new URL(
      '../apps/api/prisma/migrations/20261009010000_club_roster/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const legacyNormalizer = migration.match(
    /^\s+(trim\(regexp_replace\(normalize\(e\."club", NFKC\).+\)\)) AS name$/m,
  )?.[1];
  assert.ok(legacyNormalizer, 'legacy club normalizer must be present in migration SQL');
  const legacyFold = migration.match(
    /,\s*(lower\(name(?:\s+COLLATE[^)]*)?\))\s+AS normalized\b/,
  )?.[1];
  assert.ok(legacyFold, 'legacy club case folding must be present in migration SQL');
  const normalizedSql = legacyFold.replace(/\bname\b/, `(${legacyNormalizer})`);
  for (const name of [
    '\uFEFFЖАС\uFEFFҚЫРАН\uFEFF',
    '\u00A0Judo\u202F Club\u00A0',
    '  Ｊｕｄｏ　Club  ',
    '\tЖас\n  Қыран\r',
    '\u1680Club\u2007Name\u205F',
    ' ӘҒҚҢӨҰҮҺІ ',
    'ΟΣ',
    'İ',
    'ALGA',
  ]) {
    const [result] = await db.$queryRawUnsafe(
      `SELECT ${legacyNormalizer} AS name, ${normalizedSql} AS normalized FROM (SELECT $1::text AS "club") e`,
      name,
    );
    const cleaned = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    assert.equal(result.name, cleaned);
    assert.equal(result.normalized, cleaned.toLocaleLowerCase('ru'));
  }
  cookie = await login();
  const otherOwner = await login();
  const superAdmin = await login('SUPER_ADMIN');
  const main = await tournament('club-first roster');
  const foreign = await tournament('foreign club/category');
  const capacityTournament = await tournament('capacity boundary');
  const legacyPreviewTournament = await tournament('legacy preview fingerprint');
  const light = await category(main, 'U15 male −30');
  const heavy = await category(main, 'U15 male −40', 'MALE', 40000);
  const female = await category(main, 'U15 female −30', 'FEMALE');
  const foreignCategory = await category(foreign, 'Foreign category');
  const capacityCategory = await category(capacityTournament, 'Capacity 128');
  const legacyCategory = await category(legacyPreviewTournament, 'Legacy preview');
  const [{ id: tatamiId }] = await successful(`/tournaments/${main}/tatamis`);
  const invitation = await successful(`/auth/tatamis/${tatamiId}/invitations`, {
    label: 'Roster QA operator',
    hours: 1,
  });
  const judge = await call(
    '/auth/invitations/accept',
    { token: invitation.token, name: 'Roster judge' },
    '',
  );
  assert.equal(judge.status, 201);
  userIds.push((await successful('/auth/me', undefined, judge.cookie)).id);

  const initial = await directory(main);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.clubs, []);
  for (const auth of ['', otherOwner, judge.cookie]) {
    const expected = auth ? 403 : 401;
    for (const [path, data] of [
      [`/tournaments/${main}/clubs`, undefined],
      [
        `/tournaments/${main}/clubs`,
        { id: randomUUID(), expectedRevision: 0, name: 'Denied club' },
      ],
      [
        `/tournaments/${main}/roster/preview`,
        { clubId: randomUUID(), entries: [entrant(light.id, 'Denied')] },
      ],
      [
        `/tournaments/${main}/roster`,
        {
          id: randomUUID(),
          expectedRevision: 0,
          clubId: randomUUID(),
          entries: [entrant(light.id, 'Denied')],
        },
      ],
    ])
      assert.equal((await call(path, data, auth)).status, expected);
  }
  assert.deepEqual(await directory(main), initial);

  const firstClub = await createClub(main, '  Ｊｕｄｏ　Club  ');
  assert.equal(firstClub.club.name, 'Judo Club');
  assert.equal(firstClub.response.revision, 1);
  const equivalentForeignClub = await createClub(foreign, 'judo club');
  assert.notEqual(equivalentForeignClub.club.id, firstClub.club.id);
  const secondClub = await createClub(main, 'Жас Қыран');
  const revisionBeforeClubRace = (await directory(main)).revision;
  const normalizedRace = await Promise.all([
    call(`/tournaments/${main}/clubs`, {
      id: randomUUID(),
      expectedRevision: revisionBeforeClubRace,
      name: ' ＥＶＥＲＥＳＴ  Academy ',
    }),
    call(
      `/tournaments/${main}/clubs`,
      { id: randomUUID(), expectedRevision: revisionBeforeClubRace, name: 'everest academy' },
      superAdmin,
    ),
  ]);
  assert.deepEqual(normalizedRace.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    normalizedRace.find((result) => result.status === 409).body.message,
    'VERSION_CONFLICT',
  );
  const normalizedDuplicate = await call(`/tournaments/${main}/clubs`, {
    id: randomUUID(),
    expectedRevision: (await directory(main)).revision,
    name: 'Everest  Academy',
  });
  assert.equal(normalizedDuplicate.status, 409);
  assert.equal(normalizedDuplicate.body.message, 'CLUB_ALREADY_EXISTS');
  assert.equal((await directory(main)).clubs.length, 3);

  const firstRows = [
    entrant(light.id, 'Серік'),
    entrant(heavy.id, 'Explicit heavier category'),
    entrant(female.id, 'Қыз', 'Айша', { gender: 'FEMALE' }),
  ];
  const beforePreview = await rosterSnapshot(main);
  const preview = await successful(`/tournaments/${main}/roster/preview`, {
    clubId: firstClub.club.id,
    entries: firstRows,
  });
  assert.equal(preview.revision, beforePreview.tournament.rosterRevision);
  assert.equal(preview.canSave, true);
  assert.deepEqual(
    preview.rows.map((row) => row.index),
    [0, 1, 2],
  );
  assert.ok(preview.rows.every((row) => row.errors.length === 0));
  assert.deepEqual(
    await rosterSnapshot(main),
    beforePreview,
    'preview must never write entries, clubs, receipts, revisions or audits',
  );
  const firstBatch = await commit(main, firstClub.club.id, firstRows);
  assert.equal(firstBatch.response.entries.length, 3);
  assert.deepEqual(
    firstBatch.response.entries.map((row) => row.categoryId),
    firstRows.map((row) => row.categoryId),
  );
  assert.deepEqual(
    firstBatch.response.entries.map((row) => row.gender),
    ['MALE', 'MALE', 'FEMALE'],
  );
  assert.ok(
    firstBatch.response.entries.every(
      (row) => row.clubId === firstClub.club.id && row.club === firstClub.club.name,
    ),
  );
  for (const row of firstBatch.response.entries)
    for (const key of ['actualWeightGrams', 'weight', 'weighedAt'])
      assert.equal(Object.hasOwn(row, key), false);
  const tour = await successful(`/tournaments/${main}`);
  assert.equal(tour.rosterRevision, firstBatch.response.revision);
  assert.equal(tour.clubs.find((club) => club.id === firstClub.club.id)._count.entries, 3);

  for (const [entries, error] of [
    [
      [
        entrant(light.id, 'Valid before invalid'),
        entrant(light.id, 'Too old', 'Әлихан', { birthYear: 2001 }),
      ],
      'BIRTH_YEAR_OUT_OF_RANGE',
    ],
    [[entrant(light.id, 'Wrong gender', 'Айша', { gender: 'FEMALE' })], 'GENDER_MISMATCH'],
    [[entrant(foreignCategory.id, 'Foreign category')], 'CATEGORY_NOT_FOUND'],
    [[entrant(light.id, '   ')], 'NAME_REQUIRED'],
  ]) {
    const before = await rosterSnapshot(main);
    const invalidPreview = await successful(`/tournaments/${main}/roster/preview`, {
      clubId: firstClub.club.id,
      entries,
    });
    assert.equal(invalidPreview.canSave, false);
    assert.ok(invalidPreview.rows.some((row) => row.errors.includes(error)));
    assert.deepEqual(await rosterSnapshot(main), before);
    await invalidCommit(main, firstClub.club.id, entries, error);
  }
  for (const path of ['roster/preview', 'roster']) {
    const before = await rosterSnapshot(main);
    const response = await call(`/tournaments/${main}/${path}`, {
      ...(path === 'roster'
        ? { id: randomUUID(), expectedRevision: (await directory(main)).revision }
        : {}),
      clubId: equivalentForeignClub.club.id,
      entries: [entrant(light.id, 'Foreign club')],
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.message, 'CLUB_NOT_FOUND');
    assert.deepEqual(await rosterSnapshot(main), before);
  }
  const beforeDtoFailures = await rosterSnapshot(main);
  for (const entries of [
    [],
    Array.from({ length: 501 }, (_, i) => entrant(light.id, `Limit ${i}`)),
    [{ ...entrant(light.id, 'No weighing'), actualWeightGrams: 29900 }],
  ]) {
    const response = await call(`/tournaments/${main}/roster`, {
      id: randomUUID(),
      expectedRevision: (await directory(main)).revision,
      clubId: firstClub.club.id,
      entries,
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await rosterSnapshot(main), beforeDtoFailures);

  // A homonym in another club/category is a warning requiring deliberate admission.
  const homonym = entrant(heavy.id, '  Серік ', 'Әлихан');
  const homonymPreview = await successful(`/tournaments/${main}/roster/preview`, {
    clubId: secondClub.club.id,
    entries: [homonym],
  });
  assert.equal(homonymPreview.canSave, false);
  assert.ok(homonymPreview.rows[0].errors.includes('DUPLICATE_CONFIRMATION_REQUIRED'));
  assert.ok(
    homonymPreview.rows[0].possibleDuplicates.some(
      (row) => row.entryId === firstBatch.response.entries[0].id,
    ),
  );
  await invalidCommit(main, secondClub.club.id, [homonym], 'DUPLICATE_CONFIRMATION_REQUIRED');
  const acknowledged = await commit(main, secondClub.club.id, [
    { ...homonym, duplicateConfirmed: true },
  ]);
  assert.notEqual(acknowledged.response.entries[0].id, firstBatch.response.entries[0].id);
  assert.equal(acknowledged.response.entries[0].clubId, secondClub.club.id);
  assert.equal(
    (await db.entry.findUniqueOrThrow({ where: { id: firstBatch.response.entries[0].id } })).clubId,
    firstClub.club.id,
  );
  const twins = [
    entrant(heavy.id, 'Same-batch homonym', 'Пётр'),
    entrant(heavy.id, 'Same-batch homonym', 'Пётр'),
  ];
  const twinsPreview = await successful(`/tournaments/${main}/roster/preview`, {
    clubId: secondClub.club.id,
    entries: twins,
  });
  assert.equal(twinsPreview.canSave, false);
  assert.ok(
    twinsPreview.rows.some((row) =>
      row.possibleDuplicates.some((duplicate) => duplicate.entryId.startsWith('batch:')),
    ),
  );
  await invalidCommit(main, secondClub.club.id, twins, 'DUPLICATE_CONFIRMATION_REQUIRED');
  const confirmedTwins = await commit(
    main,
    secondClub.club.id,
    twins.map((row) => ({ ...row, duplicateConfirmed: true })),
  );
  assert.equal(
    new Set(confirmedTwins.response.entries.map((row) => row.id)).size,
    2,
    'confirmation admits both athletes; it never merges their identity',
  );

  const raceRevision = (await directory(main)).revision;
  const competingBatches = await Promise.all([
    call(`/tournaments/${main}/roster`, {
      id: randomUUID(),
      expectedRevision: raceRevision,
      clubId: firstClub.club.id,
      entries: [entrant(light.id, 'Administrator A')],
    }),
    call(
      `/tournaments/${main}/roster`,
      {
        id: randomUUID(),
        expectedRevision: raceRevision,
        clubId: firstClub.club.id,
        entries: [entrant(light.id, 'Administrator B')],
      },
      superAdmin,
    ),
  ]);
  assert.deepEqual(competingBatches.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    competingBatches.find((result) => result.status === 409).body.message,
    'VERSION_CONFLICT',
  );
  const simultaneous = {
    id: randomUUID(),
    expectedRevision: (await directory(main)).revision,
    clubId: firstClub.club.id,
    entries: [entrant(female.id, 'Concurrent same ID', 'Әсел', { gender: 'FEMALE' })],
  };
  const exactRaces = await Promise.all([
    call(`/tournaments/${main}/roster`, simultaneous),
    call(`/tournaments/${main}/roster`, simultaneous),
  ]);
  assert.deepEqual(
    exactRaces.map((result) => result.status),
    [201, 201],
  );
  assert.deepEqual(exactRaces[0].body, exactRaces[1].body);
  assert.equal(await db.rosterCommand.count({ where: { id: simultaneous.id } }), 1);
  assert.equal(await db.entry.count({ where: { id: exactRaces[0].body.entries[0].id } }), 1);
  const beforeReplay = await rosterSnapshot(main);
  assert.deepEqual(
    await successful(`/tournaments/${main}/roster`, firstBatch.command),
    firstBatch.response,
  );
  assert.deepEqual(
    await successful(`/tournaments/${main}/clubs`, firstClub.command),
    firstClub.response,
  );
  assert.equal(
    (
      await call(`/tournaments/${main}/roster`, {
        ...firstBatch.command,
        entries: [entrant(light.id, 'Changed same ID')],
      })
    ).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.equal(
    (await call(`/tournaments/${main}/roster`, { ...firstBatch.command, id: randomUUID() })).body
      .message,
    'VERSION_CONFLICT',
  );
  assert.deepEqual(await rosterSnapshot(main), beforeReplay);

  const capacityClub = await createClub(capacityTournament, 'Capacity club');
  await createTestEntries(
    db,
    Array.from({ length: 127 }, (_, i) => ({
      categoryId: capacityCategory.id,
      firstName: 'Capacity',
      lastName: `Seed ${i}`,
      birthYear: 2012,
      gender: 'MALE',
      club: capacityClub.club.name,
      clubId: capacityClub.club.id,
    })),
  );
  await invalidCommit(
    capacityTournament,
    capacityClub.club.id,
    [entrant(capacityCategory.id, 'Would be 128'), entrant(capacityCategory.id, 'Would be 129')],
    'CATEGORY_CAPACITY',
  );
  await commit(capacityTournament, capacityClub.club.id, [
    entrant(capacityCategory.id, 'Exactly 128'),
  ]);
  assert.equal(await db.entry.count({ where: { categoryId: capacityCategory.id } }), 128);
  await invalidCommit(
    capacityTournament,
    capacityClub.club.id,
    [entrant(capacityCategory.id, 'Overflow 129')],
    'CATEGORY_CAPACITY',
  );

  // Exercise the HTTP parser and real bulk transaction at the declared maximum.
  // Four explicit categories admit 125 people each, below their individual caps.
  const bulkTournament = await tournament('500-row UTF-8 HTTP limit');
  const bulkCategories = [];
  for (let i = 0; i < 4; i++)
    bulkCategories.push(
      await category(
        bulkTournament,
        `Bulk category ${i}`,
        i < 2 ? 'MALE' : 'FEMALE',
        30000 + i * 10000,
      ),
    );
  const bulkClub = await createClub(bulkTournament, 'Unicode bulk club');
  const bulkRows = Array.from({ length: 500 }, (_, i) =>
    entrant(bulkCategories[i % 4].id, 'Ұ'.repeat(77) + String(i).padStart(3, '0'), 'Қ'.repeat(80), {
      gender: i % 4 < 2 ? 'MALE' : 'FEMALE',
    }),
  );
  const bulkCommand = {
    id: randomUUID(),
    expectedRevision: (await directory(bulkTournament)).revision,
    clubId: bulkClub.club.id,
    entries: bulkRows,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(bulkCommand), 'utf8') > 102400);
  const beforeBulkPreview = await rosterSnapshot(bulkTournament);
  const duplicatePaste = await successful(`/tournaments/${bulkTournament}/roster/preview`, {
    clubId: bulkClub.club.id,
    entries: Array.from({ length: 500 }, () => ({ ...bulkRows[0] })),
  });
  assert.equal(duplicatePaste.canSave, false);
  assert.equal(duplicatePaste.rows.length, 500);
  assert.ok(
    duplicatePaste.rows.every(
      (row) =>
        row.duplicateCount === 499 &&
        row.possibleDuplicates.length <= 5 &&
        row.errors.includes('DUPLICATE_CONFIRMATION_REQUIRED'),
    ),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(duplicatePaste), 'utf8') < 2000000);
  const bulkPreview = await successful(`/tournaments/${bulkTournament}/roster/preview`, {
    clubId: bulkClub.club.id,
    entries: bulkRows,
  });
  assert.equal(bulkPreview.canSave, true);
  assert.equal(bulkPreview.rows.length, 500);
  assert.ok(bulkPreview.rows.every((row) => row.errors.length === 0 && row.duplicateCount === 0));
  assert.deepEqual(await rosterSnapshot(bulkTournament), beforeBulkPreview);
  const bulkSaved = await successful(`/tournaments/${bulkTournament}/roster`, bulkCommand);
  assert.equal(bulkSaved.revision, bulkCommand.expectedRevision + 1);
  assert.equal(bulkSaved.entries.length, 500);
  assert.deepEqual(
    bulkSaved.entries.map((entry) => [entry.lastName, entry.categoryId, entry.gender]),
    bulkRows.map((entry) => [entry.lastName, entry.categoryId, entry.gender]),
  );
  for (const bulkCategory of bulkCategories)
    assert.equal(await db.entry.count({ where: { categoryId: bulkCategory.id } }), 125);
  const afterBulkCommit = await rosterSnapshot(bulkTournament);
  assert.equal(afterBulkCommit.entries.length, 500);
  assert.equal(
    afterBulkCommit.receipts.filter((receipt) => receipt.type === 'ROSTER_ADDED').length,
    1,
  );
  assert.deepEqual(
    await successful(`/tournaments/${bulkTournament}/roster`, bulkCommand),
    bulkSaved,
  );
  assert.deepEqual(await rosterSnapshot(bulkTournament), afterBulkCommit);

  // New admissions before confirmation invalidate the previous preview.
  const stalePreview = await successful(`/categories/${light.id}/draw/preview`, {});
  await commit(main, firstClub.club.id, [entrant(light.id, 'Added after preview')]);
  const staleConfirmation = await call(`/categories/${light.id}/draw/confirm`, {
    version: stalePreview.version,
  });
  assert.equal(staleConfirmation.status, 409);
  assert.equal(staleConfirmation.body.message, 'DRAW_ENTRIES_CHANGED');
  const drawPreview = await successful(`/categories/${light.id}/draw/preview`, {});
  const confirmedDraw = await successful(`/categories/${light.id}/draw/confirm`, {
    version: drawPreview.version,
  });
  // A confirmed category locks admission without changing entries or results.
  const beforeLocked = await rosterSnapshot(main);
  const originalDraw = await db.drawRecord.findUniqueOrThrow({ where: { categoryId: light.id } });
  const originalContests = await db.contest.findMany({
    where: { drawId: originalDraw.id },
    orderBy: { id: 'asc' },
  });
  await invalidCommit(
    main,
    secondClub.club.id,
    [entrant(heavy.id, 'Valid unlocked first'), entrant(light.id, 'Locked second')],
    'DRAW_LOCKED',
  );
  assert.deepEqual(await rosterSnapshot(main), beforeLocked);
  assert.deepEqual(
    await db.drawRecord.findUniqueOrThrow({ where: { categoryId: light.id } }),
    originalDraw,
  );
  assert.deepEqual(
    await db.contest.findMany({ where: { drawId: originalDraw.id }, orderBy: { id: 'asc' } }),
    originalContests,
  );
  // Backfilling only new fields preserves the historical preview fingerprint.
  const legacyClub = await createClub(legacyPreviewTournament, 'Legacy Club');
  await createTestEntries(
    db,
    [0, 1].map((i) => ({
      categoryId: legacyCategory.id,
      firstName: 'Legacy',
      lastName: `Entry ${i}`,
      birthYear: 2012,
      club: legacyClub.club.name,
      clubId: null,
      gender: null,
    })),
  );
  const legacyPreview = await successful(`/categories/${legacyCategory.id}/draw/preview`, {});
  const legacyDrawSnapshot = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: legacyCategory.id },
  });
  await db.entry.updateMany({
    where: { categoryId: legacyCategory.id },
    data: { clubId: legacyClub.club.id, gender: 'MALE' },
  });
  assert.deepEqual(
    await db.drawRecord.findUniqueOrThrow({ where: { categoryId: legacyCategory.id } }),
    legacyDrawSnapshot,
  );
  await successful(`/categories/${legacyCategory.id}/draw/confirm`, {
    version: legacyPreview.version,
  });
  for (const currentCategory of [heavy, female]) {
    const preview = await successful(`/categories/${currentCategory.id}/draw/preview`, {});
    await successful(`/categories/${currentCategory.id}/draw/confirm`, {
      version: preview.version,
    });
  }
  const ready = confirmedDraw.contests.find((row) => row.status === 'READY');
  const beforeNamespace = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  const idReusedForAssignment = await call(`/contests/${ready.id}/assign`, {
    id: firstBatch.command.id,
    expectedRevision: ready.revision,
    tatamiId,
  });
  assert.equal(idReusedForAssignment.status, 409);
  assert.equal(idReusedForAssignment.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: ready.id } }),
    beforeNamespace,
  );
  await successful(`/tournaments/${main}/start`, {});
  const assigned = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  const activeQueue = await successful(`/tournaments/${main}/tatamis/${assigned.tatamiId}`);
  const current = await db.contest.findUniqueOrThrow({ where: { id: activeQueue.queue[0].id } });
  const started = await successful(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
    id: randomUUID(),
    expectedVersion: current.revision,
    type: 'START',
  });
  const idReusedForScore = await call(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
    id: firstBatch.command.id,
    expectedVersion: started.revision,
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
  });
  assert.equal(idReusedForScore.status, 409);
  assert.equal(idReusedForScore.body.message, 'COMMAND_ID_REUSED');
  assert.equal(
    (await db.contest.findUniqueOrThrow({ where: { id: current.id } })).state.awards.length,
    0,
  );
  // The same UUID racing across different tournaments and receipt tables must
  // produce exactly one command, even though both versions are initially valid.
  const sharedId = randomUUID();
  const foreignBeforeRace = await rosterSnapshot(foreign);
  const namespaceRace = await Promise.all([
    call(`/tournaments/${foreign}/clubs`, {
      id: sharedId,
      expectedRevision: foreignBeforeRace.tournament.rosterRevision,
      name: 'Shared UUID race club',
    }),
    call(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
      id: sharedId,
      expectedVersion: started.revision,
      type: 'STOP',
    }),
  ]);
  assert.deepEqual(namespaceRace.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    namespaceRace.find((result) => result.status === 409).body.message,
    'COMMAND_ID_REUSED',
  );
  const rosterRaceReceipts = await db.rosterCommand.count({ where: { id: sharedId } });
  const sportRaceReceipts = await db.matchEvent.count({ where: { id: sharedId } });
  assert.equal(rosterRaceReceipts + sportRaceReceipts, 1);
  if (namespaceRace[0].status === 409) {
    assert.equal(rosterRaceReceipts, 0);
    assert.deepEqual(await rosterSnapshot(foreign), foreignBeforeRace);
  } else {
    assert.equal(sportRaceReceipts, 0);
    const liveAfterRace = await db.contest.findUniqueOrThrow({ where: { id: current.id } });
    assert.equal(liveAfterRace.revision, started.revision);
    assert.equal(liveAfterRace.state.status, 'RUNNING');
    await successful(`/tatamis/${current.tatamiId}/live/${current.id}/command`, {
      id: randomUUID(),
      expectedVersion: started.revision,
      type: 'STOP',
    });
  }
  const startedSnapshot = await rosterSnapshot(main);
  assert.deepEqual(
    await successful(`/tournaments/${main}/roster`, firstBatch.command),
    firstBatch.response,
  );
  assert.deepEqual(
    await successful(`/tournaments/${main}/clubs`, firstClub.command),
    firstClub.response,
  );
  const currentRevision = (await directory(main)).revision;
  const lockedClub = await call(`/tournaments/${main}/clubs`, {
    id: randomUUID(),
    expectedRevision: currentRevision,
    name: 'After start',
  });
  assert.equal(lockedClub.status, 409);
  assert.equal(lockedClub.body.message, 'ROSTER_LOCKED');
  const lockedRoster = await call(`/tournaments/${main}/roster`, {
    id: randomUUID(),
    expectedRevision: currentRevision,
    clubId: firstClub.club.id,
    entries: [entrant(light.id, 'After start')],
  });
  assert.equal(lockedRoster.status, 409);
  assert.equal(lockedRoster.body.message, 'ROSTER_LOCKED');
  const lockedPreview = await successful(`/tournaments/${main}/roster/preview`, {
    clubId: firstClub.club.id,
    entries: [entrant(light.id, 'After start preview')],
  });
  assert.equal(lockedPreview.canSave, false);
  assert.ok(lockedPreview.rows[0].errors.includes('ROSTER_LOCKED'));
  assert.deepEqual(await rosterSnapshot(main), startedSnapshot);
  console.log(
    'PASS: isolated club-first roster, normalized scoped clubs/auth, read-only previews, explicit age/gender/categories/no weighing, homonym acknowledgement without merge, capacity128/batch500/atomic rollback, revisions/concurrent retries, historical snapshots/draw locks/start, global roster/assignment/score command IDs.',
  );
} finally {
  if (tournamentIds.length) {
    const tournamentId = { in: tournamentIds };
    await db.matchEvent.deleteMany({
      where: { contest: { draw: { category: { tournamentId } } } },
    });
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId } } });
    await db.rosterCommand.deleteMany({ where: { tournamentId } });
    await db.entry.deleteMany({ where: { category: { tournamentId } } });
    await db.club.deleteMany({ where: { tournamentId } });
    await db.category.deleteMany({ where: { tournamentId } });
    await db.invitation.deleteMany({ where: { tatami: { tournamentId } } });
    await db.tatami.deleteMany({ where: { tournamentId } });
    await db.auditEvent.deleteMany({ where: { tournamentId } });
    await db.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
  }
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
}
