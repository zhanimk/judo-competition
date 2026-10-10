import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { applyCommand, createMatch } from '@judo/engine/match';
import { generateDraw } from '@judo/engine/draw';
import { ControlService } from '../apps/api/dist/modules/control/control.service.js';
import { ControlCommandDto } from '../apps/api/dist/modules/control/control.dto.js';
import { MatchCommandDto, OfflineEventDto } from '../apps/api/dist/modules/matches/matches.dto.js';

const rejects = (status, reason) => (error) =>
  error.getStatus() === status && error.message === reason;
const rules = {
  durationMs: 60000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
};
function pausedState() {
  let state = createMatch(rules);
  for (const command of [
    { type: 'START' },
    { type: 'ADVANCE', ms: 12000 },
    { type: 'STOP' },
    { type: 'AWARD', side: 'WHITE', kind: 'YUKO' },
  ])
    state = applyCommand(state, { id: randomUUID(), expectedVersion: state.version, ...command });
  state.receipts = {};
  return state;
}
function fixture() {
  const owner = {
    id: randomUUID(),
    role: 'ORGANIZER',
    name: 'Clock QA',
    sessionId: randomUUID(),
    tatamiId: null,
  };
  const tournamentId = randomUUID(),
    matId = randomUUID(),
    categoryId = randomUUID();
  const entries = [1, 2].map(() => ({
    id: randomUUID(),
    athleteId: randomUUID(),
    categoryId,
    archivedAt: null,
  }));
  const draw = generateDraw(
    'REPECHAGE',
    entries.map((entry) => ({ id: entry.id, clubId: 'fixture-club' })),
    42,
    'REPECHAGE_ONLY',
  );
  let saved = {
    row: {
      id: randomUUID(),
      drawId: randomUUID(),
      key: draw.matches[0].id,
      round: 1,
      tatamiId: matId,
      queueOrder: 1,
      revision: 7,
      status: 'ACTIVE',
      state: pausedState(),
      whiteEntryId: entries[0].id,
      blueEntryId: entries[1].id,
      offlineSessionId: null,
      offlineActorId: null,
      offlineControlGeneration: null,
      clockAnchorMs: 12,
      clockEpoch: 'expired-anchor',
      winnerEntryId: null,
      resultReason: null,
      confirmedAt: null,
      draw: { id: randomUUID(), categoryId, snapshot: draw, status: 'CONFIRMED' },
    },
    mat: {
      id: matId,
      tournamentId,
      status: 'BUSY',
      accessRevision: 3,
      controlGeneration: 4,
      controllerSessionId: owner.sessionId,
      controllerActorId: owner.id,
      controllerDeviceId: randomUUID(),
    },
    session: {
      id: owner.sessionId,
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3600000),
      invitationId: null,
      user: { id: owner.id, role: owner.role },
    },
    entries,
    events: [],
    audits: [],
    accessCommands: [],
    rosterCommands: [],
    foreignBusy: false,
  };
  const locks = [],
    notices = [];
  const update = (row, data) =>
    Object.fromEntries(
      Object.entries({ ...row, ...data }).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'increment' in value
          ? row[key] + value.increment
          : value,
      ]),
    );
  function tx(state) {
    return {
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('');
        locks.push(sql);
        return sql.includes('FROM "Athlete"')
          ? state.entries
              .filter((entry) => entry.athleteId === values[0])
              .map((entry) => ({ id: entry.athleteId }))
          : [];
      },
      tournament: {
        findUnique: async ({ where }) =>
          where.id === tournamentId ? { id: tournamentId, ownerId: owner.id } : null,
      },
      session: {
        findUnique: async ({ where }) =>
          where.id === owner.sessionId ? structuredClone(state.session) : null,
      },
      invitation: { findUnique: async () => null },
      tatami: {
        findUnique: async () => structuredClone(state.mat),
        findUniqueOrThrow: async () => structuredClone(state.mat),
        update: async ({ data }) => {
          state.mat = update(state.mat, data);
          return structuredClone(state.mat);
        },
      },
      entry: {
        findMany: async ({ where }) =>
          structuredClone(
            state.entries.filter((entry) =>
              where.id
                ? where.id.in.includes(entry.id)
                : where.athleteId.in.includes(entry.athleteId),
            ),
          ),
      },
      contest: {
        findFirst: async ({ where }) =>
          where.draw ? structuredClone(state.row) : state.foreignBusy ? { id: randomUUID() } : null,
        findMany: async () => [structuredClone(state.row)],
        count: async () => (state.row.status === 'ACTIVE' ? 1 : 0),
        update: async ({ data }) => {
          state.row = update(state.row, data);
          return structuredClone(state.row);
        },
      },
      matchEvent: {
        findUnique: async ({ where }) =>
          structuredClone(state.events.find((event) => event.id === where.id) ?? null),
        findFirst: async ({ where }) =>
          structuredClone(
            state.events.find((event) => where.OR[0].id.in.includes(event.id)) ?? null,
          ),
        create: async ({ data }) => {
          state.events.push(structuredClone(data));
          return data;
        },
      },
      accessCommand: {
        findFirst: async ({ where }) =>
          structuredClone(
            state.accessCommands.find((command) => where.id.in.includes(command.id)) ?? null,
          ),
      },
      rosterCommand: {
        findFirst: async ({ where }) =>
          structuredClone(
            state.rosterCommands.find((command) => where.id.in.includes(command.id)) ?? null,
          ),
      },
      auditEvent: {
        create: async ({ data }) => {
          state.audits.push(structuredClone(data));
          return data;
        },
      },
    };
  }
  const db = {
    contest: {
      findFirst: async () => structuredClone(saved.row),
      findMany: async () => [structuredClone(saved.row)],
    },
    async $transaction(callback) {
      const staged = structuredClone(saved);
      const result = await callback(tx(staged));
      saved = staged;
      return result;
    },
  };
  const auth = {
    owner: async (actor, id) => {
      if (
        id !== tournamentId ||
        (actor.role !== 'SUPER_ADMIN' && (actor.id !== owner.id || actor.role !== 'ORGANIZER'))
      ) {
        const { ForbiddenException } = await import('@nestjs/common');
        throw new ForbiddenException('FORBIDDEN');
      }
    },
  };
  const service = new ControlService(db, auth, {}, { notify: (notice) => notices.push(notice) });
  return {
    service,
    owner,
    tournamentId,
    matId,
    locks,
    notices,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => fn(saved),
    async packet(extra = {}) {
      const impact = await service.impact(tournamentId, saved.row.id, owner);
      return {
        id: randomUUID(),
        expectedRevision: impact.revision,
        impactToken: impact.impactToken,
        type: 'EDIT_TIME',
        phase: saved.row.state?.phase ?? 'REGULAR',
        elapsedMs: 17000,
        reason: 'Stopped clock correction QA',
        ...extra,
      };
    },
    send: (packet, actor = owner) => service.command(tournamentId, saved.row.id, packet, actor),
    impact: () => service.impact(tournamentId, saved.row.id, owner),
  };
}

