import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createTestUser, useLegacyRules } from './test-user.mjs';
import { scoreboardScores } from '@judo/engine/match';

/** Only called with the runner's disposable database and dedicated API process. */
export async function persistenceScenario({ db, base, restart, output }) {
  const owner = await createTestUser(db);
  let cookie = '';
  async function call(path, data, auth = cookie) {
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(
      response.status,
      data === undefined ? 200 : 201,
      `${path}: ${await response.clone().text()}`,
    );
    return {
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  const post = async (path, data = {}) => (await call(path, data)).body;
  const get = async (path, auth) => (await call(path, undefined, auth)).body;
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password })).cookie;
  const tournament = await post('/tournaments', {
    name: 'СОХРАНЕНИЕ QA — аварийный перезапуск',
    city: 'Алматы',
    venue: 'Изолированный стенд',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 1,
  });
  await useLegacyRules(db, tournament.id);
  const category = await post(`/tournaments/${tournament.id}/categories`, {
    name: 'U13 −34 кг',
    gender: 'MALE',
    birthYearFrom: 2014,
    birthYearTo: 2015,
    maxWeightGrams: 34000,
    durationSeconds: 180,
    format: 'SINGLE_ELIMINATION',
  });
  const rosterCommands = [];
  let rosterRevision = 0;
  for (let clubIndex = 0; clubIndex < 2; clubIndex++) {
    const clubPath = `/tournaments/${tournament.id}/clubs`;
    const clubPayload = {
      id: randomUUID(),
      expectedRevision: rosterRevision,
      name: `Клуб ${clubIndex + 1}`,
    };
    const clubResponse = await post(clubPath, clubPayload);
    rosterRevision = clubResponse.revision;
    rosterCommands.push({ path: clubPath, payload: clubPayload, response: clubResponse });
    const rosterPath = `/tournaments/${tournament.id}/roster`;
    const rosterPayload = {
      id: randomUUID(),
      expectedRevision: rosterRevision,
      clubId: clubResponse.club.id,
      entries: [clubIndex, clubIndex + 2].map((index) => ({
        firstName: 'Әлихан',
        lastName: `Сохранение-${index + 1}`,
        birthYear: 2014,
        gender: 'MALE',
        categoryId: category.id,
      })),
    };
    const rosterResponse = await post(rosterPath, rosterPayload);
    rosterRevision = rosterResponse.revision;
    rosterCommands.push({ path: rosterPath, payload: rosterPayload, response: rosterResponse });
  }
  let savedRosterEntries = await db.entry.findMany({
    where: { categoryId: category.id },
    orderBy: { id: 'asc' },
  });
  assert.equal(savedRosterEntries.length, 4);
  assert.equal(new Set(savedRosterEntries.map((entry) => entry.id)).size, 4);
  for (let index = 0; index < 4; index++)
    assert.equal(
      savedRosterEntries.find((entry) => entry.lastName === `Сохранение-${index + 1}`).club,
      `Клуб ${(index % 2) + 1}`,
    );
  const corrected = savedRosterEntries.find((entry) => entry.lastName === 'Сохранение-1');
  const correctionFields = {
    clubId: corrected.clubId,
    firstName: corrected.firstName,
    lastName: 'Сохранение-1 исправлено',
    birthYear: corrected.birthYear,
    gender: corrected.gender,
    categoryId: corrected.categoryId,
  };
  for (const action of ['update', 'archive', 'restore']) {
    const path = `/tournaments/${tournament.id}/roster/entries/${corrected.id}/${action}`;
    const payload = {
      id: randomUUID(),
      expectedRevision: rosterRevision,
      reason: 'Проверка сохранности исправления после аварии',
      ...(action === 'update' ? correctionFields : {}),
    };
    const response = await post(path, payload);
    assert.equal(response.entry.id, corrected.id);
    assert.equal(response.revision, rosterRevision + 1);
    if (action === 'archive') assert.ok(response.entry.archivedAt);
    else assert.equal(response.entry.archivedAt, null);
    rosterRevision = response.revision;
    rosterCommands.push({ path, payload, response });
  }
  // Keep a fifth original registration archived, so the checkpoint verifies both
  // the retained archive row and its exclusion from the four-person draw.
  const archiveAdmissionPath = `/tournaments/${tournament.id}/roster`;
  const archiveAdmissionPayload = {
    id: randomUUID(),
    expectedRevision: rosterRevision,
    clubId: corrected.clubId,
    entries: [
      {
        firstName: correctionFields.firstName,
        lastName: 'Архивная заявка',
        birthYear: correctionFields.birthYear,
        gender: correctionFields.gender,
        categoryId: correctionFields.categoryId,
      },
    ],
  };
  const archiveAdmissionResponse = await post(archiveAdmissionPath, archiveAdmissionPayload);
  rosterRevision = archiveAdmissionResponse.revision;
  rosterCommands.push({
    path: archiveAdmissionPath,
    payload: archiveAdmissionPayload,
    response: archiveAdmissionResponse,
  });
  const archivedEntryId = archiveAdmissionResponse.entries[0].id;
  const archivePath = `/tournaments/${tournament.id}/roster/entries/${archivedEntryId}/archive`;
  const archivePayload = {
    id: randomUUID(),
    expectedRevision: rosterRevision,
    reason: 'Архив сохраняется после аварийного перезапуска',
  };
  const archiveResponse = await post(archivePath, archivePayload);
  rosterRevision = archiveResponse.revision;
  assert.ok(archiveResponse.entry.archivedAt);
  rosterCommands.push({ path: archivePath, payload: archivePayload, response: archiveResponse });
  savedRosterEntries = await db.entry.findMany({
    where: { categoryId: category.id },
    orderBy: { id: 'asc' },
  });
  assert.equal(savedRosterEntries.length, 5);
  assert.equal(savedRosterEntries.filter((entry) => entry.archivedAt === null).length, 4);
  assert.equal(
    savedRosterEntries.find((entry) => entry.id === corrected.id).lastName,
    correctionFields.lastName,
  );
  const readRosterAudit = () =>
    db.auditEvent.findMany({
      where: {
        tournamentId: tournament.id,
        action: {
          in: ['CLUB_CREATED', 'ROSTER_ADDED', 'ENTRY_UPDATED', 'ENTRY_ARCHIVED', 'ENTRY_RESTORED'],
        },
      },
      orderBy: { id: 'asc' },
    });
  const savedRosterAudit = await readRosterAudit();
  assert.equal(savedRosterAudit.length, rosterCommands.length);
  const preview = await post(`/categories/${category.id}/draw/preview`);
  const confirmedDraw = await post(`/categories/${category.id}/draw/confirm`, {
    version: preview.version,
  });
  assert.equal(JSON.stringify(confirmedDraw.snapshot).includes(archivedEntryId), false);
  await post(`/categories/${category.id}/draw/publication`, {
    published: true,
    expectedRevision: 0,
  });
  await post(`/tournaments/${tournament.id}/publish`);
  const [mat] = await get(`/tournaments/${tournament.id}/tatamis`);
  const opening = confirmedDraw.contests.find((contest) => contest.status === 'READY');
  const assignment = {
    id: randomUUID(),
    expectedRevision: opening.revision,
    tatamiId: mat.id,
  };
  const assignmentPath = `/contests/${opening.id}/assign`;
  const assignmentResponse = await post(assignmentPath, assignment);
  await post(`/tournaments/${tournament.id}/start`);
  const live = async () => get(`/tatamis/${mat.id}/live`, '');
  const queue = async () => (await get(`/tournaments/${tournament.id}/tatamis/${mat.id}`)).queue;
  async function command(contestId, type, extra = {}) {
    const row = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
    return post(`/tatamis/${mat.id}/live/${contestId}/command`, {
      id: randomUUID(),
      expectedVersion: row.revision,
      type,
      ...extra,
    });
  }
  const first = (await queue())[0];
  await command(first.id, 'START');
  await command(first.id, 'AWARD', { side: 'WHITE', kind: 'YUKO' });
  await command(first.id, 'AWARD', { side: 'BLUE', kind: 'SHIDO' });
  await command(first.id, 'HOLD', { side: 'BLUE' });
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline && !(await live()).currentMatch.state.hold?.awardId)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(scoreboardScores((await live()).currentMatch.state, 'BLUE').YUKO, 1);
  await restart({
    crash: true,
    beforeStart: async () => {
      // Read the last committed checkpoint after the process has actually stopped.
      const row = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(row.state.status, 'RUNNING');
      assert.equal(row.state.hold.side, 'BLUE');
      await writeFile(`${output}/checkpoint.json`, JSON.stringify(row.state, null, 2));
      const expected = structuredClone(row.state);
      await db.$disconnect();
      // A new DB connection must see the same committed state.
      assert.deepEqual(
        (await db.contest.findUniqueOrThrow({ where: { id: first.id } })).state,
        expected,
      );
    },
  });
  const saved = JSON.parse(await readFile(`${output}/checkpoint.json`, 'utf8'));
  let restored = (await live()).currentMatch.state;
  assert.deepEqual(restored, { ...saved, status: 'PAUSED' });
  assert.equal((await get('/auth/me')).id, owner.id, 'session survives a process restart');
  const beforeRosterRetry = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
  const lockedTournament = await db.tournament.findUniqueOrThrow({
    where: { id: tournament.id },
  });
  assert.equal(lockedTournament.status, 'RUNNING');
  assert.equal(lockedTournament.rosterRevision, rosterRevision);
  for (const command of rosterCommands) {
    assert.deepEqual(
      await post(command.path, command.payload),
      command.response,
      'roster/correction retry after crash returns its original receipt despite roster lock',
    );
    assert.equal(await db.rosterCommand.count({ where: { id: command.payload.id } }), 1);
  }
  assert.deepEqual(
    await db.entry.findMany({ where: { categoryId: category.id }, orderBy: { id: 'asc' } }),
    savedRosterEntries,
    'roster/correction retry must preserve four active entries and the original archived row/IDs',
  );
  assert.equal(
    await db.rosterCommand.count({ where: { tournamentId: tournament.id } }),
    rosterCommands.length,
  );
  assert.deepEqual(await readRosterAudit(), savedRosterAudit);
  const recoveredArchived = await get(`/tournaments/${tournament.id}/roster/archived`);
  assert.equal(recoveredArchived.entries.length, 1);
  assert.equal(recoveredArchived.entries[0].id, archivedEntryId);
  assert.equal(recoveredArchived.entries[0].archivedAt, archiveResponse.entry.archivedAt);
  assert.equal((await get(`/tournaments/${tournament.id}`)).categories[0].entries.length, 4);
  assert.deepEqual(
    await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } }),
    lockedTournament,
    'club/roster retry cannot increment the current roster revision',
  );
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: first.id } }),
    beforeRosterRetry,
    'club/roster retry cannot modify the active contest state or clock',
  );
  const beforeAssignmentRetry = await db.contest.findUniqueOrThrow({ where: { id: opening.id } });
  assert.equal(beforeAssignmentRetry.status, 'ACTIVE');
  assert.deepEqual(await post(assignmentPath, assignment), assignmentResponse);
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: opening.id } }),
    beforeAssignmentRetry,
    'assignment retry after crash must not rewrite an active bout or its clock',
  );
  assert.equal(await db.matchEvent.count({ where: { id: assignment.id } }), 1);
  assert.equal(
    await db.auditEvent.count({
      where: { entityId: opening.id, action: 'MATCH_ASSIGNED', tournamentId: tournament.id },
    }),
    1,
  );
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual((await live()).currentMatch.state, restored, 'recovered timer stays paused');
  assert.equal(
    await db.matchEvent.count({ where: { contestId: first.id, type: 'CLOCK_RECOVERY_PAUSED' } }),
    1,
  );
  await command(first.id, 'START');
  await command(first.id, 'TOKETA');
  assert.equal(
    scoreboardScores((await live()).currentMatch.state, 'BLUE').YUKO,
    1,
    'TOKETA cannot duplicate recovered hold score',
  );
  await command(first.id, 'AWARD', { side: 'WHITE', kind: 'IPPON' });
  const beforeConfirm = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
  const confirmation = {
    id: randomUUID(),
    type: 'CONFIRM',
    expectedVersion: beforeConfirm.revision,
  };
  const confirmPath = `/tatamis/${mat.id}/live/${first.id}/command`;
  await post(confirmPath, confirmation);
  const confirmed = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(confirmed.status, 'CONFIRMED');
  const drawBefore = await get(`/categories/${category.id}/draw`);
  await restart({ crash: true });
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: first.id } }), confirmed);
  assert.deepEqual(await get(`/categories/${category.id}/draw`), drawBefore);
  // A lost response can be retried after restarting without applying the result twice.
  await post(confirmPath, confirmation);
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: first.id } }), confirmed);
  assert.equal(await db.matchEvent.count({ where: { id: confirmation.id } }), 1);
  assert.equal((await live()).currentMatch, null);
  const second = (await queue())[0];
  await command(second.id, 'START');
  for (let i = 0; i < 3; i++) await command(second.id, 'AWARD', { side: 'BLUE', kind: 'SHIDO' });
  assert.equal(scoreboardScores((await live()).currentMatch.state, 'WHITE').IPPON, 1);
  await command(second.id, 'CONFIRM');
  await db.contest.updateMany({
    where: { drawId: confirmed.drawId, status: 'CONFIRMED' },
    data: { confirmedAt: new Date(Date.now() - 601000) },
  });
  const final = (await queue())[0];
  await command(final.id, 'START');
  await command(final.id, 'AWARD', { side: 'BLUE', kind: 'IPPON' });
  await command(final.id, 'CONFIRM');
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } })).status,
    'FINISHED',
  );
  const results = await get(`/public/tournaments/${tournament.id}`, '');
  assert.equal(
    results.categories[0].draw.contests.filter((c) => c.status === 'CONFIRMED').length,
    3,
  );
  await restart({ crash: false });
  assert.deepEqual(await get(`/public/tournaments/${tournament.id}`, ''), results);
  const pdf = await fetch(`${base}/tournaments/${tournament.id}/protocol.pdf?kind=DRAW&lang=kk`, {
    headers: { Cookie: cookie },
  });
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  await writeFile(`${output}/persistence-results-kk.pdf`, bytes);
  return {
    tournamentId: tournament.id,
    confirmedBouts: 3,
    crashRestarts: 2,
    gracefulRestarts: 1,
    checks: [
      'running hold checkpoint',
      'fresh DB connection',
      'paused clock recovery',
      'session recovery',
      'club/roster retry after crash without duplicate entries or audit',
      'update/archive/restore original receipts and archived row after crash',
      'assignment retry after crash without clock or audit changes',
      'hold without duplication',
      'confirmed result and draw recovery',
      'confirmation retry after crash',
      'third shido ippon',
      'completed tournament public results',
      'PDF after restart',
    ],
  };
}
