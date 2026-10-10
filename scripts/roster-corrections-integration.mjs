import { fixtureRequest } from './test-access.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pdfText } from './pdf-text.mjs';
import { PrismaClient } from '@prisma/client';
import { createTestUser, createTestEntries } from './test-user.mjs';

// All writes belong to a disposable rehearsal schema and this suite's own tournaments.
const connection = new URL(process.env.DATABASE_URL);
if (
  !/^qa_rehearsal_[a-f0-9]{32}$/.test(connection.searchParams.get('schema') ?? '') ||
  !process.env.TEST_API_URL
)
  throw new Error('ROSTER_CORRECTIONS_REQUIRE_ISOLATED_REHEARSAL');
const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const tournamentIds = [];
const userIds = [];
const receipts = [];
let cookie = '';

async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(base, path, data, auth);
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
  const result = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(result.status, 201);
  return result.cookie;
}
async function tournament(label) {
  const value = await successful('/tournaments', {
    name: 'Corrections isolated QA — ' + label,
    city: 'Алматы',
    venue: 'Удаляемый стенд',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 2,
  });
  tournamentIds.push(value.id);
  return value.id;
}
async function category(id, name, gender = 'MALE', maxWeightGrams = 30000) {
  return successful(`/tournaments/${id}/categories`, {
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
async function club(id, name) {
  return (
    await successful(`/tournaments/${id}/clubs`, {
      id: randomUUID(),
      expectedRevision: (await directory(id)).revision,
      name,
    })
  ).club;
}
const entrant = (categoryId, lastName, extra = {}) => ({
  categoryId,
  lastName,
  firstName: 'Әлихан',
  birthYear: 2012,
  gender: 'MALE',
  ...extra,
});
async function add(id, clubId, entries) {
  return successful(`/tournaments/${id}/roster`, {
    id: randomUUID(),
    expectedRevision: (await directory(id)).revision,
    clubId,
    entries,
  });
}
const fields = (entry, extra = {}) => ({
  clubId: entry.clubId,
  firstName: entry.firstName,
  lastName: entry.lastName,
  birthYear: entry.birthYear,
  gender: entry.gender,
  categoryId: entry.categoryId,
  ...extra,
});
const path = (id, entryId, action) => `/tournaments/${id}/roster/entries/${entryId}/${action}`;
async function mutation(id, entryId, action, data = {}) {
  const payload = {
    id: randomUUID(),
    expectedRevision: (await directory(id)).revision,
    reason: 'Проверка исправления заявки',
    ...data,
  };
  const response = await successful(path(id, entryId, action), payload);
  receipts.push({ path: path(id, entryId, action), payload, response });
  assert.equal(response.revision, payload.expectedRevision + 1);
  assert.equal(response.entry.id, entryId);
  return { payload, response };
}
async function snapshot(id) {
  return {
    tournament: await db.tournament.findUniqueOrThrow({ where: { id } }),
    entries: await db.entry.findMany({
      where: { category: { tournamentId: id } },
      orderBy: { id: 'asc' },
    }),
    clubs: await db.club.findMany({ where: { tournamentId: id }, orderBy: { id: 'asc' } }),
    draws: await db.drawRecord.findMany({
      where: { category: { tournamentId: id } },
      orderBy: { id: 'asc' },
    }),
    contests: await db.contest.findMany({
      where: { draw: { category: { tournamentId: id } } },
      orderBy: { id: 'asc' },
    }),
    receipts: await db.rosterCommand.findMany({
      where: { tournamentId: id },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({ where: { tournamentId: id }, orderBy: { id: 'asc' } }),
  };
}
async function rejected(id, entryId, action, data, status, message, rowError) {
  const before = await snapshot(id);
  const result = await call(path(id, entryId, action), {
    id: randomUUID(),
    expectedRevision: (await directory(id)).revision,
    ...(action === 'preview' ? {} : { reason: 'Проверка отклонения команды' }),
    ...data,
  });
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (message) assert.equal(result.body.message, message, JSON.stringify(result.body));
  if (rowError)
    assert.ok(
      result.body.rows.some((row) => row.errors.includes(rowError)),
      JSON.stringify(result.body),
    );
  assert.deepEqual(
    await snapshot(id),
    before,
    `${action} rejection must roll back every stored object`,
  );
}
async function drawPreview(categoryId) {
  return successful(`/categories/${categoryId}/draw/preview`, {});
}
async function assertStale(categoryId, previous) {
  const current = await db.drawRecord.findUniqueOrThrow({ where: { categoryId } });
  assert.equal(current.status, 'STALE');
  assert.equal(current.version, previous.version + 1);
  assert.deepEqual(
    current.snapshot,
    previous.snapshot,
    'invalidating preview preserves its historical positions',
  );
  assert.equal(current.fingerprint, previous.fingerprint);
  const result = await call(`/categories/${categoryId}/draw/confirm`, { version: current.version });
  assert.equal(result.status, 409);
  assert.equal(result.body.message, 'DRAW_ENTRIES_CHANGED');
  return current;
}

async function waitForTournamentBlock(blockerPids, excludedPids = []) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const waiting = await db.$queryRaw`
      SELECT pid, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user
        AND query LIKE '%SELECT id FROM "Tournament"%'
    `;
    const blocked = waiting.find(
      (row) =>
        !excludedPids.includes(row.pid) && row.blockers.some((pid) => blockerPids.includes(pid)),
    );
    if (blocked) return blocked.pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('both HTTP commands must reach the real PostgreSQL tournament lock queue');
}

async function correctionConfirmRace(winner) {
  const id = await tournament('correction versus confirm — ' + winner);
  const raceCategory = await category(id, 'Correction/confirm lock race');
  const raceClub = await club(id, 'Correction/confirm Club');
  const roster = await add(id, raceClub.id, [
    entrant(raceCategory.id, 'Race Original'),
    entrant(raceCategory.id, 'Race Partner'),
    entrant(raceCategory.id, 'Race Third'),
  ]);
  const entry = roster.entries[0];
  const preview = await drawPreview(raceCategory.id);
  const before = await snapshot(id);
  const command = {
    ...fields(entry, { lastName: 'Race Corrected' }),
    id: randomUUID(),
    expectedRevision: roster.revision,
    reason: 'Correction competing with draw confirmation',
  };
  const requests = {
    correction: () => call(path(id, entry.id, 'update'), command),
    confirm: () =>
      call(`/categories/${raceCategory.id}/draw/confirm`, { version: preview.version }),
  };
  const pending = [];
  const order = [winner, winner === 'confirm' ? 'correction' : 'confirm'];
  try {
    // The suite holds only its own tournament. Start both HTTP requests while it
    // is held and observe PostgreSQL's actual lock queue before releasing it.
    // FIFO tuple locking then exercises both possible serializations reliably.
    await db.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
        pending.push(requests[order[0]]());
        pending[0].catch(() => {});
        const firstPid = await waitForTournamentBlock([pid]);
        pending.push(requests[order[1]]());
        pending[1].catch(() => {});
        await waitForTournamentBlock([pid, firstPid], [firstPid]);
      },
      { timeout: 10000 },
    );
    const results = await Promise.all(pending);
    const outcome = Object.fromEntries(order.map((action, index) => [action, results[index]]));
    const after = await snapshot(id);
    const oldDraw = before.draws[0];
    const draw = after.draws[0];
    const newAudits = after.audits.filter(
      (audit) => !before.audits.some((old) => old.id === audit.id),
    );
    assert.deepEqual(draw.snapshot, oldDraw.snapshot, 'neither race branch replaces the snapshot');
    assert.equal(draw.fingerprint, oldDraw.fingerprint);
    assert.deepEqual(after.clubs, before.clubs);
    assert.deepEqual(
      after.entries.map((row) => row.id),
      before.entries.map((row) => row.id),
      'both branches retain the original Entry IDs',
    );
    if (winner === 'confirm') {
      assert.equal(outcome.confirm.status, 201, JSON.stringify(outcome.confirm.body));
      assert.equal(outcome.correction.status, 409, JSON.stringify(outcome.correction.body));
      assert.equal(outcome.correction.body.message, 'ENTRY_IN_DRAW');
      assert.equal(draw.status, 'CONFIRMED');
      assert.equal(draw.version, oldDraw.version);
      assert.ok(draw.confirmedAt);
      assert.deepEqual(after.entries, before.entries, 'losing correction cannot alter the roster');
      assert.deepEqual(after.tournament, before.tournament);
      assert.deepEqual(after.receipts, before.receipts);
      assert.ok(after.contests.length > 0);
      assert.equal(after.contests.length, outcome.confirm.body.contests.length);
      const entrantIds = new Set(before.entries.map((row) => row.id));
      for (const contest of after.contests)
        for (const entrantId of [contest.whiteEntryId, contest.blueEntryId])
          if (entrantId) assert.ok(entrantIds.has(entrantId));
      assert.deepEqual(
        newAudits.map((audit) => audit.action),
        ['DRAW_CONFIRMED'],
      );
    } else {
      assert.equal(outcome.correction.status, 201, JSON.stringify(outcome.correction.body));
      assert.equal(outcome.confirm.status, 409, JSON.stringify(outcome.confirm.body));
      assert.equal(outcome.confirm.body.message, 'DRAW_ENTRIES_CHANGED');
      assert.equal(draw.status, 'STALE');
      assert.equal(draw.version, oldDraw.version + 1);
      assert.equal(draw.confirmedAt, null);
      assert.deepEqual(
        after.entries,
        before.entries.map((row) =>
          row.id === entry.id ? { ...row, lastName: command.lastName } : row,
        ),
      );
      assert.deepEqual(after.tournament, {
        ...before.tournament,
        rosterRevision: before.tournament.rosterRevision + 1,
      });
      assert.deepEqual(after.contests, before.contests, 'losing confirm cannot create contests');
      assert.deepEqual(outcome.correction.body.invalidatedCategoryIds, [raceCategory.id]);
      assert.equal(outcome.correction.body.revision, before.tournament.rosterRevision + 1);
      const saved = after.receipts.filter((receipt) => receipt.id === command.id);
      assert.equal(saved.length, 1);
      assert.equal(after.receipts.length, before.receipts.length + 1);
      assert.equal(saved[0].type, 'ENTRY_UPDATED');
      assert.deepEqual(saved[0].command, { ...command, entryId: entry.id });
      assert.deepEqual(saved[0].response, outcome.correction.body);
      assert.deepEqual(newAudits.map((audit) => audit.action).sort(), [
        'DRAW_INVALIDATED',
        'ENTRY_UPDATED',
      ]);
      await assertStale(raceCategory.id, oldDraw);
      assert.deepEqual(
        await successful(path(id, entry.id, 'update'), command),
        outcome.correction.body,
      );
      assert.deepEqual(await snapshot(id), after, 'stale confirm/retry adds no writes');
    }
  } catch (error) {
    // A failed queue assertion releases the test lock before awaiting requests.
    await Promise.allSettled(pending);
    throw error;
  }
}

async function participantText(id) {
  const response = await fetch(`${base}/tournaments/${id}/protocol.pdf?kind=PARTICIPANTS&lang=ru`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return pdfText(Buffer.from(await response.arrayBuffer()));
}

try {
  cookie = await login();
  const otherOwner = await login();
  const admin = await login('SUPER_ADMIN');
  const main = await tournament('edit move archive restore');
  const foreign = await tournament('foreign scopes');
  const capacity = await tournament('active capacity');
  const light = await category(main, 'Corrections light');
  const heavy = await category(main, 'Corrections heavy', 'MALE', 40000);
  const female = await category(main, 'Corrections female', 'FEMALE');
  const foreignCategory = await category(foreign, 'Foreign category');
  const capacityCategory = await category(capacity, 'Capacity');
  const firstClub = await club(main, 'Corrections Club One');
  const secondClub = await club(main, 'Corrections Club Two');
  const foreignClub = await club(foreign, 'Foreign Club');
  const original = await add(main, firstClub.id, [
    entrant(light.id, 'Original Entry'),
    entrant(light.id, 'Light Mate'),
    entrant(light.id, 'Light Third'),
    entrant(heavy.id, 'Heavy Mate'),
    entrant(heavy.id, 'Heavy Second'),
    entrant(heavy.id, 'Heavy Third'),
    entrant(female.id, 'Female One', { gender: 'FEMALE' }),
    entrant(female.id, 'Female Two', { gender: 'FEMALE' }),
  ]);
  const entry = original.entries[0];
  const foreignEntry = (
    await add(foreign, foreignClub.id, [entrant(foreignCategory.id, 'Foreign Entry')])
  ).entries[0];
  const [tatami] = await successful(`/tournaments/${main}/tatamis`);
  const invitation = await successful(`/auth/tatamis/${tatami.id}/invitations`, {
    label: 'Corrections judge',
    hours: 1,
  });
  const judge = await call(
    '/auth/invitations/accept',
    { token: invitation.token, name: 'Corrections judge' },
    '',
  );
  assert.equal(judge.status, 201);
  userIds.push((await successful('/auth/me', undefined, judge.cookie)).id);
  const initial = await snapshot(main);
  for (const auth of ['', otherOwner, judge.cookie]) {
    const expected = auth ? 403 : 401;
    assert.equal(
      (await call(`/tournaments/${main}/roster/archived`, undefined, auth)).status,
      expected,
    );
    for (const action of ['preview', 'update', 'archive', 'restore'])
      assert.equal(
        (
          await call(
            path(main, entry.id, action),
            {
              ...(action === 'preview'
                ? fields(entry)
                : {
                    id: randomUUID(),
                    expectedRevision: original.revision,
                    reason: 'Unauthorized command',
                  }),
              ...(action === 'update' ? fields(entry) : {}),
            },
            auth,
          )
        ).status,
        expected,
      );
  }
  assert.deepEqual(await snapshot(main), initial);
  const proposed = fields(entry, { lastName: 'ARCHIVED_ENTRY_MARKER', clubId: secondClub.id });
  const beforePreview = await snapshot(main);
  const selfPreview = await successful(path(main, entry.id, 'preview'), fields(entry));
  assert.equal(selfPreview.canSave, true);
  assert.equal(selfPreview.rows[0].duplicateCount, 0);
  const preview = await successful(path(main, entry.id, 'preview'), proposed);
  assert.equal(preview.canSave, true);
  assert.equal(preview.before.id, entry.id);
  assert.equal(
    preview.rows[0].duplicateCount,
    0,
    'unchanged identity excludes the edited row itself',
  );
  assert.deepEqual(await snapshot(main), beforePreview);
  for (const [data, error] of [
    [fields(entry, { birthYear: 2001 }), 'BIRTH_YEAR_OUT_OF_RANGE'],
    [fields(entry, { gender: 'FEMALE' }), 'GENDER_MISMATCH'],
    [fields(entry, { categoryId: foreignCategory.id }), 'CATEGORY_NOT_FOUND'],
    [fields(entry, { lastName: '   ' }), 'NAME_REQUIRED'],
  ])
    await rejected(main, entry.id, 'update', data, 400, 'ROSTER_VALIDATION_FAILED', error);
  await rejected(
    main,
    entry.id,
    'update',
    fields(entry, { clubId: foreignClub.id }),
    404,
    'CLUB_NOT_FOUND',
  );
  for (const reason of ['', '  ', 'a'.repeat(501)])
    await rejected(main, entry.id, 'archive', { reason }, 400);
  await rejected(main, foreignEntry.id, 'archive', {}, 404, 'ENTRY_NOT_FOUND');
  await rejected(main, entry.id, 'update', { ...fields(entry), actualWeightGrams: 30000 }, 400);

  await drawPreview(light.id);
  await drawPreview(heavy.id);
  const lightBeforeEdit = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: light.id },
  });
  const updated = await mutation(main, entry.id, 'update', proposed);
  assert.deepEqual(updated.response.invalidatedCategoryIds, [light.id]);
  await assertStale(light.id, lightBeforeEdit);
  const storedReceipt = await db.rosterCommand.findUniqueOrThrow({
    where: { id: updated.payload.id },
  });
  const audit = await db.auditEvent.findFirstOrThrow({
    where: { tournamentId: main, entityId: entry.id, action: 'ENTRY_UPDATED' },
  });
  assert.ok(JSON.stringify(audit.payload).includes(entry.lastName));
  assert.ok(JSON.stringify(audit.payload).includes(proposed.lastName));
  assert.ok(JSON.stringify(audit.payload).includes(updated.payload.reason));
  assert.equal(storedReceipt.type, 'ENTRY_UPDATED');
  const unchangedBeforePathReplay = await snapshot(main);
  const differentEntryReplay = await call(
    path(main, original.entries[1].id, 'update'),
    updated.payload,
  );
  assert.equal(differentEntryReplay.status, 409);
  assert.equal(differentEntryReplay.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await snapshot(main), unchangedBeforePathReplay);
  await rejected(main, entry.id, 'archive', { id: updated.payload.id }, 409, 'COMMAND_ID_REUSED');
  await rejected(
    main,
    entry.id,
    'update',
    { ...proposed, id: updated.payload.id, lastName: 'Changed same UUID' },
    409,
    'COMMAND_ID_REUSED',
  );
  await rejected(
    foreign,
    foreignEntry.id,
    'update',
    { ...fields(foreignEntry), id: updated.payload.id },
    409,
    'COMMAND_ID_REUSED',
  );

  await drawPreview(light.id);
  const beforeMoveLight = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: light.id },
  });
  const beforeMoveHeavy = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: heavy.id },
  });
  const moved = await mutation(main, entry.id, 'update', { ...proposed, categoryId: heavy.id });
  assert.deepEqual([...moved.response.invalidatedCategoryIds].sort(), [light.id, heavy.id].sort());
  assert.equal(moved.response.entry.categoryId, heavy.id);
  await assertStale(light.id, beforeMoveLight);
  await assertStale(heavy.id, beforeMoveHeavy);
  await successful(`/tournaments/${main}/publish`, {});
  assert.ok(
    JSON.stringify(await successful(`/public/tournaments/${main}`, undefined, '')).includes(
      proposed.lastName,
    ),
  );
  assert.ok((await participantText(main)).includes(proposed.lastName));
  await drawPreview(heavy.id);
  const beforeArchiveDraw = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: heavy.id },
  });
  const archived = await mutation(main, entry.id, 'archive');
  assert.ok(archived.response.entry.archivedAt);
  assert.deepEqual({ ...archived.response.entry, archivedAt: null }, moved.response.entry);
  await assertStale(heavy.id, beforeArchiveDraw);
  const archivedList = await successful(`/tournaments/${main}/roster/archived`);
  assert.equal(archivedList.entries.length, 1);
  assert.equal(archivedList.entries[0].id, entry.id);
  const active = await successful(`/tournaments/${main}`);
  assert.equal(active.categories.flatMap((category) => category.entries).length, 7);
  assert.ok(
    active.categories.flatMap((category) => category.entries).every((row) => row.id !== entry.id),
  );
  assert.equal(
    (await directory(main)).clubs.find((club) => club.id === secondClub.id)._count.entries,
    0,
  );
  assert.equal(
    JSON.stringify(await successful(`/public/tournaments/${main}`, undefined, '')).includes(
      proposed.lastName,
    ),
    false,
  );
  const hiddenPdf = await participantText(main);
  assert.equal(hiddenPdf.includes(proposed.lastName), false);
  assert.ok(hiddenPdf.includes('Heavy Mate'), 'remaining active participants must stay in the PDF');
  const withoutArchived = await drawPreview(heavy.id);
  assert.equal(JSON.stringify(withoutArchived.snapshot).includes(entry.id), false);
  await rejected(main, entry.id, 'update', fields(moved.response.entry), 409, 'ENTRY_ARCHIVED');
  await rejected(main, entry.id, 'archive', {}, 409, 'ENTRY_ARCHIVED');
  const changedArchivedPreview = await successful(
    path(main, entry.id, 'preview'),
    fields(moved.response.entry, { lastName: 'Change archived original' }),
  );
  assert.equal(changedArchivedPreview.canSave, false);
  assert.ok(changedArchivedPreview.rows[0].errors.includes('RESTORE_ORIGINAL_ONLY'));
  await add(main, firstClub.id, [entrant(heavy.id, proposed.lastName)]);
  const beforeRestorePreview = await snapshot(main);
  const restorePreview = await successful(
    path(main, entry.id, 'preview'),
    fields(moved.response.entry),
  );
  assert.equal(restorePreview.canSave, false);
  assert.ok(restorePreview.rows[0].errors.includes('DUPLICATE_CONFIRMATION_REQUIRED'));
  assert.deepEqual(await snapshot(main), beforeRestorePreview);
  await rejected(
    main,
    entry.id,
    'restore',
    {},
    400,
    'ROSTER_VALIDATION_FAILED',
    'DUPLICATE_CONFIRMATION_REQUIRED',
  );
  const restored = await mutation(main, entry.id, 'restore', { duplicateConfirmed: true });
  assert.equal(restored.response.entry.archivedAt, null);
  assert.deepEqual(restored.response.entry, moved.response.entry);
  await rejected(main, entry.id, 'restore', {}, 409, 'ENTRY_NOT_ARCHIVED');
  const beforeReceiptReplay = await snapshot(main);
  for (const saved of receipts)
    assert.deepEqual(await successful(saved.path, saved.payload), saved.response);
  assert.deepEqual(await snapshot(main), beforeReceiptReplay);

  // Restoring exactly the original roster cannot revive a once-invalidated preview.
  await drawPreview(light.id);
  const originalLightDraw = await db.drawRecord.findUniqueOrThrow({
    where: { categoryId: light.id },
  });
  const lightMate = original.entries[1];
  await mutation(main, lightMate.id, 'archive');
  await mutation(main, lightMate.id, 'restore');
  const stillStale = await db.drawRecord.findUniqueOrThrow({ where: { categoryId: light.id } });
  assert.equal(stillStale.status, 'STALE');
  assert.deepEqual(stillStale.snapshot, originalLightDraw.snapshot);
  const unchangedHashConfirm = await call(`/categories/${light.id}/draw/confirm`, {
    version: stillStale.version,
  });
  assert.equal(unchangedHashConfirm.body.message, 'DRAW_ENTRIES_CHANGED');

  const raceVersion = (await directory(main)).revision;
  const race = await Promise.all([
    call(path(main, original.entries[3].id, 'update'), {
      ...fields(original.entries[3], { lastName: 'Race A' }),
      id: randomUUID(),
      expectedRevision: raceVersion,
      reason: 'Administrator A correction',
    }),
    call(
      path(main, original.entries[4].id, 'update'),
      {
        ...fields(original.entries[4], { lastName: 'Race B' }),
        id: randomUUID(),
        expectedRevision: raceVersion,
        reason: 'Administrator B correction',
      },
      admin,
    ),
  ]);
  assert.deepEqual(race.map((result) => result.status).sort(), [201, 409]);
  assert.equal(race.find((result) => result.status === 409).body.message, 'VERSION_CONFLICT');
  const sameId = {
    ...fields(original.entries[5], { lastName: 'Same UUID retry' }),
    id: randomUUID(),
    expectedRevision: (await directory(main)).revision,
    reason: 'Concurrent identical correction',
  };
  const exact = await Promise.all([
    call(path(main, original.entries[5].id, 'update'), sameId),
    call(path(main, original.entries[5].id, 'update'), sameId),
  ]);
  assert.deepEqual(
    exact.map((result) => result.status),
    [201, 201],
  );
  assert.deepEqual(exact[0].body, exact[1].body);
  assert.equal(await db.rosterCommand.count({ where: { id: sameId.id } }), 1);
  await rejected(
    main,
    original.entries[4].id,
    'archive',
    { expectedRevision: raceVersion },
    409,
    'VERSION_CONFLICT',
  );

  // A defensive reference guard protects even malformed legacy PREVIEW records.
  const previewWithReference = await drawPreview(light.id);
  const reference = await db.contest.create({
    data: {
      drawId: previewWithReference.id,
      key: 'qa-legacy-reference',
      round: 1,
      status: 'WAITING',
      whiteEntryId: lightMate.id,
    },
  });
  await rejected(main, lightMate.id, 'archive', {}, 409, 'ENTRY_IN_DRAW');
  await rejected(main, lightMate.id, 'update', fields(lightMate), 409, 'ENTRY_IN_DRAW');
  await db.entry.update({ where: { id: lightMate.id }, data: { archivedAt: new Date() } });
  await rejected(main, lightMate.id, 'restore', {}, 409, 'ENTRY_IN_DRAW');
  await db.entry.update({ where: { id: lightMate.id }, data: { archivedAt: null } });
  await db.contest.delete({ where: { id: reference.id } });

  const capacityClub = await club(capacity, 'Capacity corrections club');
  const capacityArchiveId = randomUUID();
  await createTestEntries(db, [
    ...Array.from({ length: 127 }, (_, i) => ({
      categoryId: capacityCategory.id,
      firstName: 'Capacity',
      lastName: `Active ${i}`,
      birthYear: 2012,
      gender: 'MALE',
      clubId: capacityClub.id,
      club: capacityClub.name,
    })),
    {
      id: capacityArchiveId,
      categoryId: capacityCategory.id,
      firstName: 'Capacity',
      lastName: 'Archived capacity',
      birthYear: 2012,
      gender: 'MALE',
      clubId: capacityClub.id,
      club: capacityClub.name,
      archivedAt: new Date(),
    },
  ]);
  const capacityLast = await add(capacity, capacityClub.id, [
    entrant(capacityCategory.id, 'Active number 128'),
  ]);
  assert.equal(
    await db.entry.count({ where: { categoryId: capacityCategory.id, archivedAt: null } }),
    128,
  );
  await rejected(
    capacity,
    capacityArchiveId,
    'restore',
    {},
    400,
    'ROSTER_VALIDATION_FAILED',
    'CATEGORY_CAPACITY',
  );
  await mutation(capacity, capacityLast.entries[0].id, 'archive');
  const capacityRestored = await mutation(capacity, capacityArchiveId, 'restore');
  assert.equal(capacityRestored.response.entry.id, capacityArchiveId);
  assert.equal(
    await db.entry.count({ where: { categoryId: capacityCategory.id, archivedAt: null } }),
    128,
  );

  const heavyConfirmedPreview = await drawPreview(heavy.id);
  await successful(`/categories/${heavy.id}/draw/confirm`, {
    version: heavyConfirmedPreview.version,
  });
  await rejected(
    main,
    lightMate.id,
    'update',
    fields(lightMate, { categoryId: heavy.id }),
    400,
    'ROSTER_VALIDATION_FAILED',
    'DRAW_LOCKED',
  );
  const beforeConfirmedGuard = await snapshot(main);
  const lockedArchive = await call(path(main, entry.id, 'archive'), {
    id: randomUUID(),
    expectedRevision: (await directory(main)).revision,
    reason: 'Attempt confirmed archive',
  });
  assert.equal(lockedArchive.status, 409);
  assert.ok(['DRAW_LOCKED', 'ENTRY_IN_DRAW'].includes(lockedArchive.body.message));
  assert.deepEqual(await snapshot(main), beforeConfirmedGuard);
  for (const currentCategory of [light, female]) {
    const draw = await drawPreview(currentCategory.id);
    await successful(`/categories/${currentCategory.id}/draw/confirm`, { version: draw.version });
  }
  await successful(`/tournaments/${main}/start`, {});
  const running = await snapshot(main);
  for (const saved of receipts.filter((saved) => saved.path.includes(`/tournaments/${main}/`)))
    assert.deepEqual(await successful(saved.path, saved.payload), saved.response);
  assert.deepEqual(await snapshot(main), running);
  await rejected(main, entry.id, 'update', fields(restored.response.entry), 409, 'ROSTER_LOCKED');
  await rejected(main, entry.id, 'archive', {}, 409, 'ROSTER_LOCKED');
  const runningPreview = await successful(
    path(main, entry.id, 'preview'),
    fields(restored.response.entry),
  );
  assert.equal(runningPreview.canSave, false);
  assert.ok(runningPreview.rows[0].errors.includes('ROSTER_LOCKED'));
  assert.deepEqual(await snapshot(main), running);
  await correctionConfirmRace('confirm');
  await correctionConfirmRace('correction');
  console.log(
    'PASS: isolated corrections preview/edit/move/archive/restore, stale snapshots, original IDs/receipts/audits, authorization/reasons/shared command namespace, concurrent versions/retries and both correction/confirm lock races, active capacity/public/PDF/draw exclusion, reference/confirmed/start guards.',
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
