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
  for (let i = 0; i < 4; i++)
    await post(`/tournaments/${tournament.id}/categories/${category.id}/entries`, {
      firstName: 'Әлихан',
      lastName: `Сохранение-${i + 1}`,
      club: `Клуб ${(i % 2) + 1}`,
      birthYear: 2014,
    });
  const preview = await post(`/categories/${category.id}/draw/preview`);
  const confirmedDraw = await post(`/categories/${category.id}/draw/confirm`, {
    version: preview.version,
  });
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
