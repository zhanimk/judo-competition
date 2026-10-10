import { fixtureRequest } from './test-access.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestUser, useLegacyRules } from './test-user.mjs';
const db = new PrismaClient(),
  base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4318/api/v1';
let cookie = '',
  owner,
  tournament,
  foreignTournament,
  judgeId;
async function call(path, data, auth = cookie) {
  const r = await fixtureRequest(base, path, data, auth);
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
try {
  owner = await createTestUser(db);
  cookie = (await call('/auth/login', { email: owner.email, password: owner.password })).cookie;
  const t = await call('/tournaments', {
    name: 'Draw integration',
    city: 'Test',
    venue: 'Test',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
    tatamiCount: 2,
  });
  assert.equal(t.status, 201);
  tournament = t.body.id;
  await useLegacyRules(db, tournament);
  const c = await call(`/tournaments/${tournament}/categories`, {
    name: 'Draw test',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
  });
  assert.equal(c.status, 201);
  const path = `/categories/${c.body.id}/draw`,
    entryPath = `/tournaments/${tournament}/categories/${c.body.id}/entries`;
  assert.equal((await call(path)).body.draw, null);
  assert.equal((await call(path + '/preview', {})).status, 400);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await call(entryPath, {
          firstName: 'Test',
          lastName: 'Athlete ' + i,
          club: 'Club ' + i,
          birthYear: 2012,
        })
      ).status,
      201,
    );
  const first = await call(path + '/preview', {});
  assert.equal(first.status, 201);
  await call(entryPath, {
    firstName: 'Test',
    lastName: 'Athlete 3',
    club: 'Club 0',
    birthYear: 2012,
  });
  assert.equal((await call(path + '/confirm', { version: first.body.version })).status, 409);
  const preview = await call(path + '/preview', {});
  assert.equal(preview.body.snapshot.size, 4);
  assert.equal((await call(path + '/confirm', { version: first.body.version })).status, 409);
  assert.equal((await call(path, undefined, '')).status, 401);
  const parallel = await Promise.all([
    call(path + '/confirm', { version: preview.body.version }),
    call(path + '/confirm', { version: preview.body.version }),
  ]);
  for (const r of parallel) {
    assert.equal(r.status, 201);
    assert.equal(r.body.contests.length, 2);
  }
  assert.equal((await call(path)).body.draw.status, 'CONFIRMED');
  assert.equal(await db.contest.count({ where: { drawId: preview.body.id } }), 2);
  assert.equal(
    await db.auditEvent.count({ where: { entityId: preview.body.id, action: 'DRAW_CONFIRMED' } }),
    1,
  );
  assert.equal(
    (
      await call(entryPath, {
        firstName: 'Blocked',
        lastName: 'Test',
        club: 'Club',
        birthYear: 2012,
      })
    ).status,
    409,
  );
  assert.equal((await call(path + '/preview', {})).status, 409);
  const mats = (await call(`/tournaments/${tournament}/tatamis`)).body;
  const ready = parallel[0].body.contests.find((c) => c.status === 'READY'),
    waiting = parallel[0].body.contests.find((c) => c.status === 'WAITING');
  const assignment = (row, tatamiId, extra = {}) => ({
    id: randomUUID(),
    expectedRevision: row.revision,
    tatamiId,
    ...extra,
  });
  const assignPath = `/contests/${ready.id}/assign`;
  const unassigned = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  for (const invalid of [
    { tatamiId: mats[0].id },
    assignment(ready, mats[0].id, { id: 'invalid' }),
    assignment(ready, mats[0].id, { expectedRevision: -1 }),
    assignment(ready, mats[0].id, { expectedRevision: 0.5 }),
    assignment(ready, mats[0].id, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }),
  ])
    assert.equal((await call(assignPath, invalid)).status, 400);
  assert.equal((await call(assignPath, assignment(ready, mats[0].id), '')).status, 401);
  const invite = await call(`/auth/tatamis/${mats[0].id}/invitations`, {
    label: 'Assignment QA judge',
    hours: 1,
  });
  assert.equal(invite.status, 201);
  const judge = await call(
    '/auth/invitations/accept',
    { token: invite.body.token, name: 'Assignment QA judge' },
    '',
  );
  assert.equal(judge.status, 201);
  judgeId = (await call('/auth/me', undefined, judge.cookie)).body.id;
  assert.equal((await call(assignPath, assignment(ready, mats[0].id), judge.cookie)).status, 403);
  foreignTournament = (
    await call('/tournaments', {
      name: 'Assignment foreign-mat QA',
      city: 'Test',
      venue: 'Test',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    })
  ).body.id;
  const [foreignMat] = (await call(`/tournaments/${foreignTournament}/tatamis`)).body;
  assert.equal(
    (await call(assignPath, assignment(ready, foreignMat.id))).body.message,
    'TATAMI_MISMATCH',
  );
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: ready.id } }), unassigned);
  assert.equal(
    (await db.category.findUniqueOrThrow({ where: { id: c.body.id } })).homeTatamiId,
    null,
  );
  assert.equal(
    (await call(`/contests/${waiting.id}/assign`, assignment(waiting, mats[0].id))).body.message,
    'MATCH_NOT_ASSIGNABLE',
  );
  const competingCommands = mats.map((mat) => assignment(ready, mat.id));
  const assigned = await Promise.all(competingCommands.map((dto) => call(assignPath, dto)));
  assert.deepEqual(assigned.map((r) => r.status).sort(), [201, 409]);
  assert.equal(assigned.find((r) => r.status === 409).body.message, 'VERSION_CONFLICT');
  const winnerIndex = assigned.findIndex((r) => r.status === 201);
  const winningCommand = competingCommands[winnerIndex];
  const savedResponse = assigned[winnerIndex].body;
  const matId = savedResponse.tatamiId;
  assert.equal(savedResponse.revision, ready.revision + 1);
  const savedRow = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  const repeated = await Promise.all([
    call(assignPath, winningCommand),
    call(assignPath, winningCommand),
  ]);
  assert.deepEqual(
    repeated.map((r) => r.status),
    [201, 201],
  );
  for (const retry of repeated) assert.deepEqual(retry.body, savedResponse);
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: ready.id } }), savedRow);
  assert.equal(await db.matchEvent.count({ where: { id: winningCommand.id } }), 1);
  assert.equal(
    await db.auditEvent.count({ where: { entityId: ready.id, action: 'MATCH_ASSIGNED' } }),
    1,
  );
  const receipt = await db.matchEvent.findUniqueOrThrow({ where: { id: winningCommand.id } });
  assert.deepEqual(receipt.payload, { command: winningCommand, response: savedResponse });
  for (const changed of [
    { ...winningCommand, tatamiId: mats.find((mat) => mat.id !== matId).id },
    { ...winningCommand, expectedRevision: savedResponse.revision },
  ])
    assert.equal((await call(assignPath, changed)).body.message, 'COMMAND_ID_REUSED');
  assert.equal((await call(assignPath, assignment(ready, matId))).body.message, 'VERSION_CONFLICT');
  assert.equal(
    (await call(assignPath, assignment(savedRow, matId))).body.message,
    'MATCH_NOT_ASSIGNABLE',
  );
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: ready.id } }), savedRow);
  assert.equal(
    (await call(`/contests/${waiting.id}/assign`, winningCommand)).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.equal(
    (await db.category.findUniqueOrThrow({ where: { id: c.body.id } })).homeTatamiId,
    matId,
  );
  const secondCategory = await call(`/tournaments/${tournament}/categories`, {
    name: 'Assignment category pins QA',
    gender: 'MALE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 60000,
    durationSeconds: 180,
  });
  assert.equal(secondCategory.status, 201);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (
        await call(`/tournaments/${tournament}/categories/${secondCategory.body.id}/entries`, {
          firstName: 'Assignment',
          lastName: `Athlete ${i}`,
          club: `Club ${i}`,
          birthYear: 2012,
        })
      ).status,
      201,
    );
  const secondPreview = await call(`/categories/${secondCategory.body.id}/draw/preview`, {});
  const secondDraw = await call(`/categories/${secondCategory.body.id}/draw/confirm`, {
    version: secondPreview.body.version,
  });
  assert.equal(secondDraw.status, 201);
  const secondOpening = secondDraw.body.contests.filter((contest) => contest.status === 'READY');
  const categoryRace = await Promise.all([
    call(`/contests/${secondOpening[0].id}/assign`, assignment(secondOpening[0], matId)),
    call(
      `/contests/${secondOpening[1].id}/assign`,
      assignment(secondOpening[1], mats.find((mat) => mat.id !== matId).id),
    ),
  ]);
  assert.deepEqual(categoryRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(categoryRace.find((r) => r.status === 409).body.message, 'CATEGORY_TATAMI_LOCKED');
  const pinned = await db.category.findUniqueOrThrow({ where: { id: secondCategory.body.id } });
  const blockedIndex = categoryRace.findIndex((r) => r.status === 409);
  const blocked = await db.contest.findUniqueOrThrow({
    where: { id: secondOpening[blockedIndex].id },
  });
  assert.equal(blocked.tatamiId, null);
  assert.equal(blocked.revision, 0);
  const legacyId = randomUUID();
  // A removable fixture reproduces a pre-upgrade packet without separate nested receipts.
  await db.matchEvent.create({
    data: {
      id: randomUUID(),
      contestId: waiting.id,
      actorId: owner.id,
      type: 'OFFLINE_SYNC',
      payload: { events: [{ id: legacyId, expectedVersion: 0, type: 'START' }] },
    },
  });
  assert.equal(
    (
      await call(
        `/contests/${blocked.id}/assign`,
        assignment(blocked, pinned.homeTatamiId, {
          id: legacyId,
        }),
      )
    ).body.message,
    'COMMAND_ID_REUSED',
  );
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: blocked.id } }), blocked);
  assert.equal(await db.matchEvent.count({ where: { id: legacyId } }), 0);
  assert.equal(
    (await call(`/contests/${blocked.id}/assign`, assignment(blocked, pinned.homeTatamiId))).status,
    201,
  );
  const queued = await db.contest.findMany({ where: { tatamiId: pinned.homeTatamiId } });
  assert.equal(new Set(queued.map((contest) => contest.queueOrder)).size, queued.length);
  assert.equal(
    (await call(`/tournaments/${tournament}/tatamis/${matId}`, undefined, '')).status,
    404,
  );
  const pub = await call(`/tournaments/${tournament}/tatamis/${matId}`);
  assert.equal(pub.status, 200);
  assert.ok(pub.body.queue.some((contest) => contest.id === ready.id));
  assert.ok(pub.body.queue[0].white.lastName);
  assert.equal(pub.body.currentMatch, null);
  const control = await call(`/auth/tatamis/${matId}/control`);
  assert.deepEqual(control.body.queue, pub.body.queue);
  await call(`/tournaments/${tournament}/publish`, {});
  assert.deepEqual(
    (await call(`/tournaments/${tournament}/tatamis/${matId}`, undefined, '')).body.queue,
    pub.body.queue,
  );
  const destination = mats.find((mat) => mat.id !== matId).id;
  const impact = (await call(`/tournaments/${tournament}/control/${ready.id}/impact`)).body;
  assert.equal(
    (
      await call(`/tournaments/${tournament}/control/${ready.id}/command`, {
        id: randomUUID(),
        expectedRevision: impact.revision,
        impactToken: impact.impactToken,
        reason: 'Assignment QA deliberate transfer',
        type: 'MOVE',
        tatamiId: destination,
      })
    ).status,
    201,
  );
  const movedRow = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  assert.equal(movedRow.tatamiId, destination);
  assert.deepEqual((await call(assignPath, winningCommand)).body, savedResponse);
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: ready.id } }), movedRow);
  assert.equal((await call(`/tournaments/${tournament}/start`, {})).status, 201);
  const start = await call(`/tatamis/${destination}/live/${ready.id}/command`, {
    id: randomUUID(),
    expectedVersion: movedRow.revision,
    type: 'START',
  });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  assert.deepEqual((await call(assignPath, winningCommand)).body, savedResponse);
  assert.equal(
    (await call(assignPath, assignment({ revision: start.body.revision }, destination))).body
      .message,
    'MATCH_NOT_ASSIGNABLE',
  );
  // ACTIVE includes a paused operator bout. Keep its clock stable while proving
  // that returning another READY bout to a BUSY home mat never rewrites it.
  const pause = await call(`/tatamis/${destination}/live/${ready.id}/command`, {
    id: randomUUID(),
    expectedVersion: start.body.revision,
    type: 'STOP',
  });
  assert.equal(pause.status, 201, JSON.stringify(pause.body));
  let busyContestId = ready.id;
  if (pinned.homeTatamiId !== destination) {
    const queue = (await call(`/tournaments/${tournament}/tatamis/${pinned.homeTatamiId}`)).body
      .queue;
    const sideStart = await call(`/tatamis/${pinned.homeTatamiId}/live/${queue[0].id}/command`, {
      id: randomUUID(),
      expectedVersion: queue[0].revision,
      type: 'START',
    });
    assert.equal(sideStart.status, 201, JSON.stringify(sideStart.body));
    const sideStop = await call(`/tatamis/${pinned.homeTatamiId}/live/${queue[0].id}/command`, {
      id: randomUUID(),
      expectedVersion: sideStart.body.revision,
      type: 'STOP',
    });
    assert.equal(sideStop.status, 201, JSON.stringify(sideStop.body));
    busyContestId = queue[0].id;
  }
  const readySibling = await db.contest.findFirstOrThrow({
    where: { drawId: secondDraw.body.id, status: 'READY', tatamiId: pinned.homeTatamiId },
  });
  const busyBefore = await db.contest.findUniqueOrThrow({ where: { id: busyContestId } });
  assert.equal(busyBefore.status, 'ACTIVE');
  const removeImpact = (await call(`/tournaments/${tournament}/control/${readySibling.id}/impact`))
    .body;
  assert.equal(
    (
      await call(`/tournaments/${tournament}/control/${readySibling.id}/command`, {
        id: randomUUID(),
        expectedRevision: removeImpact.revision,
        impactToken: removeImpact.impactToken,
        reason: 'Assignment QA remove a ready sibling',
        type: 'REMOVE',
      })
    ).status,
    201,
  );
  const removed = await db.contest.findUniqueOrThrow({ where: { id: readySibling.id } });
  assert.equal(removed.tatamiId, null);
  const returned = await call(
    `/contests/${removed.id}/assign`,
    assignment(removed, pinned.homeTatamiId),
  );
  assert.equal(returned.status, 201, JSON.stringify(returned.body));
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: busyContestId } }),
    busyBefore,
  );
  assert.equal(
    (await db.tatami.findUniqueOrThrow({ where: { id: pinned.homeTatamiId } })).status,
    'BUSY',
  );
  assert.equal(
    (await db.category.findUniqueOrThrow({ where: { id: secondCategory.body.id } })).homeTatamiId,
    pinned.homeTatamiId,
  );
  let currentRevision = pause.body.revision;
  for (const command of [{ type: 'AWARD', side: 'WHITE', kind: 'IPPON' }, { type: 'CONFIRM' }]) {
    const result = await call(`/tatamis/${destination}/live/${ready.id}/command`, {
      id: randomUUID(),
      expectedVersion: currentRevision,
      ...command,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    currentRevision = result.body.revision;
  }
  const confirmedRow = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
  assert.equal(confirmedRow.status, 'CONFIRMED');
  assert.deepEqual((await call(assignPath, winningCommand)).body, savedResponse);
  assert.equal(
    (await call(assignPath, assignment(confirmedRow, destination))).body.message,
    'MATCH_NOT_ASSIGNABLE',
  );
  assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: ready.id } }), confirmedRow);
  assert.equal(await db.matchEvent.count({ where: { id: winningCommand.id } }), 1);
  assert.equal(
    await db.auditEvent.count({ where: { entityId: ready.id, action: 'MATCH_ASSIGNED' } }),
    1,
  );
  console.log(
    'PASS: draw preview/confirmation and roster lock; protected assignment DTO/access/version, concurrent exact retries and competing assignments, fixed category race, legacy ID reuse, single receipt/audit, queue uniqueness, original response after transfer/start/confirmation, READY return to BUSY home mat without touching ACTIVE, shared public/operator queue.',
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
  if (foreignTournament) {
    await db.tatami.deleteMany({ where: { tournamentId: foreignTournament } });
    await db.tournament.delete({ where: { id: foreignTournament } });
  }
  if (judgeId) await db.user.delete({ where: { id: judgeId } });
  if (owner) await db.user.delete({ where: { id: owner.id } });
  await db.$disconnect();
}
