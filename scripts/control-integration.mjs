import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '@judo/engine/match';
import { PrismaClient } from '@prisma/client';
import { createTestUser, useLegacyRules } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let owner,
  outsider,
  tournament,
  operator,
  cookie = '';
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
async function post(path, data = {}) {
  const r = await call(path, data);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function row(id) {
  return db.contest.findUniqueOrThrow({ where: { id } });
}
async function sporting(id, type, extra = {}) {
  const c = await row(id);
  return post(`/tatamis/${c.tatamiId}/live/${id}/command`, {
    id: randomUUID(),
    type,
    expectedVersion: c.revision,
    ...extra,
  });
}
async function adminPayload(id, type, extra = {}) {
  const p = (await call(`/tournaments/${tournament}/control/${id}/impact`)).body;
  return {
    id: randomUUID(),
    type,
    expectedRevision: p.revision,
    impactToken: p.impactToken,
    reason: 'QA correction',
    ...extra,
  };
}
async function admin(id, type, extra = {}) {
  return post(
    `/tournaments/${tournament}/control/${id}/command`,
    await adminPayload(id, type, extra),
  );
}
try {
  owner = await createTestUser(db);
  outsider = await createTestUser(db);
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password })).cookie;
  const foreign = (
    await call('/auth/login', { email: outsider.email, password: outsider.password })
  ).cookie;
  tournament = (
    await post('/tournaments', {
      name: 'CONTROL QA',
      city: 'Алматы',
      venue: 'Test arena',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 3,
    })
  ).id;
  await useLegacyRules(db, tournament);
  const cat = await post(`/tournaments/${tournament}/categories`, {
    name: 'Control U15',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
  });
  for (let i = 0; i < 4; i++)
    await post(`/tournaments/${tournament}/categories/${cat.id}/entries`, {
      firstName: 'Әлихан',
      lastName: 'Control ' + i,
      birthYear: 2012,
      club: 'Клуб ' + i,
    });
  let d = await post(`/categories/${cat.id}/draw/preview`);
  d = await post(`/categories/${cat.id}/draw/confirm`, { version: d.version });
  await post(`/tournaments/${tournament}/publish`);
  const publicDraw = async () =>
    (await call(`/public/tournaments/${tournament}`, undefined, '')).body.categories[0].draw;
  assert.equal(await publicDraw(), null);
  assert.equal(
    (
      await call(
        `/categories/${cat.id}/draw/publication`,
        { published: true, expectedRevision: 0 },
        foreign,
      )
    ).status,
    403,
  );
  await post(`/categories/${cat.id}/draw/publication`, { published: true, expectedRevision: 0 });
  assert.ok(await publicDraw());
  await post(`/categories/${cat.id}/draw/publication`, { published: false, expectedRevision: 1 });
  assert.equal(await publicDraw(), null);
  assert.equal(
    (await call(`/categories/${cat.id}/draw/publication`, { published: true, expectedRevision: 0 }))
      .body.message,
    'PUBLICATION_STALE',
  );
  await post(`/categories/${cat.id}/draw/publication`, { published: true, expectedRevision: 2 });
  await post(`/tournaments/${tournament}/start`);
  const mats = (await call(`/tournaments/${tournament}/tatamis`)).body;
  const a = d.contests.filter((c) => c.round === 1)[0].id,
    b = d.contests.filter((c) => c.round === 1)[1].id,
    final = d.contests.find((c) => c.round === 2).id;
  assert.equal((await call(`/tournaments/${tournament}/control`, undefined, '')).status, 401);
  assert.equal((await call(`/tournaments/${tournament}/control`, undefined, foreign)).status, 403);
  const invite = await post(`/auth/tatamis/${mats[0].id}/invitations`, {
    label: 'QA control operator',
    hours: 1,
  });
  const accepted = await call(
    '/auth/invitations/accept',
    { token: invite.token, name: 'QA control operator' },
    '',
  );
  operator = (await call('/auth/me', undefined, accepted.cookie)).body.id;
  assert.equal(
    (await call(`/tournaments/${tournament}/control`, undefined, accepted.cookie)).status,
    403,
  );
  const move = await adminPayload(b, 'MOVE', { tatamiId: mats[1].id });
  assert.equal(
    (await call(`/tournaments/${tournament}/control/${b}/command`, move, accepted.cookie)).status,
    403,
  );
  await post(`/tournaments/${tournament}/control/${b}/command`, move);
  await post(`/tournaments/${tournament}/control/${b}/command`, move);
  assert.equal((await row(b)).revision, move.expectedRevision + 1);
  assert.equal(await db.matchEvent.count({ where: { id: move.id } }), 1);
  assert.equal(
    (await call(`/tournaments/${tournament}/control/${b}/command`, { ...move, reason: 'changed' }))
      .body.message,
    'COMMAND_ID_REUSED',
  );
  const movedDashboard = (await call(`/tournaments/${tournament}/control`)).body;
  assert.ok(movedDashboard.tatamis.find((m) => m.id === mats[1].id).queue.some((c) => c.id === b));
  assert.ok(!movedDashboard.tatamis.find((m) => m.id === mats[0].id).queue.some((c) => c.id === b));
  const publicMoved = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  assert.equal(
    publicMoved.categories[0].draw.contests.find((c) => c.id === b).tatamiId,
    mats[1].id,
  );
  await admin(a, 'REMOVE');
  assert.equal((await row(a)).tatamiId, null);
  await admin(a, 'MOVE', { tatamiId: mats[0].id });
  await sporting(a, 'START');
  await sporting(b, 'START');
  await sporting(a, 'STOP');
  const paused = (await row(a)).state;
  assert.equal(
    (
      await call(
        `/tournaments/${tournament}/control/${a}/command`,
        await adminPayload(a, 'MOVE', { tatamiId: mats[1].id }),
      )
    ).body.message,
    'TATAMI_BUSY',
  );
  await admin(a, 'MOVE', { tatamiId: mats[2].id });
  assert.deepEqual((await row(a)).state, paused, 'moving a paused bout preserves its full state');
  const movedLive = (await call(`/tournaments/${tournament}/control`)).body;
  assert.equal(movedLive.tatamis.find((m) => m.id === mats[0].id).live.currentMatch, null);
  assert.equal(movedLive.tatamis.find((m) => m.id === mats[2].id).live.currentMatch.id, a);
  await admin(a, 'MOVE', { tatamiId: mats[0].id });
  await sporting(b, 'STOP');
  const offlineSession = randomUUID();
  const openPayload = {
    id: randomUUID(),
    type: 'OFFLINE_OPEN',
    sessionId: offlineSession,
    expectedVersion: (await row(a)).revision,
  };
  const openResult = await post(`/tatamis/${mats[0].id}/live/${a}/command`, openPayload);
  await post(`/tatamis/${mats[0].id}/live/${a}/command`, openPayload);
  assert.equal((await row(a)).revision, openResult.revision);
  assert.equal(
    (
      await call(`/tatamis/${mats[0].id}/live/${a}/command`, {
        id: randomUUID(),
        type: 'START',
        expectedVersion: openResult.revision,
      })
    ).body.message,
    'OFFLINE_OWNED',
  );
  let local = openResult.state;
  const events = [];
  const localAction = (action) => {
    const c = { ...action, id: randomUUID(), expectedVersion: local.version };
    local = applyCommand(local, c);
    local.receipts = {};
    events.push(c);
  };
  localAction({ type: 'START' });
  localAction({ type: 'ADVANCE', ms: 1000 });
  localAction({ type: 'HOLD', side: 'WHITE' });
  localAction({ type: 'ADVANCE', ms: 5000 });
  assert.equal(local.awards.filter((v) => v.active && v.kind === 'YUKO').length, 1);
  localAction({ type: 'RECOVER' });
  assert.equal(local.status, 'PAUSED');
  assert.equal(local.hold.elapsedMs, 5000);
  localAction({ type: 'START' });
  localAction({ type: 'ADVANCE', ms: 5000 });
  assert.equal(local.awards.filter((v) => v.active && v.kind === 'WAZA_ARI').length, 1);
  localAction({ type: 'TOKETA' });
  localAction({ type: 'STOP' });
  const batch = {
    id: randomUUID(),
    type: 'OFFLINE_SYNC',
    sessionId: offlineSession,
    expectedVersion: openResult.revision,
    events,
  };
  const synced = await post(`/tatamis/${mats[0].id}/live/${a}/command`, batch);
  assert.deepEqual(synced.state, local);
  assert.deepEqual(await post(`/tatamis/${mats[0].id}/live/${a}/command`, batch), synced);
  assert.equal((await row(a)).revision, synced.revision);
  assert.equal(
    await db.matchEvent.count({ where: { contestId: a, type: 'OFFLINE_EVENT' } }),
    events.length,
  );
  const nextEvents = [];
  for (const type of ['START', 'STOP']) {
    const event = { id: randomUUID(), expectedVersion: local.version, type };
    local = applyCommand(local, event);
    local.receipts = {};
    nextEvents.push(event);
  }
  const checkpoint = await post(`/tatamis/${mats[0].id}/live/${a}/command`, {
    ...batch,
    id: randomUUID(),
    expectedVersion: synced.revision,
    events: nextEvents,
  });
  assert.deepEqual(checkpoint.state, local);
  assert.deepEqual(await post(`/tatamis/${mats[0].id}/live/${a}/command`, batch), synced);
  assert.equal((await row(a)).revision, checkpoint.revision);
  const repeatedEvent = {
    ...events[1],
    expectedVersion: checkpoint.state.version,
  };
  const duplicateBatch = {
    ...batch,
    id: randomUUID(),
    expectedVersion: checkpoint.revision,
    events: [repeatedEvent],
  };
  assert.equal(
    (await call(`/tatamis/${mats[0].id}/live/${a}/command`, duplicateBatch)).body.message,
    'COMMAND_ID_REUSED',
  );
  const nestedId = randomUUID();
  assert.equal(
    (
      await call(`/tatamis/${mats[0].id}/live/${a}/command`, {
        ...duplicateBatch,
        id: randomUUID(),
        events: [
          { id: nestedId, expectedVersion: checkpoint.state.version, type: 'START' },
          { id: nestedId, expectedVersion: checkpoint.state.version + 1, type: 'STOP' },
        ],
      })
    ).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.equal((await row(a)).revision, checkpoint.revision);
  assert.deepEqual((await row(a)).state, checkpoint.state);
  const beforeRejectedPacket = await row(a);
  const eventsBeforeRejectedPacket = await db.matchEvent.count({ where: { contestId: a } });
  assert.equal(
    (
      await call(`/tatamis/${mats[0].id}/live/${a}/command`, {
        ...duplicateBatch,
        id: randomUUID(),
        events: [
          {
            id: randomUUID(),
            expectedVersion: checkpoint.state.version,
            type: 'AWARD',
            side: 'BLUE',
            kind: 'YUKO',
          },
          { id: randomUUID(), expectedVersion: checkpoint.state.version + 2, type: 'START' },
        ],
      })
    ).body.message,
    'VERSION_CONFLICT',
  );
  assert.deepEqual(await row(a), beforeRejectedPacket);
  assert.equal(await db.matchEvent.count({ where: { contestId: a } }), eventsBeforeRejectedPacket);
  // Exercise compatibility with real pre-upgrade JSON packets in this disposable fixture.
  await db.matchEvent.deleteMany({ where: { id: events[1].id } });
  await db.matchEvent.update({ where: { id: batch.id }, data: { payload: batch } });
  assert.equal(
    (await call(`/tatamis/${mats[0].id}/live/${a}/command`, duplicateBatch)).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.equal(
    (
      await call(`/tatamis/${mats[0].id}/live/${a}/command`, {
        ...duplicateBatch,
        id: events[1].id,
        events: [],
      })
    ).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.deepEqual(await row(a), beforeRejectedPacket);
  assert.equal(
    (await call(`/tatamis/${mats[0].id}/live/${a}/command`, { ...batch, id: randomUUID() })).body
      .message,
    'VERSION_CONFLICT',
  );
  await admin(a, 'RELEASE_OFFLINE');
  for (const contestId of [a, b]) {
    const current = await row(contestId);
    assert.equal(
      (
        await call(`/tatamis/${current.tatamiId}/live/${contestId}/command`, {
          id: events[1].id,
          expectedVersion: current.revision,
          type: 'AWARD',
          side: 'BLUE',
          kind: 'YUKO',
        })
      ).body.message,
      'COMMAND_ID_REUSED',
    );
    assert.deepEqual(await row(contestId), current);
    const reset = await adminPayload(contestId, 'RESET');
    assert.equal(
      (
        await call(`/tournaments/${tournament}/control/${contestId}/command`, {
          ...reset,
          id: events[1].id,
        })
      ).body.message,
      'COMMAND_ID_REUSED',
    );
    assert.deepEqual(await row(contestId), current);
  }
  assert.equal(
    (
      await call(`/tatamis/${mats[0].id}/live/${a}/command`, {
        ...batch,
        id: randomUUID(),
        expectedVersion: (await row(a)).revision,
      })
    ).body.message,
    'OFFLINE_SESSION_REVOKED',
  );
  await sporting(a, 'REVOKE', { awardId: local.awards.find((v) => v.active).id });
  const score = await sporting(a, 'AWARD', { side: 'WHITE', kind: 'WAZA_ARI' });
  await sporting(a, 'REVOKE', { awardId: score.state.awards.at(-1).id });
  assert.equal((await row(a)).state.status, 'PAUSED');
  await sporting(a, 'AWARD', { side: 'WHITE', kind: 'IPPON' });
  await sporting(a, 'CONFIRM');
  await sporting(b, 'START');
  await sporting(b, 'AWARD', { side: 'WHITE', kind: 'IPPON' });
  await sporting(b, 'CONFIRM');
  assert.equal((await row(final)).status, 'READY');
  assert.equal(
    (await row(final)).tatamiId,
    mats[0].id,
    'a moved semifinal must not move the category final',
  );
  const saved = (await row(a)).state;
  await admin(a, 'REOPEN');
  assert.equal((await row(a)).status, 'ACTIVE');
  assert.equal((await row(a)).winnerEntryId, null);
  assert.equal((await row(a)).state.status, 'PROVISIONAL');
  assert.equal((await row(final)).status, 'WAITING');
  assert.equal((await row(final)).tatamiId, null);
  assert.equal((await publicDraw()).contests.filter((c) => c.status === 'CONFIRMED').length, 1);
  await sporting(a, 'REVOKE', { awardId: saved.awards.filter((a) => a.active).at(-1).id });
  await sporting(a, 'AWARD', { side: 'BLUE', kind: 'IPPON' });
  await sporting(a, 'CONFIRM');
  const corrected = await row(a),
    ready = await row(final);
  assert.ok([ready.whiteEntryId, ready.blueEntryId].includes(corrected.blueEntryId));
  assert.equal(ready.revision, 1);
  const stale = await adminPayload(a, 'REOPEN');
  await db.contest.updateMany({
    where: { drawId: d.id, status: 'CONFIRMED' },
    data: { confirmedAt: new Date(Date.now() - 601000) },
  });
  await sporting(final, 'START');
  assert.equal(
    (await call(`/tournaments/${tournament}/control/${a}/command`, stale)).body.message,
    'IMPACT_CHANGED',
  );
  const blocked = await adminPayload(a, 'REOPEN');
  assert.equal(
    (await call(`/tournaments/${tournament}/control/${a}/command`, blocked)).body.message,
    'DEPENDENT_CONTESTS_STARTED',
  );
  assert.equal(
    (
      await call(
        `/tournaments/${tournament}/control/${final}/command`,
        await adminPayload(final, 'MOVE', { tatamiId: mats[1].id }),
      )
    ).body.message,
    'PAUSE_REQUIRED',
  );
  await sporting(final, 'STOP');
  await admin(final, 'MOVE', { tatamiId: mats[1].id });
  assert.equal((await row(final)).tatamiId, mats[1].id);
  const beforeReset = await row(final);
  await admin(final, 'RESET');
  const reset = await row(final);
  assert.equal(reset.status, 'READY');
  assert.equal(reset.state, null);
  assert.ok(reset.revision > beforeReset.revision);
  await sporting(final, 'START');
  await sporting(final, 'STOP');
  const finalSession = randomUUID();
  const finalOpen = await post(`/tatamis/${mats[1].id}/live/${final}/command`, {
    id: randomUUID(),
    type: 'OFFLINE_OPEN',
    sessionId: finalSession,
    expectedVersion: (await row(final)).revision,
  });
  let finalState = finalOpen.state;
  const finalEvents = [];
  for (const action of [{ type: 'AWARD', side: 'BLUE', kind: 'IPPON' }, { type: 'CONFIRM' }]) {
    const event = { ...action, id: randomUUID(), expectedVersion: finalState.version };
    finalState = applyCommand(finalState, event);
    finalState.receipts = {};
    finalEvents.push(event);
  }
  assert.equal(
    (await row(final)).winnerEntryId,
    null,
    'local confirmation alone never publishes a winner',
  );
  const finalBatch = {
    id: randomUUID(),
    type: 'OFFLINE_SYNC',
    sessionId: finalSession,
    expectedVersion: finalOpen.revision,
    events: finalEvents,
  };
  await post(`/tatamis/${mats[1].id}/live/${final}/command`, finalBatch);
  await post(`/tatamis/${mats[1].id}/live/${final}/command`, finalBatch);
  assert.equal((await row(final)).offlineSessionId, null);
  assert.equal(await db.matchEvent.count({ where: { id: finalBatch.id } }), 1);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'FINISHED',
  );
  await admin(final, 'REOPEN');
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'RUNNING',
  );
  assert.equal(
    await db.auditEvent.count({ where: { tournamentId: tournament, action: 'ADMIN_REOPEN' } }),
    2,
  );
  const dashboard = (await call(`/tournaments/${tournament}/control`)).body;
  assert.equal(dashboard.tatamis.length, 3);
  assert.equal(dashboard.finished, 2);
  assert.equal(dashboard.total, 3);
  assert.equal(dashboard.tatamis.find((m) => m.id === mats[1].id).live.currentMatch.id, final);
  console.log(
    'PASS: private central control, independent draw publication, operator denial, move/unqueue/reset, idempotency, outcome reopening, descendant invalidation, stale impact and started-descendant blocking, corrected winner propagation, revised restart, audit and live dashboard.',
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.category.deleteMany({ where: { tournamentId: tournament } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament } });
    await db.tournament.delete({ where: { id: tournament } });
  }
  if (operator) await db.user.delete({ where: { id: operator } });
  for (const u of [owner, outsider]) if (u) await db.user.delete({ where: { id: u.id } });
  await db.$disconnect();
}
