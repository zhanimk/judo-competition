import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { applyCommand, tally } from '@judo/engine/match';
import { createTestUser } from './test-user.mjs';
import { fixtureControl, fixtureRequest } from './test-access.mjs';

const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const users = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tournament, cookie, mat, contest;
async function call(path, data, auth = cookie, raw = false) {
  const response = raw
    ? await fetch(base + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth ?? '' },
        body: data === undefined ? undefined : JSON.stringify(data),
      })
    : await fixtureRequest(base, path, data, auth ?? '');
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function post(path, data = {}, auth = cookie) {
  const response = await call(path, data, auth);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
const row = () => db.contest.findUniqueOrThrow({ where: { id: contest } });
const endpoint = () => `/tournaments/${tournament}/control/${contest}/command`;
async function body(elapsedMs, phase = 'REGULAR') {
  const preview = (await call(`/tournaments/${tournament}/control/${contest}/impact`)).body;
  return {
    id: randomUUID(),
    type: 'EDIT_TIME',
    expectedRevision: preview.revision,
    impactToken: preview.impactToken,
    reason: 'QA: сверка остановленного времени',
    phase,
    elapsedMs,
  };
}
async function sport(type, extra = {}) {
  const current = await row();
  return post(`/tatamis/${mat}/live/${contest}/command`, {
    id: randomUUID(),
    expectedVersion: current.revision,
    type,
    ...extra,
  });
}
async function snapshot() {
  return {
    row: await row(),
    mat: await db.tatami.findUniqueOrThrow({ where: { id: mat } }),
    events: await db.matchEvent.count({ where: { contestId: contest } }),
    audits: await db.auditEvent.count({ where: { tournamentId: tournament } }),
  };
}
async function reject(payload, expectedStatus = 409, auth = cookie) {
  const before = await snapshot();
  const response = await call(endpoint(), payload, auth);
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  assert.deepEqual(
    await snapshot(),
    before,
    'rejected correction must leave match, grant, receipt and audit unchanged',
  );
  return response;
}
async function waitForClock(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = await row();
    if (predicate(current)) return current;
    await wait(20);
  }
  assert.fail('the isolated API timer must persist the expected clock transition');
}
async function terminalEvidence() {
  return {
    events: await db.matchEvent.findMany({
      where: { contestId: contest, type: 'CLOCK_TERMINAL_REACHED' },
      orderBy: { createdAt: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: {
        tournamentId: tournament,
        entityId: contest,
        action: 'MATCH_CLOCK_TERMINAL_REACHED',
      },
      orderBy: { createdAt: 'asc' },
    }),
  };
}
async function verifyNaturalTimerTransitions() {
  await post(endpoint(), await body(1000));
  const normalStart = await sport('START');
  const normalBefore = await snapshot();
  const ordinary = await waitForClock(
    (current) => current.state.version > normalStart.state.version,
  );
  assert.equal(ordinary.state.status, 'RUNNING');
  assert.equal(ordinary.revision, normalStart.revision);
  const normalAfter = await snapshot();
  assert.equal(normalAfter.events, normalBefore.events);
  assert.equal(normalAfter.audits, normalBefore.audits);
  await sport('STOP');

  for (const lead of [false, true]) {
    let award;
    if (lead) {
      const scored = await sport('AWARD', { side: 'WHITE', kind: 'YUKO' });
      award = scored.state.awards.find((value) => value.active && value.kind === 'YUKO');
    }
    // Use the real administrative correction and a fresh START/clock anchor.
    // The test never synthesizes clockEpoch or invokes a private timer adapter.
    await post(endpoint(), await body((await row()).state.rules.durationMs - 50));
    const before = await terminalEvidence();
    const started = await sport('START');
    const terminal = await waitForClock(
      (current) => current.state.status === (lead ? 'PROVISIONAL' : 'DECISION'),
    );
    assert.equal(terminal.status, 'ACTIVE');
    assert.equal(terminal.revision, started.revision + 1);
    assert.ok(terminal.state.version > started.state.version);
    assert.deepEqual(terminal.state.outcome, lead ? { winner: 'WHITE', reason: 'TIME' } : null);
    assert.equal(terminal.winnerEntryId, null);
    assert.equal(terminal.confirmedAt, null);
    const after = await terminalEvidence();
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.audits.length, before.audits.length + 1);
    const event = after.events.at(-1),
      audit = after.audits.at(-1);
    assert.equal(event.actorId, 'SYSTEM');
    assert.equal(audit.actorId, 'SYSTEM');
    assert.equal(event.payload.cause, 'REGULAR_TIME_EXPIRED');
    assert.equal(event.payload.revision, terminal.revision);
    assert.equal(event.payload.before.status, 'RUNNING');
    assert.equal(event.payload.before.version + 1, terminal.state.version);
    assert.deepEqual(event.payload.state, terminal.state);
    assert.deepEqual(audit.payload, event.payload);
    const stopped = await snapshot();
    await wait(650);
    assert.deepEqual(
      await snapshot(),
      stopped,
      'later stopped ticks cannot repeat boundary/event/audit',
    );
    assert.deepEqual(await terminalEvidence(), after);
    await post(endpoint(), await body(1000));
    if (award) await sport('REVOKE', { awardId: award.id });
  }
  await sport('START');
  await sport('HOLD', { side: 'WHITE' });
  const holdBefore = await terminalEvidence();
  const holdScoreBefore = await db.matchEvent.count({
    where: { contestId: contest, type: 'HOLD_SCORE_UPDATED' },
  });
  // Seed only this disposable fixture's already active hold near its boundary;
  // retain the API's real clock epoch/anchor, rules and sporting command history.
  const holding = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournament} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${tournament} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Contest" WHERE id=${contest} FOR UPDATE`;
    const current = await tx.contest.findUniqueOrThrow({ where: { id: contest } });
    assert.equal(current.state.status, 'RUNNING');
    assert.ok(current.state.hold);
    const ipponThreshold = current.state.rules.holdThresholds.find(
      (threshold) => threshold.score === 'IPPON',
    );
    assert.ok(ipponThreshold, 'the current synthetic category permits an ippon hold');
    const nearHold = structuredClone(current.state);
    nearHold.hold.elapsedMs = ipponThreshold.ms - 50;
    await tx.contest.update({ where: { id: contest }, data: { state: nearHold } });
    return current;
  });
  const holdTerminal = await waitForClock((current) => current.state.status === 'PROVISIONAL');
  assert.equal(holdTerminal.revision, holding.revision + 1);
  assert.deepEqual(holdTerminal.state.outcome, { winner: 'WHITE', reason: 'IPPON' });
  assert.equal(
    holdTerminal.state.awards.filter((award) => award.active && award.kind === 'IPPON').length,
    1,
  );
  const holdAfter = await terminalEvidence();
  assert.equal(holdAfter.events.length, holdBefore.events.length + 1);
  assert.equal(holdAfter.audits.length, holdBefore.audits.length + 1);
  assert.equal(holdAfter.events.at(-1).payload.cause, 'HOLD_SCORE_FINISHED');
  assert.deepEqual(holdAfter.events.at(-1).payload.state, holdTerminal.state);
  assert.deepEqual(holdAfter.audits.at(-1).payload, holdAfter.events.at(-1).payload);
  assert.equal(
    await db.matchEvent.count({ where: { contestId: contest, type: 'HOLD_SCORE_UPDATED' } }),
    holdScoreBefore + 1,
  );
  const holdStopped = await snapshot();
  await wait(650);
  assert.deepEqual(await snapshot(), holdStopped);
  const resetImpact = (await call(`/tournaments/${tournament}/control/${contest}/impact`)).body;
  await post(endpoint(), {
    id: randomUUID(),
    type: 'RESET',
    expectedRevision: resetImpact.revision,
    impactToken: resetImpact.impactToken,
    reason: 'QA: reset the isolated hold terminal fixture',
  });
  await sport('START');
  await sport('STOP');
}
try {
  assert.ok(base, 'TEST_API_URL is required');
  const configuredSchema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(
    configuredSchema ?? '',
    /^qa_[a-z0-9_]+$/,
    'only disposable qa_ schemas are allowed',
  );
  const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(schema, configuredSchema);
  const owner = await createTestUser(db);
  users.push(owner.id);
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password }, '')).cookie;
  const outsider = await createTestUser(db);
  users.push(outsider.id);
  const foreign = (
    await call('/auth/login', { email: outsider.email, password: outsider.password }, '')
  ).cookie;
  tournament = (
    await post('/tournaments', {
      name: 'CLOCK CORRECTION QA',
      city: 'Алматы',
      venue: 'Изолированный QA',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    })
  ).id;
  const category = await post(`/tournaments/${tournament}/categories`, {
    name: 'U15 −50',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
    format: 'ROUND_ROBIN',
  });
  for (let i = 0; i < 2; i++)
    await post(`/tournaments/${tournament}/categories/${category.id}/entries`, {
      firstName: 'QA',
      lastName: 'Clock ' + i,
      club: 'Club ' + i,
      birthYear: 2012,
    });
  let draw = await post(`/categories/${category.id}/draw/preview`);
  draw = await post(`/categories/${category.id}/draw/confirm`, { version: draw.version });
  await post(`/tournaments/${tournament}/publish`);
  await post(`/categories/${category.id}/draw/publication`, {
    published: true,
    expectedRevision: 0,
  });
  await post(`/tournaments/${tournament}/start`);
  mat = (await db.tatami.findFirstOrThrow({ where: { tournamentId: tournament } })).id;
  contest = draw.contests[0].id;
  await reject(await body(1000));
  await sport('START');
  const runningBody = await body(1000);
  assert.equal((await call(endpoint(), runningBody)).status, 409);
  assert.equal(await db.matchEvent.count({ where: { id: runningBody.id } }), 0);
  await sport('STOP');
  await verifyNaturalTimerTransitions();
  // Reproduce a historical/corrupt saved state changing domain semantics
  // without Contest.revision. Current terminal ticks increment revision, but
  // preview must still protect against a same-revision snapshot discrepancy.
  // Only this script's guarded disposable schema receives the fixture update.
  await sport('START');
  const oldImpact = await body(5000);
  const tickBase = await row();
  const tickState = applyCommand(tickBase.state, {
    id: randomUUID(),
    expectedVersion: tickBase.state.version,
    type: 'ADVANCE',
    ms: tickBase.state.rules.durationMs,
  });
  tickState.receipts = {};
  await db.contest.update({
    where: { id: contest },
    data: { state: tickState, clockAnchorMs: null, clockEpoch: null },
  });
  assert.equal((await row()).revision, tickBase.revision);
  assert.equal((await reject(oldImpact)).body.message, 'IMPACT_CHANGED');
  const before = await snapshot();
  const correction = await body(12300);
  const receipt = await post(endpoint(), correction);
  assert.equal(receipt.contestId, contest);
  assert.equal(receipt.revision, before.row.revision + 1);
  assert.equal(receipt.state.elapsedMs, 12300);
  assert.equal(receipt.state.status, 'PAUSED');
  assert.equal(receipt.state.version, before.row.state.version + 1);
  assert.equal(receipt.controlGeneration, before.mat.controlGeneration + 1);
  assert.deepEqual(receipt.state.awards, before.row.state.awards);
  assert.equal((await row()).clockAnchorMs, null);
  const audit = await db.auditEvent.findFirstOrThrow({
    where: { tournamentId: tournament, action: 'ADMIN_EDIT_TIME' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(audit.payload.before.row.state.elapsedMs, before.row.state.elapsedMs);
  assert.equal(audit.payload.after.state.elapsedMs, 12300);
  assert.deepEqual(
    await post(endpoint(), correction),
    receipt,
    'lost response replay returns the original receipt',
  );
  await reject({ ...correction, elapsedMs: 12400 });
  await reject({ ...(await body(20000)), expectedRevision: correction.expectedRevision });
  await reject(await body(20000, 'GOLDEN'));
  for (const invalid of [-1, 180001, 1.5]) await reject(await body(invalid), 400);
  await reject({ ...(await body(20000)), reason: '  ' }, 400);
  await reject(await body(20000), 403, foreign);
  const invite = await post(`/auth/tatamis/${mat}/invitations`, { label: 'Clock judge', hours: 1 });
  const accepted = await call(
    '/auth/invitations/accept',
    { token: invite.token, name: 'Clock judge' },
    '',
  );
  assert.equal(accepted.status, 201);
  users.push((await call('/auth/me', undefined, accepted.cookie)).body.id);
  await reject(await body(20000), 403, accepted.cookie);
  // Invalidate the pending sporting request's original grant without rewriting it.
  const staleGrant = {
    id: randomUUID(),
    type: 'AWARD',
    expectedVersion: (await row()).revision,
    side: 'WHITE',
    kind: 'YUKO',
    deviceId: before.mat.controllerDeviceId,
    controlGeneration: before.mat.controlGeneration,
  };
  assert.equal(
    (await call(`/tatamis/${mat}/live/${contest}/command`, staleGrant, cookie, true)).status,
    409,
  );
  await sport('START');
  await sport('HOLD', { side: 'WHITE' });
  await fixtureControl(base, mat, cookie, 'TAKEOVER');
  await reject(await body(30000));
  await sport('START');
  await sport('TOKETA');
  await sport('STOP');
  const opened = await sport('OFFLINE_OPEN', { sessionId: randomUUID() });
  assert.ok(opened.state);
  const offline = await row();
  await sport('OFFLINE_SYNC', {
    sessionId: offline.offlineSessionId,
    events: [{ id: randomUUID(), expectedVersion: offline.state.version, type: 'START' }],
  });
  const offlineRunning = await snapshot();
  assert.equal(offlineRunning.row.state.status, 'RUNNING');
  await wait(650);
  assert.deepEqual(
    await snapshot(),
    offlineRunning,
    'the server clock never advances a valid offline journal',
  );
  await reject(await body(30000));
  const impact = (await call(`/tournaments/${tournament}/control/${contest}/impact`)).body;
  await post(endpoint(), {
    id: randomUUID(),
    type: 'RELEASE_OFFLINE',
    reason: 'QA: release journal',
    expectedRevision: impact.revision,
    impactToken: impact.impactToken,
  });
  // A partial historical lease must fail closed too, including generation zero.
  // Fixture writes are restricted to this script's disposable QA schema.
  const onlineGrant = await fixtureControl(base, mat, cookie);
  const accessStatus = (
    await call(
      `/auth/tatamis/${mat}/control?deviceId=${onlineGrant.deviceId}`,
      undefined,
      cookie,
      true,
    )
  ).body;
  const historicalAccessCommand = {
    id: randomUUID(),
    type: 'CLAIM',
    expectedRevision: accessStatus.accessRevision,
    deviceId: onlineGrant.deviceId,
  };
  const accessReceipt = await call(
    `/auth/tatamis/${mat}/control`,
    historicalAccessCommand,
    cookie,
    true,
  );
  assert.equal(accessReceipt.status, 201, JSON.stringify(accessReceipt.body));
  const historicalSportCommand = {
    id: randomUUID(),
    type: 'AWARD',
    side: 'WHITE',
    kind: 'YUKO',
    expectedVersion: (await row()).revision,
    ...onlineGrant,
  };
  const sportReceipt = await call(
    `/tatamis/${mat}/live/${contest}/command`,
    historicalSportCommand,
    cookie,
    true,
  );
  assert.equal(sportReceipt.status, 201, JSON.stringify(sportReceipt.body));
  await sport('REVOKE', { awardId: historicalSportCommand.id });
  const released = await row();
  for (const partialLease of [{ offlineActorId: owner.id }, { offlineControlGeneration: 0 }]) {
    await db.contest.update({ where: { id: contest }, data: partialLease });
    const guarded = await snapshot();
    for (const command of [
      { type: 'AWARD', side: 'BLUE', kind: 'YUKO' },
      { type: 'OFFLINE_OPEN', sessionId: randomUUID() },
      { type: 'OFFLINE_SYNC', sessionId: randomUUID(), events: [] },
      { type: 'OFFLINE_RELEASE', sessionId: randomUUID(), events: [] },
    ]) {
      const rejected = await call(
        `/tatamis/${mat}/live/${contest}/command`,
        {
          id: randomUUID(),
          expectedVersion: guarded.row.revision,
          ...onlineGrant,
          ...command,
        },
        cookie,
        true,
      );
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(rejected.body.message, 'OFFLINE_METADATA_INCOMPLETE');
      assert.deepEqual(await snapshot(), guarded);
    }
    for (const type of ['CLAIM', 'RELEASE', 'TAKEOVER']) {
      const rejected = await call(
        `/auth/tatamis/${mat}/control`,
        {
          id: randomUUID(),
          expectedRevision: guarded.mat.accessRevision,
          deviceId: onlineGrant.deviceId,
          type,
          ...(type === 'TAKEOVER' ? { reason: 'QA: partial lease review' } : {}),
        },
        cookie,
        true,
      );
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(rejected.body.message, 'OFFLINE_METADATA_INCOMPLETE');
      assert.deepEqual(await snapshot(), guarded);
    }
    const replayedAccess = await call(
      `/auth/tatamis/${mat}/control`,
      historicalAccessCommand,
      cookie,
      true,
    );
    assert.equal(replayedAccess.status, 201);
    assert.deepEqual(replayedAccess.body, accessReceipt.body);
    const replayedSport = await call(
      `/tatamis/${mat}/live/${contest}/command`,
      historicalSportCommand,
      cookie,
      true,
    );
    assert.equal(replayedSport.status, 201);
    assert.deepEqual(replayedSport.body, sportReceipt.body);
    assert.deepEqual(
      await snapshot(),
      guarded,
      'historical acknowledgement must not reconcile a partial lease',
    );
    assert.equal((await call(`/tatamis/${mat}/live`)).body.currentMatch.offlineActive, true);
    const controlOverview = (await call(`/tournaments/${tournament}/control`)).body;
    assert.equal(controlOverview.contests.find((item) => item.id === contest).offlineActive, true);
    assert.equal((await reject(await body(30000))).body.message, 'OFFLINE_OWNED');
    await db.contest.update({
      where: { id: contest },
      data: {
        offlineActorId: released.offlineActorId,
        offlineControlGeneration: released.offlineControlGeneration,
      },
    });
  }
  await post(endpoint(), await body(180000));
  assert.equal((await row()).state.status, 'DECISION');
  await post(endpoint(), await body(170000));
  assert.equal((await row()).state.status, 'PAUSED');
  await sport('AWARD', { side: 'WHITE', kind: 'YUKO' });
  const atEnd = await post(endpoint(), await body(180000));
  assert.equal(atEnd.state.status, 'PROVISIONAL');
  assert.deepEqual(atEnd.state.outcome, { winner: 'WHITE', reason: 'TIME' });
  const restoredTime = await post(endpoint(), await body(170000));
  assert.equal(restoredTime.state.status, 'PAUSED');
  assert.equal(restoredTime.state.outcome, null);
  assert.equal(tally(restoredTime.state, 'WHITE').YUKO, 1);
  await post(endpoint(), await body(180000));
  const score = atEnd.state.awards.find((award) => award.active && award.kind === 'YUKO');
  await sport('REVOKE', { awardId: score.id });
  assert.equal((await row()).state.status, 'DECISION');
  await sport('GOLDEN');
  const goldenBefore = await row();
  const golden = await post(endpoint(), await body(12300, 'GOLDEN'));
  assert.equal(golden.state.goldenMs, 12300);
  assert.equal(golden.state.elapsedMs, goldenBefore.state.elapsedMs);
  assert.equal(golden.state.phase, 'GOLDEN');
  assert.deepEqual(tally(golden.state, 'WHITE'), tally(goldenBefore.state, 'WHITE'));
  const goldenSnapshot = await snapshot();
  assert.deepEqual(
    await post(endpoint(), correction),
    receipt,
    'a historical exact receipt cannot roll a newer phase back',
  );
  assert.deepEqual(await snapshot(), goldenSnapshot);
  await reject(await body(21600001, 'GOLDEN'), 400);
  await reject(await body(0, 'REGULAR'));
  await post(endpoint(), await body(21600000, 'GOLDEN'));
  assert.equal((await row()).state.goldenMs, 21600000);
  await post(endpoint(), await body(0, 'GOLDEN'));
  await sport('AWARD', { side: 'BLUE', kind: 'IPPON' });
  await sport('CONFIRM');
  await reject(await body(1, 'GOLDEN'));
  const completed = await row();
  const publicData = (await call(`/public/tournaments/${tournament}`, undefined, '')).body;
  const visible = publicData.categories[0].draw.contests.find((c) => c.id === contest);
  assert.equal(visible.status, 'CONFIRMED');
  assert.equal(visible.winnerEntryId, completed.blueEntryId);
  assert.equal(visible.resultReason, 'GOLDEN_SCORE');
  assert.equal(visible.state.goldenMs, 0);
  assert.equal(visible.state.awards.filter((a) => a.active && a.kind === 'IPPON').length, 1);
  assert.equal(
    (await db.tournament.findUniqueOrThrow({ where: { id: tournament } })).status,
    'FINISHED',
  );
  console.log(
    'PASS: natural ordinary/terminal clock ticks with atomic boundary/revision/audit and no duplicates, stopped-clock correction, reason/version/access guards, immutable receipt, grant invalidation, hold/offline barriers including running offline journals, partial metadata and historical receipts, exact-end decision, Golden Score and public confirmed result.',
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.category.deleteMany({ where: { tournamentId: tournament } });
    await db.club.deleteMany({ where: { tournamentId: tournament } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament } });
    await db.tournament.delete({ where: { id: tournament } });
  }
  await db.athlete.deleteMany({ where: { ownerId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