test('EDIT_TIME DTO requires valid phase and exact bounded milliseconds; judge/offline command unions reject it', async () => {
  const h = fixture();
  const packet = await h.packet();
  assert.equal((await validate(plainToInstance(ControlCommandDto, packet))).length, 0);
  for (const changes of [
    { phase: undefined },
    { elapsedMs: undefined },
    { phase: 'NEXT' },
    { elapsedMs: -1 },
    { elapsedMs: 0.5 },
    { elapsedMs: 21600001 },
  ])
    assert.ok(
      (await validate(plainToInstance(ControlCommandDto, { ...packet, ...changes }))).length > 0,
    );
  assert.ok(
    (
      await validate(
        plainToInstance(MatchCommandDto, {
          ...packet,
          expectedVersion: 7,
          deviceId: randomUUID(),
          controlGeneration: 4,
        }),
      )
    ).length > 0,
  );
  assert.ok(
    (
      await validate(
        plainToInstance(OfflineEventDto, { id: packet.id, type: 'EDIT_TIME', expectedVersion: 7 }),
      )
    ).length > 0,
  );
});
test('impact binds stopped clock and full preview snapshot to the same returned contest revision', async () => {
  const h = fixture();
  const before = h.snapshot();
  const initialImpact = await h.impact();
  h.mutate((saved) => {
    saved.row.state.receipts = { 'local-core-command': 'fingerprint' };
  });
  const impact = await h.impact();
  assert.equal(impact.impactToken, initialImpact.impactToken);
  assert.equal(impact.revision, before.row.revision);
  assert.deepEqual(impact.stoppedClock, {
    phase: 'REGULAR',
    elapsedMs: 12000,
    durationMs: 60000,
    status: 'PAUSED',
    hasHold: false,
  });
  assert.deepEqual(impact.clockState.receipts, {});
  assert.equal(h.snapshot().row.state.receipts['local-core-command'], 'fingerprint');
  impact.clockState.awards[0].active = false;
  assert.equal(h.snapshot().row.state.awards[0].active, true);
});
test('a clock tick reaching TIME invalidates an old running preview even without a contest revision change', async () => {
  const h = fixture();
  h.mutate((saved) => {
    const state = saved.row.state;
    saved.row.state = applyCommand(state, {
      id: randomUUID(),
      expectedVersion: state.version,
      type: 'START',
    });
  });
  const packet = await h.packet();
  h.mutate((saved) => {
    const state = saved.row.state;
    saved.row.state = applyCommand(state, {
      id: randomUUID(),
      expectedVersion: state.version,
      type: 'ADVANCE',
      ms: state.rules.durationMs - state.elapsedMs,
    });
  });
  const before = h.snapshot();
  assert.equal(before.row.revision, packet.expectedRevision);
  assert.equal(before.row.state.status, 'PROVISIONAL');
  assert.deepEqual(before.row.state.outcome, { winner: 'WHITE', reason: 'TIME' });
  assert.notEqual((await h.impact()).impactToken, packet.impactToken);
  await assert.rejects(h.send(packet), rejects(409, 'IMPACT_CHANGED'));
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
  assert.equal((await h.send(await h.packet())).state.status, 'PAUSED');
});
test('clock, score and offline-lease changes invalidate review at the same row revision', async () => {
  for (const change of [
    (saved) => {
      saved.row.state.elapsedMs += 1000;
    },
    (saved) => {
      saved.row.state.awards[0].active = false;
    },
    (saved) => {
      saved.row.state.hold = { side: 'BLUE', elapsedMs: 1000, awardId: randomUUID() };
    },
    (saved) => {
      saved.row.offlineSessionId = randomUUID();
    },
    (saved) => {
      saved.row.offlineActorId = randomUUID();
    },
    (saved) => {
      saved.row.offlineControlGeneration = 4;
    },
  ]) {
    const h = fixture(),
      packet = await h.packet();
    h.mutate(change);
    const before = h.snapshot();
    assert.equal(before.row.revision, packet.expectedRevision);
    assert.notEqual((await h.impact()).impactToken, packet.impactToken);
    await assert.rejects(h.send(packet), rejects(409, 'IMPACT_CHANGED'));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});
test('administrative stopped time correction atomically persists version, immutable receipt, audit and invalidated grant', async () => {
  const h = fixture(),
    before = h.snapshot();
  const packet = await h.packet();
  const response = await h.send(packet),
    after = h.snapshot();
  assert.equal(response.ok, true);
  assert.equal(response.contestId, before.row.id);
  assert.equal(response.revision, before.row.revision + 1);
  assert.equal(response.controlGeneration, before.mat.controlGeneration + 1);
  assert.equal(after.row.state.elapsedMs, 17000);
  assert.equal(after.row.state.version, before.row.state.version + 1);
  assert.deepEqual(after.row.state.awards, before.row.state.awards);
  assert.equal(after.row.state.phase, before.row.state.phase);
  assert.equal(after.row.status, 'ACTIVE');
  assert.equal(after.row.queueOrder, before.row.queueOrder);
  assert.equal(after.row.winnerEntryId, null);
  assert.equal(after.row.confirmedAt, null);
  assert.equal(after.row.clockAnchorMs, null);
  assert.equal(after.row.clockEpoch, null);
  assert.equal(after.mat.status, 'BUSY');
  assert.equal(after.mat.accessRevision, before.mat.accessRevision + 1);
  assert.equal(after.mat.controllerSessionId, before.mat.controllerSessionId);
  assert.equal(after.mat.controllerDeviceId, before.mat.controllerDeviceId);
  assert.deepEqual(after.events[0].payload, { command: packet, response });
  assert.equal(after.audits[0].action, 'ADMIN_EDIT_TIME');
  assert.deepEqual(after.audits[0].payload.before.row, before.row);
  assert.deepEqual(after.audits[0].payload.after, after.row);
  assert.ok(
    h.locks.findIndex((sql) => sql.includes('pg_advisory_xact_lock')) <
      h.locks.findIndex((sql) => sql.includes('FROM "Athlete"')),
  );
});
test('lost-response exact retry returns the original edited state after later correction without reapplying it', async () => {
  const h = fixture();
  const first = await h.packet();
  const receipt = await h.send(first);
  await h.send(await h.packet({ elapsedMs: 22000 }));
  const beforeReplay = h.snapshot();
  assert.deepEqual(await h.send(first), receipt);
  assert.deepEqual(h.snapshot(), beforeReplay);
  assert.equal(receipt.state.elapsedMs, 17000);
  assert.equal(h.snapshot().row.state.elapsedMs, 22000);
  await assert.rejects(h.send({ ...first, elapsedMs: 1 }), rejects(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), beforeReplay);
});
test('READY/null state and running/provisional/confirmed/outcome/hold states are rejected with full rollback', async () => {
  for (const [change, reason] of [
    [
      (saved) => {
        saved.row.status = 'READY';
        saved.row.state = null;
      },
      'MATCH_NOT_READY',
    ],
    [
      (saved) => {
        saved.row.state.status = 'RUNNING';
      },
      'PAUSE_REQUIRED',
    ],
    [
      (saved) => {
        saved.row.state.status = 'PROVISIONAL';
      },
      'PAUSE_REQUIRED',
    ],
    [
      (saved) => {
        saved.row.status = 'CONFIRMED';
        saved.row.state.status = 'CONFIRMED';
      },
      'MATCH_NOT_READY',
    ],
    [
      (saved) => {
        saved.row.state.outcome = { winner: 'WHITE', reason: 'TIME' };
      },
      'RESULT_LOCKED',
    ],
    [
      (saved) => {
        saved.row.state.hold = { side: 'WHITE', elapsedMs: 3000 };
      },
      'RESOLVE_HOLD_FIRST',
    ],
  ]) {
    const h = fixture();
    h.mutate(change);
    const packet = await h.packet(),
      before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(409, reason));
    assert.deepEqual(h.snapshot(), before);
  }
});
test('invalid clock bounds and wrong phase never clamp, change phase, or persist partial state', async () => {
  for (const [extra, code, reason] of [
    [{ elapsedMs: 60001 }, 400, 'INVALID_TIME'],
    [{ elapsedMs: -1 }, 400, 'INVALID_TIME'],
    [{ elapsedMs: 0.5 }, 400, 'INVALID_TIME'],
    [{ phase: 'GOLDEN' }, 409, 'CLOCK_PHASE_MISMATCH'],
  ]) {
    const h = fixture(),
      packet = await h.packet(extra),
      before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(code, reason));
    assert.deepEqual(h.snapshot(), before);
  }
});
test('offline ownership, stale revision and changed impact protect the stopped snapshot', async () => {
  for (const [change, extra, reason] of [
    [
      (saved) => {
        saved.row.offlineSessionId = randomUUID();
        saved.row.offlineControlGeneration = 4;
      },
      {},
      'OFFLINE_OWNED',
    ],
    [
      (saved) => {
        saved.row.offlineActorId = saved.session.userId;
      },
      {},
      'OFFLINE_OWNED',
    ],
    [
      (saved) => {
        saved.row.offlineControlGeneration = 0;
      },
      {},
      'OFFLINE_OWNED',
    ],
    [() => {}, { expectedRevision: 6 }, 'VERSION_CONFLICT'],
    [() => {}, { impactToken: '0'.repeat(64) }, 'IMPACT_CHANGED'],
  ]) {
    const h = fixture();
    h.mutate(change);
    const packet = await h.packet(extra),
      before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(409, reason));
    assert.deepEqual(h.snapshot(), before);
  }
});
test('clock editing cannot bypass live administrator session, role scope or cross-tournament athlete reservation', async () => {
  const judge = fixture();
  await assert.rejects(
    judge.send(await judge.packet(), { ...judge.owner, role: 'OPERATOR' }),
    rejects(403, 'FORBIDDEN'),
  );
  for (const [change, status, reason] of [
    [
      (saved) => {
        saved.session = null;
      },
      401,
      'AUTH_REQUIRED',
    ],
    [
      (saved) => {
        saved.session.expiresAt = new Date(0);
      },
      401,
      'AUTH_REQUIRED',
    ],
    [
      (saved) => {
        saved.foreignBusy = true;
      },
      409,
      'TATAMI_OR_ATHLETE_BUSY',
    ],
    [
      (saved) => {
        saved.entries[1].athleteId = saved.entries[0].athleteId;
      },
      409,
      'MATCH_NOT_READY',
    ],
  ]) {
    const h = fixture();
    h.mutate(change);
    const packet = await h.packet(),
      before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(status, reason));
    assert.deepEqual(h.snapshot(), before);
  }
});
test('clock fields are mandatory for EDIT_TIME and cannot be hidden in other administrative actions', async () => {
  const h = fixture();
  const packet = await h.packet();
  for (const extra of [{ phase: undefined }, { elapsedMs: undefined }])
    await assert.rejects(h.send({ ...packet, ...extra }), rejects(400, 'CLOCK_FIELDS_REQUIRED'));
  await assert.rejects(
    h.send({ ...packet, type: 'RESET' }),
    rejects(400, 'UNEXPECTED_CLOCK_PAYLOAD'),
  );
  await assert.rejects(h.send({ ...packet, reason: '   ' }), rejects(400, 'REASON_REQUIRED'));
  assert.equal(h.snapshot().events.length, 0);
});
test('regular exact expiry proposes TIME without writing a winner or progressing dependencies; tie decision can be corrected', async () => {
  const lead = fixture();
  const outcome = await lead.send(await lead.packet({ elapsedMs: 60000 }));
  assert.equal(outcome.state.status, 'PROVISIONAL');
  assert.deepEqual(outcome.state.outcome, { winner: 'WHITE', reason: 'TIME' });
  assert.equal(lead.snapshot().row.status, 'ACTIVE');
  assert.equal(lead.snapshot().row.winnerEntryId, null);
  assert.equal(lead.snapshot().row.confirmedAt, null);
  const tie = fixture();
  tie.mutate((saved) => {
    saved.row.state.awards = [];
  });
  assert.equal((await tie.send(await tie.packet({ elapsedMs: 60000 }))).state.status, 'DECISION');
  assert.equal((await tie.send(await tie.packet({ elapsedMs: 59000 }))).state.status, 'PAUSED');
  assert.equal(tie.snapshot().row.state.phase, 'REGULAR');
});
test('unconfirmed TIME result can restore stopped clock, retain every score and reexpire without premature progression', async () => {
  const h = fixture();
  const premature = await h.send(await h.packet({ elapsedMs: 60000 }));
  assert.equal(premature.state.status, 'PROVISIONAL');
  assert.equal(premature.state.outcome.reason, 'TIME');
  const restored = await h.send(await h.packet({ elapsedMs: 50000 }));
  assert.equal(restored.state.status, 'PAUSED');
  assert.equal(restored.state.outcome, null);
  assert.equal(restored.state.elapsedMs, 50000);
  assert.deepEqual(restored.state.awards, premature.state.awards);
  assert.equal(h.snapshot().row.status, 'ACTIVE');
  assert.equal(h.snapshot().row.winnerEntryId, null);
  assert.equal(h.snapshot().row.confirmedAt, null);
  const reexpired = await h.send(await h.packet({ elapsedMs: 60000 }));
  assert.deepEqual(reexpired.state.outcome, premature.state.outcome);
  assert.deepEqual(reexpired.state.awards, premature.state.awards);
  assert.equal(h.snapshot().mat.controlGeneration, 7);
  assert.equal(h.snapshot().events.length, 3);
  assert.equal(h.snapshot().audits.length, 3);
});
test('TIME correction exception never changes confirmed data or non-TIME preliminary outcomes', async () => {
  for (const reason of ['TIME', 'IPPON', 'COMBINATION', 'ACCUMULATED_SHIDO', 'GOLDEN_SCORE']) {
    const h = fixture();
    h.mutate((saved) => {
      saved.row.state.status = reason === 'TIME' ? 'CONFIRMED' : 'PROVISIONAL';
      saved.row.state.outcome = { winner: 'WHITE', reason };
      if (reason === 'TIME') saved.row.status = 'CONFIRMED';
    });
    const packet = await h.packet({ elapsedMs: 0 }),
      before = h.snapshot();
    await assert.rejects(
      h.send(packet),
      rejects(409, reason === 'TIME' ? 'MATCH_NOT_READY' : 'PAUSE_REQUIRED'),
    );
    assert.deepEqual(h.snapshot(), before);
  }
});
test('Golden Score correction changes only golden elapsed time and enforces the technical bound', async () => {
  const h = fixture();
  h.mutate((saved) => {
    saved.row.state.phase = 'GOLDEN';
    saved.row.state.elapsedMs = 60000;
    saved.row.state.goldenMs = 3000;
  });
  const before = h.snapshot();
  const edited = await h.send(await h.packet({ phase: 'GOLDEN', elapsedMs: 21600000 }));
  assert.equal(edited.state.goldenMs, 21600000);
  assert.equal(edited.state.elapsedMs, before.row.state.elapsedMs);
  assert.equal(edited.state.phase, 'GOLDEN');
  assert.deepEqual(edited.state.awards, before.row.state.awards);
  const after = h.snapshot();
  await assert.rejects(
    h.send(await h.packet({ phase: 'GOLDEN', elapsedMs: 21600001 })),
    rejects(400, 'INVALID_TIME'),
  );
  assert.deepEqual(h.snapshot(), after);
});
test('EDIT_TIME participates in the access/roster command namespace and preserves historical flat admin receipts', async () => {
  for (const table of ['accessCommands', 'rosterCommands']) {
    const h = fixture(),
      packet = await h.packet();
    h.mutate((saved) => saved[table].push({ id: packet.id }));
    const before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(409, 'COMMAND_ID_REUSED'));
    assert.deepEqual(h.snapshot(), before);
  }
  const h = fixture(),
    packet = await h.packet();
  const legacy = { ...packet, type: 'RESET' };
  delete legacy.phase;
  delete legacy.elapsedMs;
  h.mutate((saved) =>
    saved.events.push({
      id: legacy.id,
      contestId: saved.row.id,
      actorId: h.owner.id,
      type: 'ADMIN_RESET',
      payload: legacy,
    }),
  );
  const before = h.snapshot();
  assert.deepEqual(await h.send(legacy), { ok: true });
  assert.deepEqual(h.snapshot(), before);
});
