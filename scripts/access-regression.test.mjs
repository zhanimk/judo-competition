import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { createMatch, applyCommand } from '@judo/engine/match';
import { AccessService } from '../apps/api/dist/modules/auth/access.service.js';
import { AuthService } from '../apps/api/dist/modules/auth/auth.service.js';
import {
  assertActivePrincipal,
  assertTatamiControl,
  workRole,
} from '../apps/api/dist/modules/auth/access-guards.js';
import {
  ControlAccessDto,
  RevokeInvitationDto,
  ControlAccessQuery,
} from '../apps/api/dist/modules/auth/access.dto.js';
import { InviteDto } from '../apps/api/dist/modules/auth/auth.dto.js';

const failure = (status, reason) => (error) =>
  error.getStatus() === status && error.message === reason;
const rules = {
  durationMs: 180000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [{ ms: 20000, score: 'IPPON' }],
};
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const future = () => new Date(Date.now() + 3600000);
function running(hold = false) {
  let state = createMatch(rules);
  state = applyCommand(state, { id: randomUUID(), expectedVersion: state.version, type: 'START' });
  if (hold)
    state = applyCommand(state, {
      id: randomUUID(),
      expectedVersion: state.version,
      type: 'HOLD',
      side: 'WHITE',
    });
  return applyCommand(state, {
    id: randomUUID(),
    expectedVersion: state.version,
    type: 'ADVANCE',
    ms: 1200,
  });
}
function harness() {
  const owner = {
    id: randomUUID(),
    name: 'Admin',
    role: 'ORGANIZER',
    sessionId: randomUUID(),
    tatamiId: null,
  };
  const judge = {
    id: randomUUID(),
    name: 'Judge',
    role: 'OPERATOR',
    sessionId: randomUUID(),
    tatamiId: randomUUID(),
  };
  const matId = judge.tatamiId;
  const tournamentId = randomUUID();
  const invitationId = randomUUID();
  const deviceId = randomUUID();
  let saved = {
    tournament: { id: tournamentId, ownerId: owner.id },
    mat: {
      id: matId,
      tournamentId,
      number: 1,
      status: 'IDLE',
      accessRevision: 0,
      controlGeneration: 0,
      controllerSessionId: null,
      controllerDeviceId: null,
      controllerActorId: null,
      controlledAt: null,
    },
    users: [owner, judge].map(({ id, name, role }) => ({ id, name, role })),
    sessions: [owner, judge].map((user) => ({
      id: user.sessionId,
      userId: user.id,
      tokenHash: tokenHash(user.sessionId),
      tatamiId: user.tatamiId,
      invitationId: user.id === judge.id ? invitationId : null,
      expiresAt: future(),
      user: { id: user.id, name: user.name, role: user.role },
    })),
    invitations: [
      {
        id: invitationId,
        tatamiId: matId,
        tokenHash: tokenHash('a'.repeat(64)),
        expiresAt: future(),
        usedAt: new Date(),
        revokedAt: null,
        label: 'Judge',
      },
    ],
    contests: [],
    commands: [],
    events: [],
    rosterCommands: [],
    audits: [],
  };
  let chain = Promise.resolve();
  const locks = [];
  const apply = (row, data) =>
    Object.fromEntries(
      Object.entries({ ...row, ...data }).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'increment' in value
          ? row[key] + value.increment
          : value,
      ]),
    );
  function adapter(state) {
    return {
      $queryRaw: async (strings) => {
        locks.push(strings.join(''));
        return [];
      },
      tournament: {
        findUnique: async ({ where }) =>
          where.id === tournamentId ? structuredClone(state.tournament) : null,
      },
      tatami: {
        findUnique: async ({ where }) => (where.id === matId ? structuredClone(state.mat) : null),
        findUniqueOrThrow: async () => structuredClone(state.mat),
        findFirst: async ({ where }) =>
          where.id === matId && (!where.tournamentId || where.tournamentId === tournamentId)
            ? structuredClone(state.mat)
            : null,
        findMany: async ({ where }) =>
          !where.controllerSessionId || where.controllerSessionId === state.mat.controllerSessionId
            ? [structuredClone(state.mat)]
            : [],
        update: async ({ data }) => {
          state.mat = apply(state.mat, data);
          return structuredClone(state.mat);
        },
      },
      user: {
        findUnique: async ({ where }) =>
          structuredClone(state.users.find((user) => user.id === where.id) ?? null),
        create: async ({ data }) => {
          const user = { id: randomUUID(), ...data };
          state.users.push(user);
          return structuredClone(user);
        },
      },
      session: {
        findUnique: async ({ where }) =>
          structuredClone(
            state.sessions.find((session) =>
              where.id ? session.id === where.id : session.tokenHash === where.tokenHash,
            ) ?? null,
          ),
        findMany: async ({ where }) =>
          structuredClone(
            state.sessions.filter(
              (session) => !where.invitationId || session.invitationId === where.invitationId,
            ),
          ),
        create: async ({ data }) => {
          const session = {
            id: randomUUID(),
            ...data,
            user: state.users.find((user) => user.id === data.userId),
          };
          state.sessions.push(session);
          return structuredClone(session);
        },
        deleteMany: async ({ where }) => {
          state.sessions = state.sessions.filter((session) =>
            where.invitationId
              ? session.invitationId !== where.invitationId
              : session.id !== where.id,
          );
          return { count: 1 };
        },
      },
      invitation: {
        findUnique: async ({ where, include }) => {
          const row = state.invitations.find((invite) =>
            where.id ? invite.id === where.id : invite.tokenHash === where.tokenHash,
          );
          return row
            ? structuredClone({ ...row, ...(include?.tatami ? { tatami: state.mat } : {}) })
            : null;
        },
        findUniqueOrThrow: async ({ where }) =>
          structuredClone(state.invitations.find((invite) => invite.id === where.id)),
        create: async ({ data }) => {
          if (state.invitations.some((invite) => invite.tokenHash === data.tokenHash))
            throw new Prisma.PrismaClientKnownRequestError('duplicate token', {
              code: 'P2002',
              clientVersion: 'test',
            });
          const invite = { id: randomUUID(), usedAt: null, revokedAt: null, ...data };
          state.invitations.push(invite);
          return structuredClone(invite);
        },
        update: async ({ where, data }) => {
          const i = state.invitations.findIndex((invite) => invite.id === where.id);
          state.invitations[i] = apply(state.invitations[i], data);
          return structuredClone(state.invitations[i]);
        },
      },
      contest: {
        findMany: async ({ where }) =>
          structuredClone(
            state.contests.filter(
              (row) => row.tatamiId === where.tatamiId && row.status === where.status,
            ),
          ),
        findFirst: async ({ where }) =>
          structuredClone(
            state.contests.find(
              (row) =>
                row.tatamiId === where.tatamiId &&
                row.status === where.status &&
                (where.offlineSessionId?.not === null ? row.offlineSessionId !== null : true),
            ) ?? null,
          ),
        update: async ({ where, data }) => {
          const i = state.contests.findIndex((row) => row.id === where.id);
          state.contests[i] = apply(state.contests[i], data);
          return structuredClone(state.contests[i]);
        },
      },
      accessCommand: {
        findUnique: async ({ where }) =>
          structuredClone(state.commands.find((row) => row.id === where.id) ?? null),
        findFirst: async ({ where }) =>
          structuredClone(state.commands.find((row) => where.id.in.includes(row.id)) ?? null),
        create: async ({ data }) => {
          state.commands.push(structuredClone(data));
          return data;
        },
      },
      matchEvent: {
        findFirst: async ({ where }) =>
          structuredClone(
            state.events.find(
              (row) =>
                where.OR[0].id.in.includes(row.id) ||
                (row.payload.events ?? []).some((event) => where.OR[0].id.in.includes(event.id)),
            ) ?? null,
          ),
        create: async ({ data }) => {
          state.events.push(structuredClone(data));
          return data;
        },
      },
      tournamentCommand: { findFirst: async () => null },
      rosterCommand: {
        findFirst: async ({ where }) =>
          structuredClone(state.rosterCommands.find((row) => where.id.in.includes(row.id)) ?? null),
      },
      drawCommand: { findFirst: async () => null },
      protocolCommand: { findFirst: async () => null },
      liveOutbox: { create: async () => ({ id: 1n }) },
      auditEvent: {
        create: async ({ data }) => {
          state.audits.push(structuredClone(data));
          return data;
        },
      },
    };
  }
  const db = {
    $transaction(callback) {
      const operation = chain.then(async () => {
        const staged = structuredClone(saved);
        const response = await callback(adapter(staged));
        saved = staged;
        return response;
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
  const service = new AccessService(db);
  return {
    service,
    owner,
    judge,
    matId,
    tournamentId,
    invitationId,
    deviceId,
    locks,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => fn(saved),
    tx: () => adapter(saved),
    packet: (type = 'CLAIM', extra = {}) => ({
      id: randomUUID(),
      expectedRevision: saved.mat.accessRevision,
      deviceId,
      type,
      ...extra,
    }),
    command: (dto, user = judge) => service.command(user, matId, dto),
    active(state, extra = {}) {
      saved.contests.push({
        id: randomUUID(),
        tatamiId: matId,
        status: 'ACTIVE',
        revision: 2,
        state,
        offlineSessionId: null,
        offlineActorId: null,
        offlineControlGeneration: null,
        clockAnchorMs: 100,
        clockEpoch: 'old',
        ...extra,
      });
    },
  };
}

test('two work roles preserve technical role identities', () => {
  assert.equal(workRole('SUPER_ADMIN'), 'ADMIN');
  assert.equal(workRole('ORGANIZER'), 'ADMIN');
  assert.equal(workRole('OPERATOR'), 'JUDGE');
  assert.equal(workRole('HEAD_REFEREE'), null);
});
test('access DTOs require UUID/version/token and a meaningful takeover/revoke reason', async () => {
  const h = harness();
  const invite = {
    id: randomUUID(),
    expectedRevision: 0,
    token: randomBytes(32).toString('hex'),
    label: 'Judge',
    hours: 1,
  };
  for (const [Type, value] of [
    [InviteDto, invite],
    [ControlAccessDto, h.packet()],
    [ControlAccessDto, h.packet('TAKEOVER', { reason: 'Replacing controller' })],
    [RevokeInvitationDto, { id: randomUUID(), expectedRevision: 0, reason: 'Shift ended' }],
    [ControlAccessQuery, {}],
  ])
    assert.equal((await validate(plainToInstance(Type, value))).length, 0);
  for (const [Type, value] of [
    [InviteDto, { ...invite, token: 'short' }],
    [InviteDto, { ...invite, expectedRevision: -1 }],
    [ControlAccessDto, h.packet('TAKEOVER')],
    [ControlAccessDto, h.packet('RELEASE', { deviceId: 'other' })],
    [RevokeInvitationDto, { id: randomUUID(), expectedRevision: 0, reason: '' }],
  ])
    assert.ok((await validate(plainToInstance(Type, value))).length > 0);
});
test('claim is explicit, revisioned and returns no holder session/device secrets', async () => {
  const h = harness();
  const before = await h.service.status(h.tx(), h.snapshot().mat, h.judge, h.deviceId);
  assert.equal(before.owned, false);
  const result = await h.command(h.packet());
  assert.equal(result.revision, 1);
  assert.equal(result.control.generation, 1);
  assert.equal(result.control.owned, true);
  assert.equal(result.control.holderName, 'Judge');
  assert.deepEqual(
    Object.keys(result.control).sort(),
    ['generation', 'held', 'owned', 'holderName', 'holderValid', 'acquiredAt'].sort(),
  );
  assert.equal(h.snapshot().commands.length, 1);
  assert.equal(h.snapshot().audits.length, 1);
  assert.ok(
    h.locks.findIndex((sql) => sql.includes('"Tournament"')) <
      h.locks.findIndex((sql) => sql.includes('"Tatami"')),
  );
  assert.ok(
    h.locks.findIndex((sql) => sql.includes('"Tatami"')) <
      h.locks.findIndex((sql) => sql.includes('"Session"')),
  );
});
test('another tab and another session cannot silently claim a held control', async () => {
  const h = harness();
  await h.command(h.packet());
  const before = h.snapshot();
  await assert.rejects(
    h.command(h.packet('CLAIM', { deviceId: randomUUID() })),
    failure(409, 'CONTROL_HELD'),
  );
  await assert.rejects(h.command(h.packet(), h.owner), failure(409, 'CONTROL_HELD'));
  assert.deepEqual(h.snapshot(), before);
});
test('expired and deleted holder tombstones never allow automatic acquisition', async () => {
  for (const expire of [true, false]) {
    const h = harness();
    await h.command(h.packet());
    h.mutate((saved) => {
      if (expire)
        saved.sessions.find((row) => row.id === h.judge.sessionId).expiresAt = new Date(0);
      else saved.sessions = saved.sessions.filter((row) => row.id !== h.judge.sessionId);
    });
    const status = await h.service.status(h.tx(), h.snapshot().mat, h.owner, randomUUID());
    assert.equal(status.held, true);
    assert.equal(status.holderValid, false);
    await assert.rejects(h.command(h.packet(), h.owner), failure(409, 'CONTROL_HELD'));
  }
});
test('exact receipt replay preserves the first response after later release; different command is rejected', async () => {
  const h = harness();
  const claim = h.packet();
  const first = await h.command(claim);
  await h.command(h.packet('RELEASE'));
  assert.deepEqual(await h.command(claim), first);
  const before = h.snapshot();
  await assert.rejects(
    h.command({ ...claim, deviceId: randomUUID() }),
    failure(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});
test('stale access version rolls back the whole command', async () => {
  const h = harness();
  await h.command(h.packet());
  const before = h.snapshot();
  await assert.rejects(
    h.command(h.packet('RELEASE', { expectedRevision: 0 })),
    failure(409, 'ACCESS_VERSION_CONFLICT'),
  );
  assert.deepEqual(h.snapshot(), before);
});
test('release requires a paused hold-free online encounter', async () => {
  for (const [state, extra, code] of [
    [running(), {}, 'PAUSE_REQUIRED'],
    [running(true), {}, 'RESOLVE_HOLD_FIRST'],
    [
      createMatch(rules),
      {
        offlineSessionId: randomUUID(),
        offlineActorId: 'offline-judge',
        offlineControlGeneration: 1,
      },
      'OFFLINE_OWNED',
    ],
  ]) {
    const h = harness();
    await h.command(h.packet());
    h.active(state, extra);
    const before = h.snapshot();
    await assert.rejects(h.command(h.packet('RELEASE')), failure(409, code));
    assert.deepEqual(h.snapshot(), before);
  }
  const h = harness();
  await h.command(h.packet());
  h.active({ ...running(), status: 'PAUSED' });
  const result = await h.command(h.packet('RELEASE'));
  assert.equal(result.control.held, false);
  assert.equal(result.control.generation, 2);
  assert.equal(h.snapshot().contests[0].status, 'ACTIVE');
});
test('administrator takeover pauses the last saved time and retains the hold, awards and reservation', async () => {
  const h = harness();
  await h.command(h.packet());
  const original = running(true);
  h.active(original);
  const result = await h.command(
    h.packet('TAKEOVER', { reason: 'Replacing an unavailable device' }),
    h.owner,
  );
  const saved = h.snapshot();
  assert.equal(result.control.owned, true);
  assert.equal(result.control.generation, 2);
  assert.equal(saved.contests[0].status, 'ACTIVE');
  assert.equal(saved.contests[0].state.status, 'PAUSED');
  assert.equal(saved.contests[0].state.elapsedMs, original.elapsedMs);
  assert.deepEqual(saved.contests[0].state.hold, original.hold);
  assert.deepEqual(saved.contests[0].state.awards, original.awards);
  assert.equal(saved.contests[0].state.version, original.version + 1);
  assert.equal(saved.contests[0].revision, 3);
  assert.equal(saved.contests[0].clockAnchorMs, null);
  assert.equal(
    saved.audits.find((row) => row.action === 'MATCH_ACCESS_PAUSED').payload.clockUncertain,
    true,
  );
});
test('takeover requires administrator and refuses an unresolved offline reservation', async () => {
  const h = harness();
  await h.command(h.packet());
  await assert.rejects(
    h.command(h.packet('TAKEOVER', { reason: 'Forbidden replacement' })),
    failure(403, 'FORBIDDEN'),
  );
  h.active(createMatch(rules), {
    offlineSessionId: randomUUID(),
    offlineActorId: h.judge.id,
    offlineControlGeneration: 1,
  });
  const before = h.snapshot();
  await assert.rejects(
    h.command(h.packet('TAKEOVER', { reason: 'Device replacement' }), h.owner),
    failure(409, 'OFFLINE_OWNED'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('claim, release and takeover fail closed on every partial offline lease without changing the grant or journal', async () => {
  for (let mask = 1; mask < 7; mask++)
    for (const type of ['CLAIM', 'RELEASE', 'TAKEOVER']) {
      const h = harness();
      await h.command(h.packet());
      h.active(
        { ...running(), status: 'PAUSED' },
        {
          offlineSessionId: mask & 1 ? randomUUID() : null,
          offlineActorId: mask & 2 ? h.judge.id : null,
          offlineControlGeneration: mask & 4 ? 0 : null,
        },
      );
      const before = h.snapshot();
      await assert.rejects(
        h.command(
          h.packet(type, type === 'TAKEOVER' ? { reason: 'Reviewed device replacement' } : {}),
          type === 'TAKEOVER' ? h.owner : h.judge,
        ),
        failure(409, 'OFFLINE_METADATA_INCOMPLETE'),
      );
      assert.deepEqual(h.snapshot(), before);
    }
});

test('historical access receipts remain read-only after partial offline metadata appears', async () => {
  for (const partial of [{ offlineActorId: 'saved-actor' }, { offlineControlGeneration: 0 }]) {
    const h = harness();
    const claim = h.packet();
    const original = await h.command(claim);
    h.active({ ...running(), status: 'PAUSED' }, partial);
    const before = h.snapshot();
    assert.deepEqual(await h.command(claim), original);
    assert.deepEqual(h.snapshot(), before);
    await assert.rejects(h.command(h.packet()), failure(409, 'OFFLINE_METADATA_INCOMPLETE'));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('logout and revocation still pause partial offline snapshots and preserve their saved ownership evidence', async () => {
  for (const action of ['LOGOUT', 'REVOKE'])
    for (const partial of [{ offlineActorId: 'saved-actor' }, { offlineControlGeneration: 0 }]) {
      const h = harness();
      await h.command(h.packet());
      h.active(running(true), partial);
      const before = h.snapshot();
      if (action === 'LOGOUT') await h.service.logout(h.judge);
      else
        await h.service.revoke(h.owner, h.invitationId, {
          id: randomUUID(),
          expectedRevision: before.mat.accessRevision,
          reason: 'Judge access terminated',
        });
      const after = h.snapshot();
      assert.equal(after.contests[0].status, 'ACTIVE');
      assert.equal(after.contests[0].state.status, 'PAUSED');
      assert.equal(after.contests[0].state.elapsedMs, before.contests[0].state.elapsedMs);
      assert.deepEqual(after.contests[0].state.hold, before.contests[0].state.hold);
      assert.deepEqual(after.contests[0].state.awards, before.contests[0].state.awards);
      for (const field of ['offlineSessionId', 'offlineActorId', 'offlineControlGeneration'])
        assert.equal(after.contests[0][field], before.contests[0][field]);
      assert.equal(
        after.sessions.some((session) => session.id === h.judge.sessionId),
        false,
      );
      assert.equal(after.events.at(-1).type, 'CONTROL_ACCESS_PAUSED');
    }
});
test('sporting grant checks live principal, tab identity and generation', async () => {
  const h = harness();
  await h.command(h.packet());
  const grant = { deviceId: h.deviceId, controlGeneration: 1 };
  await assertTatamiControl(h.tx(), h.judge, h.matId, grant);
  await assert.rejects(
    assertTatamiControl(h.tx(), h.judge, h.matId, { ...grant, controlGeneration: 0 }),
    failure(409, 'CONTROL_GENERATION_STALE'),
  );
  await assert.rejects(
    assertTatamiControl(h.tx(), h.judge, h.matId, { ...grant, deviceId: randomUUID() }),
    failure(409, 'CONTROL_HELD'),
  );
  h.mutate((saved) => {
    saved.invitations[0].expiresAt = new Date(0);
  });
  await assert.rejects(
    assertTatamiControl(h.tx(), h.judge, h.matId, grant),
    failure(401, 'AUTH_REQUIRED'),
  );
});
test('transaction principal guard rejects role/session/scope changes after AuthGuard', async () => {
  const h = harness();
  const scope = { tournamentId: h.tournamentId, tatamiId: h.matId };
  await assertActivePrincipal(h.tx(), h.judge, scope);
  await assert.rejects(
    assertActivePrincipal(h.tx(), h.judge, { tournamentId: h.tournamentId }),
    failure(403, 'FORBIDDEN'),
  );
  await assert.rejects(
    assertActivePrincipal(h.tx(), { ...h.owner, id: randomUUID() }, scope),
    failure(401, 'AUTH_REQUIRED'),
  );
  h.mutate((saved) => {
    saved.sessions.find((row) => row.id === h.owner.sessionId).user.role = 'OPERATOR';
  });
  await assert.rejects(
    assertActivePrincipal(h.tx(), h.owner, scope),
    failure(401, 'AUTH_REQUIRED'),
  );
});
test('invitation command persists only hashes, exact retries recover the same token and receipt', async () => {
  const h = harness();
  const token = randomBytes(32).toString('hex');
  const dto = { id: randomUUID(), expectedRevision: 0, label: 'New judge', hours: 1, token };
  const response = await h.service.invite(h.owner, h.matId, dto);
  assert.equal(response.token, token);
  assert.deepEqual(await h.service.invite(h.owner, h.matId, dto), response);
  assert.ok(!JSON.stringify(h.snapshot()).includes(token));
  assert.equal(h.snapshot().commands[0].command.tokenHash, tokenHash(token));
  const before = h.snapshot();
  await assert.rejects(
    h.service.invite(h.owner, h.matId, { ...dto, token: randomBytes(32).toString('hex') }),
    failure(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});
test('invitation issue is administrator-only and old access versions cannot issue tokens', async () => {
  const h = harness();
  const dto = {
    id: randomUUID(),
    expectedRevision: 0,
    label: 'New judge',
    hours: 1,
    token: randomBytes(32).toString('hex'),
  };
  await assert.rejects(h.service.invite(h.judge, h.matId, dto), failure(403, 'FORBIDDEN'));
  await h.command(h.packet());
  await assert.rejects(
    h.service.invite(h.owner, h.matId, dto),
    failure(409, 'ACCESS_VERSION_CONFLICT'),
  );
});
test('reused invitation secret is a deterministic conflict with no partial mutation', async () => {
  const h = harness();
  const before = h.snapshot();
  await assert.rejects(
    h.service.invite(h.owner, h.matId, {
      id: randomUUID(),
      expectedRevision: 0,
      label: 'Collision',
      hours: 1,
      token: 'a'.repeat(64),
    }),
    failure(409, 'INVITATION_TOKEN_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});
test('revoke pauses hold without losing it, invalidates generation and leaves sticky ownership with exact receipt', async () => {
  const h = harness();
  await h.command(h.packet());
  const state = running(true);
  h.active(state, {
    offlineSessionId: randomUUID(),
    offlineControlGeneration: 1,
    offlineActorId: h.judge.id,
  });
  const dto = { id: randomUUID(), expectedRevision: 1, reason: 'Judge device lost' };
  const response = await h.service.revoke(h.owner, h.invitationId, dto);
  const saved = h.snapshot();
  assert.equal(response.control.generation, 2);
  assert.equal(response.control.held, true);
  assert.equal(response.control.holderValid, false);
  assert.ok(!saved.sessions.some((row) => row.id === h.judge.sessionId));
  assert.equal(saved.contests[0].state.status, 'PAUSED');
  assert.deepEqual(saved.contests[0].state.hold, state.hold);
  assert.equal(saved.contests[0].offlineControlGeneration, 1);
  assert.ok(saved.contests[0].offlineSessionId);
  assert.deepEqual(await h.service.revoke(h.owner, h.invitationId, dto), response);
});
test('logout pauses, keeps holder tombstone and offline evidence, then deletes only the session', async () => {
  const h = harness();
  await h.command(h.packet());
  h.active(running(true), { offlineSessionId: randomUUID(), offlineControlGeneration: 1 });
  await h.service.logout(h.judge);
  const saved = h.snapshot();
  assert.equal(saved.mat.controllerSessionId, h.judge.sessionId);
  assert.equal(saved.mat.controlGeneration, 2);
  assert.equal(saved.mat.accessRevision, 2);
  assert.equal(saved.contests[0].state.status, 'PAUSED');
  assert.ok(saved.contests[0].state.hold);
  assert.ok(saved.contests[0].offlineSessionId);
  assert.ok(saved.users.some((row) => row.id === h.judge.id));
  assert.ok(!saved.sessions.some((row) => row.id === h.judge.sessionId));
});
test('concurrent logout delivery invalidates control and audits once even after both requests passed AuthGuard', async () => {
  const h = harness();
  await h.command(h.packet());
  h.active(running(true));
  const before = h.snapshot();
  await Promise.all([h.service.logout(h.judge), h.service.logout(h.judge)]);
  const after = h.snapshot();
  assert.equal(after.mat.controlGeneration, before.mat.controlGeneration + 1);
  assert.equal(after.mat.accessRevision, before.mat.accessRevision + 1);
  assert.equal(after.audits.filter((row) => row.action === 'ACCESS_LOGOUT').length, 1);
  assert.equal(after.events.filter((row) => row.type === 'CONTROL_ACCESS_PAUSED').length, 1);
  assert.equal(after.contests[0].revision, before.contests[0].revision + 1);
  assert.equal(after.contests[0].state.status, 'PAUSED');
  assert.deepEqual(after.contests[0].state.hold, before.contests[0].state.hold);
  assert.deepEqual(after.commands, before.commands);
  assert.ok(!after.sessions.some((row) => row.id === h.judge.sessionId));
  await h.service.logout(h.judge);
  assert.deepEqual(h.snapshot(), after, 'a delivery with an already deleted session is a no-op');
});
test('accept is one-use and session expiry never outlives the invitation', async () => {
  const h = harness();
  const token = randomBytes(32).toString('hex');
  const deadline = new Date(Date.now() + 10000);
  h.mutate((saved) =>
    saved.invitations.push({
      id: randomUUID(),
      tatamiId: h.matId,
      tokenHash: tokenHash(token),
      expiresAt: deadline,
      revokedAt: null,
      usedAt: null,
    }),
  );
  const results = await Promise.allSettled([
    h.service.accept(token, 'First'),
    h.service.accept(token, 'Second'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.getStatus(), 401);
  const created = h
    .snapshot()
    .sessions.find((session) => ![h.owner.sessionId, h.judge.sessionId].includes(session.id));
  assert.equal(created.expiresAt.getTime(), deadline.getTime());
  assert.equal(created.user.role, 'OPERATOR');
  assert.equal(h.snapshot().audits[0].action, 'ACCESS_ACCEPT_INVITATION');
});
test('authenticate rejects an expired accepted invitation even while session remains alive', async () => {
  const h = harness();
  const token = 'b'.repeat(64);
  h.mutate((saved) => {
    saved.sessions.find((row) => row.id === h.judge.sessionId).tokenHash = tokenHash(token);
    saved.invitations[0].expiresAt = new Date(0);
  });
  const auth = new AuthService(h.tx(), h.service);
  assert.equal(await auth.authenticate('judo_session=' + token), null);
});
test('access commands reject sporting, legacy nested offline and roster UUID reuse atomically', async () => {
  for (const type of ['MATCH', 'LEGACY_OFFLINE', 'ROSTER']) {
    const h = harness();
    const packet = h.packet();
    h.mutate((saved) => {
      if (type === 'MATCH') saved.events.push({ id: packet.id, payload: {} });
      else if (type === 'LEGACY_OFFLINE')
        saved.events.push({ id: randomUUID(), payload: { events: [{ id: packet.id }] } });
      else saved.rosterCommands.push({ id: packet.id });
    });
    const before = h.snapshot();
    await assert.rejects(h.command(packet), failure(409, 'COMMAND_ID_REUSED'));
    assert.deepEqual(h.snapshot(), before);
  }
});
