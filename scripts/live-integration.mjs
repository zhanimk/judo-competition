import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import WebSocket from 'ws';
import { createTestUser, useLegacyRules } from './test-user.mjs';
import { tally, scoreboardScores } from '@judo/engine/match';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let operatorId;
let owner,
  outsider,
  tournament,
  cookie = '',
  socket;
const notices = [];
async function call(path, data, auth = cookie) {
  const r = await fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(user) {
  const result = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(
    result.status,
    201,
    `LIVE setup login failed: ${result.body.message ?? result.status}`,
  );
  assert.ok(
    typeof result.cookie === 'string' && /^judo_session=.+$/.test(result.cookie),
    'LIVE setup login must return a session cookie',
  );
  return result.cookie;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function view(mat) {
  return (await call(`/tatamis/${mat}/live`, undefined, '')).body;
}
async function command(mat, id, type, revision, extra = {}, auth = cookie) {
  return call(
    `/tatamis/${mat}/live/${id}/command`,
    { id: randomUUID(), expectedVersion: revision, type, ...extra },
    auth,
  );
}
try {
  owner = await createTestUser(db);
  outsider = await createTestUser(db);
  cookie = await login(owner);
  const foreign = await login(outsider);
  const t = await call('/tournaments', {
    name: 'LIVE QA — Әлихан',
    city: 'Алматы',
    venue: 'Test arena',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 2,
  });
  assert.equal(t.status, 201);
  tournament = t.body.id;
  await useLegacyRules(db, tournament);
  const cat = (
    await call(`/tournaments/${tournament}/categories`, {
      name: 'LIVE U15',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 50000,
      durationSeconds: 180,
    })
  ).body;
  for (let i = 0; i < 4; i++)
    await call(`/tournaments/${tournament}/categories/${cat.id}/entries`, {
      firstName: 'Әлихан',
      lastName: 'Тестовый ' + i,
      club: 'Клуб ' + i,
      birthYear: 2012,
    });
  let d = (await call(`/categories/${cat.id}/draw/preview`, {})).body;
  d = (await call(`/categories/${cat.id}/draw/confirm`, { version: d.version })).body;
  const mats = (await call(`/tournaments/${tournament}/tatamis`)).body;
  const opening = d.contests.filter((c) => c.status === 'READY');
  assert.equal(opening.length, 2);
  for (let i = 0; i < 2; i++) {
    const assigned = await call(`/contests/${opening[i].id}/assign`, {
      id: randomUUID(),
      expectedRevision: opening[i].revision,
      tatamiId: mats[0].id,
    });
    assert.equal(assigned.status, 201);
    opening[i] = { ...opening[i], ...assigned.body };
  }
  assert.equal(
    (
      await call(`/contests/${opening[1].id}/assign`, {
        id: randomUUID(),
        expectedRevision: opening[1].revision,
        tatamiId: mats[1].id,
      })
    ).body.message,
    'CATEGORY_TATAMI_LOCKED',
  );
  const impact = (await call(`/tournaments/${tournament}/control/${opening[1].id}/impact`)).body;
  assert.equal(
    (
      await call(`/tournaments/${tournament}/control/${opening[1].id}/command`, {
        id: randomUUID(),
        expectedRevision: impact.revision,
        type: 'MOVE',
        tatamiId: mats[1].id,
        reason: 'QA deliberate one-bout move',
        impactToken: impact.impactToken,
      })
    ).status,
    201,
  );
  const url = new URL(`${base}/live`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('tournamentId', tournament);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: 'http://127.0.0.1:4318' });
    ws.on('open', () => {
      ws.close();
      reject(new Error('private WS allowed'));
    });
    ws.on('error', resolve);
  });
  await call(`/tournaments/${tournament}/publish`, {});
  await call(`/categories/${cat.id}/draw/publication`, { published: true, expectedRevision: 0 });
  socket = new WebSocket(url, { origin: 'http://127.0.0.1:4318' });
  socket.on('message', (v) => notices.push(JSON.parse(v.toString())));
  await new Promise((r, j) => {
    socket.on('open', r);
    socket.on('error', j);
  });
  const m0 = mats[0].id,
    m1 = mats[1].id,
    a = opening[0].id,
    b = opening[1].id;
  const aRevision = opening[0].revision,
    bRevision = (await db.contest.findUniqueOrThrow({ where: { id: b } })).revision;
  assert.equal((await command(m0, a, 'START', aRevision, {}, '')).status, 401);
  assert.equal((await command(m0, a, 'START', aRevision, {}, foreign)).status, 403);
  assert.equal((await command(m1, a, 'START', aRevision)).status, 404);
  const invite = await call(`/auth/tatamis/${m0}/invitations`, {
    label: 'LIVE QA operator',
    hours: 1,
  });
  const accepted = await call(
    '/auth/invitations/accept',
    { token: invite.body.token, name: 'LIVE QA operator' },
    '',
  );
  const op = accepted.cookie;
  operatorId = (await call('/auth/me', undefined, op)).body.id;
  assert.equal((await command(m1, b, 'START', bRevision, {}, op)).status, 403);
  assert.equal(
    (await command(m0, a, 'START', aRevision, {}, op)).body.message,
    'TOURNAMENT_NOT_STARTED',
  );
  assert.equal((await call(`/tournaments/${tournament}/start`, {}, op)).status, 403);
  const startTournament = await Promise.all([
    call(`/tournaments/${tournament}/start`, {}),
    call(`/tournaments/${tournament}/start`, {}),
  ]);
  assert.deepEqual(
    startTournament.map((r) => r.status),
    [201, 201],
  );
  assert.equal(
    await db.auditEvent.count({
      where: { tournamentId: tournament, action: 'TOURNAMENT_STARTED' },
    }),
    1,
  );
  const starts = await Promise.all([
    command(m0, a, 'START', aRevision, {}, op),
    command(m1, b, 'START', bRevision),
  ]);
  assert.deepEqual(
    starts.map((r) => r.status),
    [201, 201],
  );
  await call(`/auth/invitations/${invite.body.id}/revoke`, {});
  const startedRevision = starts[0].body.revision;
  assert.equal(
    (await command(m0, a, 'AWARD', startedRevision, { side: 'WHITE', kind: 'YUKO' }, op)).status,
    401,
  );
  assert.equal(await db.contest.count({ where: { drawId: d.id, status: 'ACTIVE' } }), 2);
  let live = await view(m0);
  for (let attempt = 0; attempt < 30 && live.currentMatch.state.elapsedMs < 400; attempt++) {
    await delay(100);
    live = await view(m0);
  }
  assert.ok(live.currentMatch.state.elapsedMs >= 400);
  assert.equal(live.currentMatch.revision, startedRevision);
  assert.equal((await command(m0, a, 'ADVANCE', startedRevision, { ms: 100000 })).status, 400);
  assert.equal(
    (await command(m0, a, 'AWARD', startedRevision - 1, { side: 'WHITE', kind: 'YUKO' })).status,
    409,
  );
  const payload = {
    id: randomUUID(),
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
    expectedVersion: startedRevision,
  };
  const repeated = await Promise.all([
    call(`/tatamis/${m0}/live/${a}/command`, payload),
    call(`/tatamis/${m0}/live/${a}/command`, payload),
  ]);
  assert.deepEqual(
    repeated.map((r) => r.status),
    [201, 201],
  );
  assert.equal((await view(m0)).currentMatch.state.awards.length, 1);
  assert.equal(await db.matchEvent.count({ where: { id: payload.id } }), 1);
  assert.equal(
    (await call(`/tatamis/${m0}/live/${a}/command`, { ...payload, side: 'BLUE' })).status,
    409,
  );
  let r = await command(m0, a, 'REVOKE', repeated[0].body.revision, { awardId: payload.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.state.status, 'PAUSED');
  r = await command(m0, a, 'START', r.body.revision);
  assert.equal(r.status, 201);
  // Simulate another server epoch only on this disposable fixture, without restarting the user's API.
  await db.contest.update({ where: { id: a }, data: { clockEpoch: 'previous-process' } });
  await delay(700);
  live = await view(m0);
  assert.equal(live.currentMatch.state.status, 'PAUSED');
  assert.equal(
    await db.matchEvent.count({ where: { contestId: a, type: 'CLOCK_RECOVERY_PAUSED' } }),
    1,
  );
  r = await command(m0, a, 'START', live.currentMatch.revision);
  assert.equal(r.status, 201);
  r = await command(m0, a, 'HOLD', r.body.revision, { side: 'WHITE' });
  assert.equal(r.status, 201);
  // Observe actual server ticks through the anonymous spectator endpoint.
  // No TOKETA/manual award: scores must appear while the hold is still running.
  for (const [kind, expectedStatus] of [
    ['YUKO', 'RUNNING'],
    ['WAZA_ARI', 'RUNNING'],
    ['IPPON', 'PROVISIONAL'],
  ]) {
    const deadline = Date.now() + 13000;
    do {
      await delay(100);
      live = await view(m0);
    } while (tally(live.currentMatch.state, 'WHITE')[kind] !== 1 && Date.now() < deadline);
    const state = live.currentMatch.state;
    assert.deepEqual(tally(state, 'WHITE'), {
      YUKO: kind === 'YUKO' ? 1 : 0,
      WAZA_ARI: kind === 'WAZA_ARI' ? 1 : 0,
      IPPON: kind === 'IPPON' ? 1 : 0,
      SHIDO: 0,
    });
    assert.equal(state.status, expectedStatus);
    assert.equal(Boolean(state.hold), expectedStatus === 'RUNNING');
    assert.equal(live.currentMatch.revision, r.body.revision);
  }
  assert.equal(live.currentMatch.state.outcome.reason, 'IPPON');
  assert.equal(
    await db.matchEvent.count({ where: { contestId: a, type: 'HOLD_SCORE_UPDATED' } }),
    3,
  );
  assert.equal(live.currentMatch.state.awards.filter((award) => award.active).length, 1);
  const confirmation = { id: randomUUID(), expectedVersion: r.body.revision, type: 'CONFIRM' };
  assert.equal((await call(`/tatamis/${m0}/live/${a}/command`, confirmation)).status, 201);
  assert.equal((await call(`/tatamis/${m0}/live/${a}/command`, confirmation)).status, 201);
  assert.equal((await view(m0)).currentMatch, null);
  assert.equal(
    (await command(m0, a, 'AWARD', r.body.revision + 1, { side: 'BLUE', kind: 'IPPON' })).status,
    409,
  );
  let rev = starts[1].body.revision;
  for (let i = 0; i < 3; i++) {
    r = await command(m1, b, 'AWARD', rev, { side: 'BLUE', kind: 'SHIDO' });
    assert.equal(r.status, 201);
    rev = r.body.revision;
  }
  assert.equal(r.body.state.outcome.reason, 'ACCUMULATED_SHIDO');
  const shidoView = await view(m1);
  assert.equal(scoreboardScores(shidoView.currentMatch.state, 'WHITE').IPPON, 1);
  assert.equal(scoreboardScores(shidoView.currentMatch.state, 'BLUE').SHIDO, 3);
  assert.equal((await command(m1, b, 'CONFIRM', rev)).status, 201);
  d = (await call(`/categories/${cat.id}/draw`)).body.draw;
  const final = d.contests.find((c) => c.round === 2);
  const shidoResult = d.contests.find((c) => c.id === b);
  assert.equal(shidoResult.resultReason, 'ACCUMULATED_SHIDO');
  assert.equal(scoreboardScores(shidoResult.state, 'WHITE').IPPON, 1);
  assert.equal(final.status, 'READY');
  assert.equal(final.tatamiId, m0);
  assert.ok(final.whiteEntryId && final.blueEntryId);
  assert.equal(
    (await command(m0, final.id, 'START', final.revision)).body.message,
    'REST_REQUIRED',
  );
  // Advance only the disposable fixture's rest eligibility, never the live clock.
  await db.contest.updateMany({
    where: { drawId: d.id, status: 'CONFIRMED' },
    data: { confirmedAt: new Date(Date.now() - 601000) },
  });
  r = await command(m0, final.id, 'START', final.revision);
  assert.equal(r.status, 201);
  r = await command(m0, final.id, 'AWARD', r.body.revision, { side: 'BLUE', kind: 'IPPON' });
  assert.equal(r.status, 201);
  r = await command(m0, final.id, 'CONFIRM', r.body.revision);
  assert.equal(r.status, 201);
  const pub = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(pub.categories[0].draw.contests.filter((c) => c.status === 'CONFIRMED').length, 3);
  assert.equal(pub.tatamis.flatMap((m) => m.queue).length, 0);
  assert.ok(notices.some((e) => e.kind === 'result'));
  assert.ok(notices.some((e) => e.kind === 'state'));
  const pdf = await fetch(base + `/tournaments/${tournament}/protocol.pdf?lang=kk`, {
    headers: { Cookie: cookie },
  });
  assert.equal(pdf.status, 200);
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/live-results-kk.pdf', Buffer.from(await pdf.arrayBuffer()));
  console.log(
    'PASS: two live tatamis, automatic 5/10/20-second hold upgrades and audit, timer checkpoints, authorized commands, idempotency/reuse/stale revision, correction, restart pause, third Shido, confirmed-result lock, automatic final and queue, rest, public results, WebSocket notices and results PDF.',
  );
} finally {
  socket?.close();
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.category.deleteMany({ where: { tournamentId: tournament } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament } });
    await db.tournament.delete({ where: { id: tournament } });
  }
  if (operatorId) await db.user.delete({ where: { id: operatorId } });
  for (const u of [owner, outsider]) if (u) await db.user.delete({ where: { id: u.id } });
  await db.$disconnect();
}
