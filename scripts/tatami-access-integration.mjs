import { fixtureRequest } from './test-access.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser } from './test-user.mjs';

const db = new PrismaClient();
const base = process.env.TEST_API_URL;
const users = [];
let tournament;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(path, data, cookie = '') {
  const legacyAdministration =
    path === '/tournaments' ||
    /^\/tournaments\/[^/]+\/(categories|start|schedule|publish)$/.test(path) ||
    /^\/categories\/[^/]+\/draw\/(preview|confirm|publication)$/.test(path);
  const response =
    legacyAdministration && data !== undefined
      ? await fixtureRequest(base, path, data, cookie)
      : await fetch(base + path, {
          method: data === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, data, cookie) {
  const result = await call(path, data, cookie);
  assert.ok(result.status < 300, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function login(role = 'ORGANIZER') {
  const user = await createTestUser(db, role);
  users.push(user.id);
  const result = await call('/auth/login', { email: user.email, password: user.password });
  assert.equal(result.status, 201);
  assert.equal(result.body.workRole, 'ADMIN');
  return { ...user, cookie: result.cookie };
}
const status = (mat, cookie, deviceId) =>
  ok(`/auth/tatamis/${mat}/control${deviceId ? '?deviceId=' + deviceId : ''}`, undefined, cookie);
async function issue(mat, owner, label) {
  const current = await status(mat, owner.cookie);
  const body = {
    id: randomUUID(),
    expectedRevision: current.accessRevision,
    token: randomBytes(32).toString('hex'),
    label,
    hours: 1,
  };
  const result = await ok(`/auth/tatamis/${mat}/invitations`, body, owner.cookie);
  return { body, result };
}
async function redeem(invite, name) {
  const accepted = await call('/auth/invitations/accept', { token: invite.result.token, name });
  assert.equal(accepted.status, 201);
  const me = await ok('/auth/me', undefined, accepted.cookie);
  users.push(me.id);
  assert.equal(me.workRole, 'JUDGE');
  return { ...me, cookie: accepted.cookie };
}
async function access(mat, actor, deviceId, type, extra = {}) {
  const current = await status(mat, actor.cookie, deviceId);
  const body = {
    id: randomUUID(),
    expectedRevision: current.accessRevision,
    deviceId,
    type,
    ...extra,
  };
  return { body, result: await call(`/auth/tatamis/${mat}/control`, body, actor.cookie) };
}
async function sporting(mat, contestId, actor, deviceId, generation, type, extra = {}) {
  const row = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
  const body = {
    id: randomUUID(),
    expectedVersion: row.revision,
    deviceId,
    controlGeneration: generation,
    type,
    ...extra,
  };
  return {
    body,
    result: await call(`/tatamis/${mat}/live/${contestId}/command`, body, actor.cookie),
  };
}
async function countState() {
  return {
    invitations: await db.invitation.findMany({
      where: { tatami: { tournamentId: tournament } },
      orderBy: { id: 'asc' },
    }),
    mats: await db.tatami.findMany({ where: { tournamentId: tournament }, orderBy: { id: 'asc' } }),
    access: await db.accessCommand.findMany({
      where: { tournamentId: tournament },
      orderBy: { id: 'asc' },
    }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: tournament },
      orderBy: { id: 'asc' },
    }),
  };
}
async function sportingSnapshot(contestId) {
  return {
    contest: await db.contest.findUniqueOrThrow({ where: { id: contestId } }),
    events: await db.matchEvent.findMany({ where: { contestId }, orderBy: { id: 'asc' } }),
    audits: await db.auditEvent.findMany({
      where: { tournamentId: tournament },
      orderBy: { id: 'asc' },
    }),
  };
}
try {
  assert.ok(base, 'TEST_API_URL for the isolated rehearsal API is required');
  const configuredSchema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(
    configuredSchema ?? '',
    /^qa_[a-z0-9_]+$/,
    'only a disposable qa_ schema is allowed',
  );
  const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(schema, configuredSchema);
  const owner = await login(),
    outsider = await login(),
    systemAdmin = await login('SUPER_ADMIN');
  const created = await ok(
    '/tournaments',
    {
      name: 'СЫНAҚ · Tatami access',
      city: 'QA',
      venue: 'Isolated QA',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 2,
    },
    owner.cookie,
  );
  tournament = created.id;
  const mats = await ok(`/tournaments/${tournament}/tatamis`, undefined, owner.cookie);
  const mat = mats[0].id,
    otherMat = mats[1].id;
  const category = await ok(
    `/tournaments/${tournament}/categories`,
    {
      name: 'QA access U15',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
    },
    owner.cookie,
  );
  const club = await ok(
    `/tournaments/${tournament}/clubs`,
    { id: randomUUID(), expectedRevision: 0, name: 'QA club' },
    owner.cookie,
  );
  const roster = await ok(
    `/tournaments/${tournament}/roster`,
    {
      id: randomUUID(),
      expectedRevision: club.revision,
      clubId: club.club.id,
      entries: [1, 2].map((i) => ({
        firstName: 'Сынақ',
        lastName: 'Қатысушы-' + i,
        birthYear: 2012,
        gender: 'MALE',
        categoryId: category.id,
      })),
    },
    owner.cookie,
  );
  assert.equal(roster.entries.length, 2);
  const preview = await ok(`/categories/${category.id}/draw/preview`, {}, owner.cookie);
  await ok(`/categories/${category.id}/draw/confirm`, { version: preview.version }, owner.cookie);
  await ok(`/tournaments/${tournament}/start`, {}, owner.cookie);
  const contest = await db.contest.findFirstOrThrow({
    where: { draw: { categoryId: category.id }, status: 'READY' },
  });
  assert.equal(contest.tatamiId, mat);

  // Invitation issuance has an exact durable receipt, without a plaintext secret.
  const invitation = await issue(mat, owner, 'Судья QA');
  assert.deepEqual(
    await ok(`/auth/tatamis/${mat}/invitations`, invitation.body, owner.cookie),
    invitation.result,
  );
  assert.equal(await db.invitation.count({ where: { id: invitation.result.id } }), 1);
  const receipt = await db.accessCommand.findUniqueOrThrow({ where: { id: invitation.body.id } });
  assert.ok(
    !JSON.stringify(receipt).includes(invitation.body.token),
    'plaintext invitation secret must not be persisted in receipt',
  );
  const beforeReuse = await countState();
  const reuse = await call(
    `/auth/tatamis/${mat}/invitations`,
    { ...invitation.body, label: 'Changed' },
    owner.cookie,
  );
  assert.equal(reuse.status, 409);
  assert.deepEqual(await countState(), beforeReuse);
  assert.equal(
    (
      await call(
        `/auth/tatamis/${mat}/invitations`,
        { ...invitation.body, id: randomUUID() },
        outsider.cookie,
      )
    ).status,
    403,
  );

  const acceptResults = await Promise.all(
    [1, 2].map((i) =>
      call('/auth/invitations/accept', { token: invitation.result.token, name: 'Судья ' + i }),
    ),
  );
  assert.deepEqual(acceptResults.map((r) => r.status).sort(), [201, 401]);
  const accepted = acceptResults.find((r) => r.status === 201);
  const judgeMe = await ok('/auth/me', undefined, accepted.cookie);
  users.push(judgeMe.id);
  const judge = { ...judgeMe, cookie: accepted.cookie };
  assert.equal(judge.workRole, 'JUDGE');
  const judgeSession = await db.session.findFirstOrThrow({ where: { userId: judge.id } });
  assert.ok(judgeSession.expiresAt <= new Date(invitation.result.expiresAt));
  assert.equal(
    (await call(`/auth/tatamis/${otherMat}/control`, undefined, judge.cookie)).status,
    403,
  );
  assert.equal((await call(`/tournaments/${tournament}`, undefined, judge.cookie)).status, 403);
  assert.equal(
    (await call(`/tournaments/${tournament}/control`, undefined, judge.cookie)).status,
    403,
  );

  // The same cookie in two tabs does not confer a second controller.
  const devices = [randomUUID(), randomUUID()];
  const initial = await status(mat, judge.cookie);
  const claims = await Promise.all(
    devices.map((deviceId) =>
      call(
        `/auth/tatamis/${mat}/control`,
        { id: randomUUID(), expectedRevision: initial.accessRevision, deviceId, type: 'CLAIM' },
        judge.cookie,
      ),
    ),
  );
  assert.deepEqual(claims.map((r) => r.status).sort(), [201, 409]);
  const index = claims.findIndex((r) => r.status === 201),
    deviceId = devices[index],
    otherDevice = devices[1 - index];
  let generation = claims[index].body.control.generation;
  assert.equal((await status(mat, judge.cookie, deviceId)).control.owned, true);
  const viewer = await status(mat, judge.cookie, otherDevice);
  assert.equal(viewer.control.owned, false);
  assert.equal('controllerDeviceId' in viewer.control, false);
  assert.equal('controllerSessionId' in viewer.control, false);
  const missing = await call(
    `/tatamis/${mat}/live/${contest.id}/command`,
    { id: randomUUID(), expectedVersion: contest.revision, type: 'START' },
    judge.cookie,
  );
  assert.equal(missing.status, 400);
  assert.equal(
    (await sporting(mat, contest.id, judge, otherDevice, generation, 'START')).result.status,
    409,
  );
  assert.equal(
    (await access(mat, judge, otherDevice, 'TAKEOVER', { reason: 'Denied judge takeover' })).result
      .status,
    403,
  );

  let started = await sporting(mat, contest.id, judge, deviceId, generation, 'START');
  assert.equal(started.result.status, 201);
  assert.equal((await access(mat, judge, deviceId, 'RELEASE')).result.status, 409);
  const hold = await sporting(mat, contest.id, judge, deviceId, generation, 'HOLD', {
    side: 'WHITE',
  });
  assert.equal(hold.result.status, 201);
  await wait(650);
  const beforeTransfer = await db.contest.findUniqueOrThrow({ where: { id: contest.id } });
  const adminDevice = randomUUID();
  const takeover = await access(mat, owner, adminDevice, 'TAKEOVER', {
    reason: 'Смена судьи с обязательной сверкой времени',
  });
  assert.equal(takeover.result.status, 201);
  generation = takeover.result.body.control.generation;
  const paused = await db.contest.findUniqueOrThrow({ where: { id: contest.id } });
  assert.equal(paused.status, 'ACTIVE');
  assert.equal(paused.state.status, 'PAUSED');
  const pauseEvent = await db.matchEvent.findFirstOrThrow({
    where: { contestId: contest.id, type: 'CONTROL_ACCESS_PAUSED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(pauseEvent.payload.clockUncertain, true);
  assert.deepEqual(paused.state.hold, pauseEvent.payload.before.hold);
  assert.deepEqual(paused.state.awards, pauseEvent.payload.before.awards);
  assert.ok(paused.state.hold.elapsedMs >= beforeTransfer.state.hold.elapsedMs);
  assert.equal(paused.clockAnchorMs, null);
  assert.ok(paused.revision > beforeTransfer.revision);
  assert.equal(
    (
      await sporting(
        mat,
        contest.id,
        judge,
        deviceId,
        claims[index].body.control.generation,
        'START',
      )
    ).result.status,
    409,
  );
  // A saved sporting receipt is read-only and still exactly acknowledges the old command.
  const startReplay = await call(
    `/tatamis/${mat}/live/${contest.id}/command`,
    started.body,
    judge.cookie,
  );
  assert.equal(startReplay.status, 201);
  assert.deepEqual(startReplay.body, started.result.body);
  assert.equal(
    (await db.contest.findUniqueOrThrow({ where: { id: contest.id } })).state.status,
    'PAUSED',
  );
  assert.deepEqual(
    (await call(`/auth/tatamis/${mat}/control`, takeover.body, owner.cookie)).body,
    takeover.result.body,
  );

  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'START')).result.status,
    201,
  );
  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'TOKETA')).result.status,
    201,
  );
  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'STOP')).result.status,
    201,
  );
  const collisionSnapshot = await sportingSnapshot(contest.id);
  const currentRevision = collisionSnapshot.contest.revision;
  assert.equal(
    (
      await call(
        `/tatamis/${mat}/live/${contest.id}/command`,
        {
          id: invitation.body.id,
          expectedVersion: currentRevision,
          deviceId: adminDevice,
          controlGeneration: generation,
          type: 'START',
        },
        owner.cookie,
      )
    ).body.message,
    'COMMAND_ID_REUSED',
  );
  const accessCollision = await access(mat, owner, adminDevice, 'CLAIM', { id: started.body.id });
  assert.equal(accessCollision.result.body.message, 'COMMAND_ID_REUSED');
  assert.deepEqual(await sportingSnapshot(contest.id), collisionSnapshot);
  const offlineSession = randomUUID();
  assert.equal(
    (
      await sporting(mat, contest.id, owner, adminDevice, generation, 'OFFLINE_OPEN', {
        sessionId: offlineSession,
      })
    ).result.status,
    201,
  );
  assert.equal(
    (
      await access(mat, systemAdmin, randomUUID(), 'TAKEOVER', {
        reason: 'Cannot silently discard offline journal',
      })
    ).result.body.message,
    'OFFLINE_OWNED',
  );
  // Migrated historical offline leases have no grant generation and fail closed.
  await db.contest.update({ where: { id: contest.id }, data: { offlineControlGeneration: null } });
  const legacySnapshot = await sportingSnapshot(contest.id);
  const legacySync = await sporting(
    mat,
    contest.id,
    owner,
    adminDevice,
    generation,
    'OFFLINE_SYNC',
    {
      sessionId: offlineSession,
      events: [],
    },
  );
  assert.equal(legacySync.result.status, 409);
  assert.equal(legacySync.result.body.message, 'OFFLINE_METADATA_INCOMPLETE');
  assert.deepEqual(await sportingSnapshot(contest.id), legacySnapshot);
  await db.contest.update({
    where: { id: contest.id },
    data: { offlineControlGeneration: generation },
  });
  assert.equal(
    (
      await sporting(mat, contest.id, owner, adminDevice, generation, 'OFFLINE_RELEASE', {
        sessionId: offlineSession,
        events: [],
      })
    ).result.status,
    201,
  );
  const oldOffline = await sporting(
    mat,
    contest.id,
    owner,
    adminDevice,
    generation,
    'OFFLINE_OPEN',
    {
      sessionId: randomUUID(),
    },
  );
  assert.equal(oldOffline.result.status, 201);
  const staleOfflinePacket = {
    id: randomUUID(),
    expectedVersion: oldOffline.result.body.revision,
    deviceId: adminDevice,
    controlGeneration: generation,
    type: 'OFFLINE_SYNC',
    sessionId: oldOffline.body.sessionId,
    events: [],
  };
  const impact = await ok(
    `/tournaments/${tournament}/control/${contest.id}/impact`,
    undefined,
    owner.cookie,
  );
  await ok(
    `/tournaments/${tournament}/control/${contest.id}/command`,
    {
      id: randomUUID(),
      expectedRevision: impact.revision,
      impactToken: impact.impactToken,
      type: 'RELEASE_OFFLINE',
      reason: 'Явное освобождение старого автономного пульта QA',
    },
    owner.cookie,
  );
  const offlineTakeover = await access(mat, owner, adminDevice, 'TAKEOVER', {
    reason: 'Сверка после освобождения автономной сессии QA',
  });
  assert.equal(offlineTakeover.result.status, 201);
  generation = offlineTakeover.result.body.control.generation;
  const staleSnapshot = await sportingSnapshot(contest.id);
  assert.equal(
    (await call(`/tatamis/${mat}/live/${contest.id}/command`, staleOfflinePacket, owner.cookie))
      .status,
    409,
  );
  assert.deepEqual(await sportingSnapshot(contest.id), staleSnapshot);
  assert.deepEqual(
    await ok(`/tatamis/${mat}/live/${contest.id}/command`, oldOffline.body, owner.cookie),
    oldOffline.result.body,
  );
  const released = await access(mat, owner, adminDevice, 'RELEASE');
  assert.equal(released.result.status, 201);
  assert.equal(released.result.body.control.held, false);
  assert.deepEqual(
    (await call(`/auth/tatamis/${mat}/control`, released.body, owner.cookie)).body,
    released.result.body,
  );
  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'START')).result.status,
    409,
  );

  // Revoke versus a new sporting command is serialized; the final state is paused.
  const reclaim = await access(mat, judge, deviceId, 'CLAIM');
  assert.equal(reclaim.result.status, 201);
  generation = reclaim.result.body.control.generation;
  assert.equal(
    (await sporting(mat, contest.id, judge, deviceId, generation, 'START')).result.status,
    201,
  );
  const revision = (await status(mat, owner.cookie)).accessRevision;
  const revokeBody = { id: randomUUID(), expectedRevision: revision, reason: 'Ротация судьи QA' };
  const race = await Promise.all([
    call(`/auth/invitations/${invitation.result.id}/revoke`, revokeBody, owner.cookie),
    sporting(mat, contest.id, judge, deviceId, generation, 'AWARD', { side: 'BLUE', kind: 'YUKO' }),
  ]);
  assert.equal(race[0].status, 201);
  assert.ok([201, 401, 409].includes(race[1].result.status));
  const racingReceipt = await db.matchEvent.findUnique({ where: { id: race[1].body.id } });
  assert.equal(!!racingReceipt, race[1].result.status === 201);
  assert.equal(await db.accessCommand.count({ where: { id: revokeBody.id } }), 1);
  assert.equal(
    (await db.contest.findUniqueOrThrow({ where: { id: contest.id } })).state.status,
    'PAUSED',
  );
  assert.equal((await call('/auth/me', undefined, judge.cookie)).status, 401);
  assert.deepEqual(
    await ok(`/auth/invitations/${invitation.result.id}/revoke`, revokeBody, owner.cookie),
    race[0].body,
  );
  const revokedStatus = await status(mat, owner.cookie);
  assert.equal(revokedStatus.control.held, true);
  assert.equal(revokedStatus.control.holderValid, false);
  assert.equal((await access(mat, owner, adminDevice, 'CLAIM')).result.status, 409);

  // Deadline invalidation never silently hands control to another device.
  const secondInvite = await issue(otherMat, owner, 'Судья со сроком');
  const secondJudge = await redeem(secondInvite, 'Судья со сроком');
  const secondDevice = randomUUID();
  assert.equal((await access(otherMat, secondJudge, secondDevice, 'CLAIM')).result.status, 201);
  await db.invitation.update({
    where: { id: secondInvite.result.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await call('/auth/me', undefined, secondJudge.cookie)).status, 401);
  assert.equal((await access(otherMat, owner, randomUUID(), 'CLAIM')).result.status, 409);
  assert.equal((await status(otherMat, owner.cookie)).control.holderValid, false);
  assert.equal(
    (
      await access(otherMat, owner, randomUUID(), 'TAKEOVER', {
        reason: 'Завершился срок доступа судьи',
      })
    ).result.status,
    201,
  );

  const expiredInvite = await issue(mat, owner, 'Судья с истекающей сессией');
  const expiredJudge = await redeem(expiredInvite, 'Судья с истекающей сессией');
  const expiredDevice = randomUUID();
  const expiredTakeover = await access(mat, owner, adminDevice, 'TAKEOVER', {
    reason: 'Подготовка проверки истечения судейской сессии QA',
  });
  assert.equal(expiredTakeover.result.status, 201);
  assert.equal((await access(mat, owner, adminDevice, 'RELEASE')).result.status, 201);
  const expiredClaim = await access(mat, expiredJudge, expiredDevice, 'CLAIM');
  assert.equal(expiredClaim.result.status, 201);
  assert.equal(
    (
      await sporting(
        mat,
        contest.id,
        expiredJudge,
        expiredDevice,
        expiredClaim.result.body.control.generation,
        'START',
      )
    ).result.status,
    201,
  );
  assert.equal(
    (
      await sporting(
        mat,
        contest.id,
        expiredJudge,
        expiredDevice,
        expiredClaim.result.body.control.generation,
        'HOLD',
        { side: 'BLUE' },
      )
    ).result.status,
    201,
  );
  await db.session.updateMany({
    where: { userId: expiredJudge.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const deadline = Date.now() + 5000;
  let expiredContest;
  do {
    await wait(100);
    expiredContest = await db.contest.findUniqueOrThrow({ where: { id: contest.id } });
  } while (expiredContest.state.status === 'RUNNING' && Date.now() < deadline);
  assert.equal(expiredContest.status, 'ACTIVE');
  assert.equal(expiredContest.state.status, 'PAUSED');
  assert.equal(expiredContest.state.hold.side, 'BLUE');
  assert.equal(expiredContest.clockAnchorMs, null);
  assert.equal((await status(mat, owner.cookie)).control.holderValid, false);
  assert.equal((await access(mat, owner, adminDevice, 'CLAIM')).result.status, 409);

  const finalTakeover = await access(mat, owner, adminDevice, 'TAKEOVER', {
    reason: 'Возобновление после отзыва доступа',
  });
  assert.equal(finalTakeover.result.status, 201);
  generation = finalTakeover.result.body.control.generation;
  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'START')).result.status,
    201,
  );
  assert.equal(
    (await sporting(mat, contest.id, owner, adminDevice, generation, 'TOKETA')).result.status,
    201,
  );
  assert.equal((await call('/auth/logout', {}, owner.cookie)).status, 201);
  assert.equal(
    (await db.contest.findUniqueOrThrow({ where: { id: contest.id } })).state.status,
    'PAUSED',
  );
  assert.equal((await call('/auth/me', undefined, owner.cookie)).status, 401);
  assert.equal((await status(mat, systemAdmin.cookie)).control.holderValid, false);
  assert.ok(
    await db.auditEvent.count({
      where: { tournamentId: tournament, action: 'MATCH_ACCESS_PAUSED' },
    }),
  );
  console.log(
    'PASS: ADMIN/JUDGE scope, exact invitation/control/revoke receipts, no stored plaintext token, concurrent single-tab control, stale generation, hold-preserving handover, legacy/stale offline rollback, revoke race, active expiry and logout pause.',
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
