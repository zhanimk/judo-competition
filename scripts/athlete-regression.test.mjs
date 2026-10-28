import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { applyCommand, createMatch } from '@judo/engine/match';
import { generateDraw, resolveMatches } from '@judo/engine/draw';
import { MatchesService } from '../apps/api/dist/modules/matches/matches.service.js';
import { ControlService } from '../apps/api/dist/modules/control/control.service.js';
import {
  lockContestAthletes,
  requireAvailableAthletes,
} from '../apps/api/dist/modules/matches/athlete-guards.js';
import { currentProfile } from '../apps/api/dist/modules/rules/profile.js';

const conflict = (message) => (error) => error.getStatus() === 409 && error.message === message;

function state(phase) {
  if (phase === 'READY') return null;
  const rules = currentProfile();
  let value = createMatch({ ...rules, durationMs: 180000 });
  for (const command of [
    { type: 'START' },
    ...(phase === 'CONFIRMED'
      ? [{ type: 'AWARD', side: 'WHITE', kind: 'IPPON' }, { type: 'CONFIRM' }]
      : [{ type: 'STOP' }]),
  ])
    value = applyCommand(value, { id: randomUUID(), expectedVersion: value.version, ...command });
  value.receipts = {};
  return value;
}

function fixture({
  phase = 'READY',
  foreignStatus = 'READY',
  shared = true,
  sharedSide = 'WHITE',
  recentAgo = 1000,
  restMs = 600000,
  archivedAlias = false,
  judge = false,
} = {}) {
  const owner = {
    id: randomUUID(),
    name: 'Administrator',
    role: judge ? 'OPERATOR' : 'ORGANIZER',
    sessionId: randomUUID(),
    tatamiId: null,
  };
  const deviceId = randomUUID();
  const controlGeneration = 1;
  const tournament = randomUUID();
  const otherTournament = randomUUID();
  const mat = randomUUID();
  const otherMat = randomUUID();
  if (judge) owner.tatamiId = mat;
  const categoryId = randomUUID();
  const otherCategoryId = randomUUID();
  const athleteIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const entries = Array.from({ length: 4 }, (_, index) => ({
    id: randomUUID(),
    categoryId: index < 2 ? categoryId : otherCategoryId,
    athleteId:
      index === (sharedSide === 'WHITE' ? 2 : 3) && shared ? athleteIds[0] : athleteIds[index],
    firstName: 'One shared spelling',
    lastName: 'Homonym',
    archivedAt: index >= 2 && archivedAlias ? new Date('2026-01-01') : null,
  }));
  const draw = generateDraw(
    'REPECHAGE',
    entries.slice(0, 2).map((entry) => ({ id: entry.id, clubId: 'fixture-club' })),
    123,
    'REPECHAGE_ONLY',
  );
  const row = {
    id: randomUUID(),
    drawId: randomUUID(),
    key: draw.matches[0].id,
    round: 1,
    tatamiId: mat,
    queueOrder: 1,
    revision: 0,
    status: phase === 'READY' ? 'READY' : phase === 'CONFIRMED' ? 'CONFIRMED' : 'ACTIVE',
    state: state(phase),
    whiteEntryId: entries[0].id,
    blueEntryId: entries[1].id,
    offlineSessionId: null,
    offlineActorId: null,
    offlineControlGeneration: null,
    clockAnchorMs: null,
    clockEpoch: null,
    winnerEntryId: phase === 'CONFIRMED' ? entries[0].id : null,
    resultReason: phase === 'CONFIRMED' ? 'IPPON' : null,
    confirmedAt: phase === 'CONFIRMED' ? new Date() : null,
    endedAt: null,
    updatedAt: new Date('2026-10-09T01:00:00Z'),
    draw: {
      status: 'CONFIRMED',
      categoryId,
      snapshot: draw,
      category: { tournamentId: tournament, homeTatamiId: mat, durationSeconds: 180 },
    },
  };
  const pair = resolveMatches(draw, {})[0];
  row.whiteEntryId = pair.whiteEntryId;
  row.blueEntryId = pair.blueEntryId;
  row.draw.id = row.drawId;
  row.draw.version = 1;
  let saved = {
    entries,
    athletes: athleteIds.map((id) => ({ id })),
    rows: [
      row,
      {
        ...structuredClone(row),
        id: randomUUID(),
        drawId: randomUUID(),
        tatamiId: otherMat,
        whiteEntryId: entries[2].id,
        blueEntryId: entries[3].id,
        status: foreignStatus,
        state: state(foreignStatus === 'CONFIRMED' ? 'CONFIRMED' : 'ACTIVE'),
        confirmedAt: foreignStatus === 'CONFIRMED' ? new Date(Date.now() - recentAgo) : null,
        draw: {
          ...structuredClone(row.draw),
          categoryId: otherCategoryId,
          category: { tournamentId: otherTournament, homeTatamiId: otherMat, durationSeconds: 180 },
        },
      },
    ],
    tournament: {
      id: tournament,
      ownerId: owner.id,
      status: 'RUNNING',
      rulesSnapshot: { ...currentProfile(), restMs },
    },
    events: [],
    audits: [],
    mats: { [mat]: phase === 'READY' || phase === 'CONFIRMED' ? 'IDLE' : 'BUSY' },
    grants: {
      [mat]: {
        id: mat,
        tournamentId: tournament,
        controllerSessionId: owner.sessionId,
        controllerActorId: owner.id,
        controllerDeviceId: deviceId,
        controlGeneration,
        accessRevision: 0,
      },
    },
    session: {
      id: owner.sessionId,
      userId: owner.id,
      user: { id: owner.id, role: owner.role, name: owner.name },
      expiresAt: new Date('2099-01-01'),
      invitationId: judge ? randomUUID() : null,
      tatamiId: judge ? mat : null,
    },
  };
  const locks = [];
  const notices = [];
  const matchesWhere = (value, where = {}) => {
    if (where.OR && !where.OR.some((condition) => matchesWhere(value, condition))) return false;
    if (where.AND && !where.AND.every((condition) => matchesWhere(value, condition))) return false;
    for (const [key, wanted] of Object.entries(where)) {
      if (key === 'OR' || key === 'AND') continue;
      if (key === 'draw') {
        if (!matchesWhere(value.draw, wanted)) return false;
      } else if (key === 'category') {
        if (!matchesWhere(value.category, wanted)) return false;
      } else if (wanted && typeof wanted === 'object' && 'in' in wanted) {
        if (!wanted.in.includes(value[key])) return false;
      } else if (wanted && typeof wanted === 'object' && 'notIn' in wanted) {
        if (value[key] === null || value[key] === undefined || wanted.notIn.includes(value[key]))
          return false;
      } else if (wanted && typeof wanted === 'object' && 'not' in wanted) {
        if (value[key] === wanted.not) return false;
      } else if (wanted && typeof wanted === 'object' && 'gt' in wanted) {
        if (!value[key] || !(value[key] > wanted.gt)) return false;
      } else if (value[key] !== wanted) return false;
    }
    return true;
  };
  const findRows = (data, where) => data.rows.filter((value) => matchesWhere(value, where));
  const transaction = (data) => ({
    async $queryRaw(strings, ...values) {
      const query = strings.join('');
      locks.push({ query, values });
      return query.includes('FROM "Athlete"')
        ? data.athletes.filter((athlete) => athlete.id === values[0])
        : [];
    },
    entry: {
      findMany: async ({ where }) =>
        structuredClone(data.entries.filter((entry) => matchesWhere(entry, where))),
    },
    tournamentCommand: { findFirst: async () => null },
    rosterCommand: { findFirst: async () => null },
    accessCommand: { findFirst: async () => null },
    session: { findUnique: async () => structuredClone(data.session) },
    invitation: {
      findUnique: async () => ({
        tatamiId: mat,
        revokedAt: null,
        expiresAt: new Date('2099-01-01'),
      }),
    },
    tournament: {
      findUnique: async () => structuredClone(data.tournament),
      findUniqueOrThrow: async () => structuredClone(data.tournament),
      update: async ({ data: changes }) => {
        Object.assign(data.tournament, changes);
        return structuredClone(data.tournament);
      },
    },
    drawRecord: {
      findMany: async ({ where }) =>
        structuredClone(
          [...new Set(data.rows.map((value) => value.drawId))]
            .filter((id) => where.id.in.includes(id))
            .map((id) => {
              const record = data.rows.find((value) => value.drawId === id).draw;
              return {
                id,
                status: record.status,
                snapshot: record.snapshot,
                contests: data.rows.filter((value) => value.drawId === id),
              };
            })
            .filter((record) => record.status === where.status),
        ),
    },
    contest: {
      findUnique: async ({ where }) => structuredClone(findRows(data, where)[0] ?? null),
      findFirst: async ({ where }) => structuredClone(findRows(data, where)[0] ?? null),
      findMany: async ({ where }) =>
        structuredClone(
          findRows(data, where).map((value) => ({
            ...value,
            draw: {
              ...value.draw,
              contests: data.rows.filter((other) => other.drawId === value.drawId),
            },
          })),
        ),
      aggregate: async ({ where }) => ({
        _min: { round: Math.min(...findRows(data, where).map((value) => value.round)) },
        _max: {
          queueOrder: Math.max(0, ...findRows(data, where).map((value) => value.queueOrder ?? 0)),
        },
      }),
      count: async ({ where }) => findRows(data, where).length,
      update: async ({ where, data: changes }) => {
        const value = findRows(data, where)[0];
        Object.assign(value, {
          ...changes,
          revision: value.revision + (changes.revision?.increment ?? 0),
          ...(changes.state === Prisma.DbNull ? { state: null } : {}),
          updatedAt: new Date(value.updatedAt.getTime() + 1),
        });
        return structuredClone(value);
      },
    },
    category: {
      findMany: async ({ where }) =>
        where.tournamentId && where.tournamentId !== tournament
          ? []
          : [
              {
                ...row.draw.category,
                id: categoryId,
                entries: structuredClone(data.entries.slice(0, 2)),
                draw: {
                  ...data.rows[0].draw,
                  contests: structuredClone(
                    data.rows.filter((value) => value.drawId === row.drawId),
                  ),
                },
              },
            ],
    },
    tatami: {
      findFirst: async ({ where }) =>
        where.id === mat && where.tournamentId === tournament
          ? structuredClone(data.grants[mat])
          : null,
      findUnique: async ({ where }) => structuredClone(data.grants[where.id] ?? null),
      update: async ({ where, data: changes }) => {
        data.mats[where.id] = changes.status;
        const grant = data.grants[where.id];
        if (grant) {
          grant.controlGeneration += changes.controlGeneration?.increment ?? 0;
          grant.accessRevision += changes.accessRevision?.increment ?? 0;
        }
      },
    },
    matchEvent: {
      findUnique: async ({ where }) => data.events.find((event) => event.id === where.id) ?? null,
      findFirst: async () => null,
      createMany: async ({ data: events }) => data.events.push(...structuredClone(events)),
      create: async ({ data: event }) => data.events.push(structuredClone(event)),
    },
    drawCommand: { findFirst: async () => null },
    protocolCommand: { findFirst: async () => null },
    liveOutbox: { create: async () => ({ id: 1n }) },
    auditEvent: { create: async ({ data: audit }) => data.audits.push(structuredClone(audit)) },
  });
  const db = {
    contest: {
      findFirst: async ({ where }) => structuredClone(findRows(saved, where)[0] ?? null),
      findMany: async ({ where }) => structuredClone(findRows(saved, where)),
    },
    async $transaction(callback) {
      const staged = structuredClone(saved);
      const result = await callback(transaction(staged));
      saved = staged;
      return result;
    },
  };
  const auth = { control: async () => ({ tournamentId: tournament }), owner: async () => {} };
  const live = { notify: (notice) => notices.push(notice) };
  const matches = new MatchesService(db, auth, live);
  const control = new ControlService(db, auth, matches, live);
  return {
    row,
    owner,
    mat,
    tournament,
    locks,
    notices,
    transaction: () => transaction(saved),
    snapshot: () => structuredClone(saved),
    mutate: (callback) => callback(saved),
    command: (extra = {}) => ({
      id: randomUUID(),
      deviceId,
      controlGeneration,
      expectedVersion: saved.rows[0].revision,
      type: 'START',
      ...extra,
    }),
    send: (command) => matches.command(mat, row.id, command, owner),
    async admin(type) {
      const impact = await control.impact(tournament, row.id, owner);
      return control.command(
        tournament,
        row.id,
        {
          id: randomUUID(),
          expectedRevision: saved.rows[0].revision,
          type,
          reason: 'Shared athlete regression',
          impactToken: impact.impactToken,
        },
        owner,
      );
    },
  };
}

test('shared athlete locks sort UUIDs independently of sides and retain archived aliases', async () => {
  const h = fixture({ archivedAlias: true });
  const identity = await lockContestAthletes(h.transaction(), h.row);
  assert.deepEqual(
    identity.athleteIds,
    h
      .snapshot()
      .entries.slice(0, 2)
      .map((entry) => entry.athleteId)
      .sort(),
  );
  assert.deepEqual(
    identity.entryIds.sort(),
    h
      .snapshot()
      .entries.slice(0, 3)
      .map((entry) => entry.id)
      .sort(),
  );
  const firstOrder = h.locks
    .filter((lock) => lock.query.includes('FROM "Athlete"'))
    .map((lock) => lock.values[0]);
  h.locks.length = 0;
  await lockContestAthletes(h.transaction(), {
    ...h.row,
    whiteEntryId: h.row.blueEntryId,
    blueEntryId: h.row.whiteEntryId,
  });
  assert.deepEqual(
    h.locks.map((lock) => lock.values[0]),
    firstOrder,
  );
});

test('missing, archived, foreign-category and same-athlete participants fail closed without writes', async () => {
  for (const change of [
    (saved) => saved.entries.shift(),
    (saved) => {
      saved.entries[0].archivedAt = new Date();
    },
    (saved) => {
      saved.entries[0].categoryId = 'another-category';
    },
    (saved) => {
      saved.entries[0].athleteId = null;
    },
    (saved) => {
      saved.entries[1].athleteId = saved.entries[0].athleteId;
    },
    (saved) => {
      saved.rows[0].blueEntryId = saved.rows[0].whiteEntryId;
    },
    (saved) => {
      saved.athletes = [];
    },
  ]) {
    const h = fixture();
    h.mutate(change);
    const before = h.snapshot();
    await assert.rejects(h.send(h.command()), conflict('MATCH_NOT_READY'));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('cross-tournament aliases block START for either side, paused/provisional/offline ACTIVE reservations', async () => {
  for (const sharedSide of ['WHITE', 'BLUE'])
    for (const status of ['PAUSED', 'PROVISIONAL', 'RUNNING']) {
      const h = fixture({ foreignStatus: 'ACTIVE', sharedSide });
      h.mutate((saved) => {
        saved.rows[1].state.status = status;
        saved.rows[1].offlineSessionId = randomUUID();
      });
      const before = h.snapshot();
      await assert.rejects(h.send(h.command()), conflict('TATAMI_OR_ATHLETE_BUSY'));
      assert.deepEqual(h.snapshot(), before);
    }
});

test('identical names with separate Athlete IDs do not merge or block another START', async () => {
  const h = fixture({ foreignStatus: 'ACTIVE', shared: false });
  const result = await h.send(h.command());
  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.state.status, 'RUNNING');
  assert.equal(h.snapshot().events.length, 1);
  assert.equal(h.snapshot().audits.length, 1);
  const queries = h.locks.map((lock) => lock.query);
  const athleteIndex = queries.findIndex((query) => query.includes('FROM "Athlete"'));
  assert.ok(queries.slice(0, athleteIndex).some((query) => query.includes('FROM "Tournament"')));
  assert.ok(queries.slice(0, athleteIndex).some((query) => query.includes('FROM "Tatami"')));
  assert.ok(queries.slice(0, athleteIndex).some((query) => query.includes('FROM "Contest"')));
  assert.ok(
    queries.slice(0, athleteIndex).some((query) => query.includes('pg_advisory_xact_lock')),
  );
  assert.ok(queries.slice(athleteIndex).every((query) => query.includes('FROM "Athlete"')));
});

test('rest follows archived aliases across tournaments and the current target profile', async () => {
  const blocked = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 200000, archivedAlias: true });
  const before = blocked.snapshot();
  await assert.rejects(blocked.send(blocked.command()), conflict('REST_REQUIRED'));
  assert.deepEqual(blocked.snapshot(), before);
  const allowed = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 200000, restMs: 100000 });
  assert.equal((await allowed.send(allowed.command())).status, 'ACTIVE');
});

test('unfought walkovers do not create rest while withdrawal from a started bout retains rest', async () => {
  for (const resultReason of ['WALKOVER', 'NO_CONTEST']) {
    const h = fixture({ foreignStatus: 'CONFIRMED' });
    h.mutate((s) => {
      s.rows[1].resultReason = resultReason;
    });
    assert.equal((await h.send(h.command())).status, 'ACTIVE');
  }
  const fought = fixture({ foreignStatus: 'CONFIRMED' });
  fought.mutate((s) => {
    s.rows[1].resultReason = 'WITHDRAWAL';
  });
  await assert.rejects(fought.send(fought.command()), conflict('REST_REQUIRED'));
});

test('historical rest boundary allows equality while a newer confirmation is blocked', async () => {
  const fixed = Date.now();
  const originalNow = Date.now;
  Date.now = () => fixed;
  try {
    const h = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 600000 });
    const identity = await lockContestAthletes(h.transaction(), h.row);
    await requireAvailableAthletes(h.transaction(), h.row, identity, { restMs: 600000 });
    h.mutate((saved) => {
      saved.rows[1].confirmedAt = new Date(fixed - 599999);
    });
    await assert.rejects(
      requireAvailableAthletes(h.transaction(), h.row, identity, { restMs: 600000 }),
      conflict('REST_REQUIRED'),
    );
  } finally {
    Date.now = originalNow;
  }
});

test('resuming an existing ACTIVE reservation excludes itself and does not restart rest', async () => {
  const h = fixture({ phase: 'ACTIVE', foreignStatus: 'CONFIRMED' });
  assert.equal((await h.send(h.command())).state.status, 'RUNNING');
});

test('offline lease open/release keeps ACTIVE reserved and both paths lock Athlete rows', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  const sessionId = randomUUID();
  await h.send(h.command({ type: 'OFFLINE_OPEN', sessionId }));
  assert.equal(h.snapshot().rows[0].offlineSessionId, sessionId);
  assert.equal(h.snapshot().rows[0].status, 'ACTIVE');
  await h.send(h.command({ type: 'OFFLINE_RELEASE', sessionId, events: [] }));
  assert.equal(h.snapshot().rows[0].offlineSessionId, null);
  assert.equal(h.snapshot().rows[0].status, 'ACTIVE');
  assert.equal(h.locks.filter((lock) => lock.query.includes('FROM "Athlete"')).length, 4);
});

test('offline START and online resume cannot bypass another shared identity reservation', async () => {
  for (const offline of [false, true]) {
    const h = fixture({ phase: 'ACTIVE', foreignStatus: 'ACTIVE' });
    const sessionId = randomUUID();
    if (offline)
      h.mutate((saved) => {
        saved.rows[0].offlineSessionId = sessionId;
        saved.rows[0].offlineActorId = h.owner.id;
        saved.rows[0].offlineControlGeneration = saved.grants[h.mat].controlGeneration;
      });
    const before = h.snapshot();
    const command = offline
      ? h.command({
          type: 'OFFLINE_SYNC',
          sessionId,
          events: [
            { id: randomUUID(), expectedVersion: before.rows[0].state.version, type: 'START' },
          ],
        })
      : h.command();
    await assert.rejects(h.send(command), conflict('TATAMI_OR_ATHLETE_BUSY'));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('REOPEN excludes its original confirmation and reserves shared athletes again', async () => {
  const h = fixture({ phase: 'CONFIRMED' });
  assert.deepEqual(await h.admin('REOPEN'), { ok: true });
  assert.equal(h.snapshot().rows[0].status, 'ACTIVE');
  assert.equal(h.snapshot().rows[0].state.status, 'PROVISIONAL');
  assert.equal(h.snapshot().rows[0].confirmedAt, null);
  assert.equal(h.locks.filter((lock) => lock.query.includes('FROM "Athlete"')).length, 2);
});

test('REOPEN cannot bypass cross-tournament busy/rest and rolls back its dependencies/audit', async () => {
  for (const [foreignStatus, reason] of [
    ['ACTIVE', 'TATAMI_OR_ATHLETE_BUSY'],
    ['CONFIRMED', 'REST_REQUIRED'],
  ]) {
    const h = fixture({ phase: 'CONFIRMED', foreignStatus });
    const before = h.snapshot();
    await assert.rejects(h.admin('REOPEN'), conflict(reason));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('RESET releases an ACTIVE reservation only while holding sorted Athlete locks', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  assert.deepEqual(await h.admin('RESET'), { ok: true });
  assert.equal(h.snapshot().rows[0].status, 'READY');
  assert.equal(h.snapshot().rows[0].state, null);
  assert.equal(h.snapshot().mats[h.mat], 'IDLE');
  const locks = h.locks.filter((lock) => lock.query.includes('FROM "Athlete"'));
  assert.deepEqual(
    locks.map((lock) => lock.values[0]),
    h
      .snapshot()
      .entries.slice(0, 2)
      .map((entry) => entry.athleteId)
      .sort(),
  );
});

test('administrative RESET repairs an incomplete pair and WAITING REMOVE keeps its existing status guard', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  h.mutate((saved) => {
    saved.rows[0].blueEntryId = null;
  });
  assert.deepEqual(await h.admin('RESET'), { ok: true });
  assert.equal(h.snapshot().rows[0].status, 'READY');
  assert.equal(h.snapshot().rows[0].state, null);
  assert.deepEqual(
    h.locks.filter((lock) => lock.query.includes('FROM "Athlete"')).map((lock) => lock.values[0]),
    [
      h.snapshot().entries.find((entry) => entry.id === h.snapshot().rows[0].whiteEntryId)
        .athleteId,
    ],
  );
  const waiting = fixture();
  waiting.mutate((saved) => {
    saved.rows[0].status = 'WAITING';
    saved.rows[0].blueEntryId = null;
  });
  const before = waiting.snapshot();
  await assert.rejects(waiting.admin('REMOVE'), conflict('RESET_FIRST'));
  assert.deepEqual(waiting.snapshot(), before);
  assert.equal(
    waiting.locks.some((lock) => lock.query.includes('FROM "Athlete"')),
    false,
  );
});

test('saved sporting response replays before new identity state and without reacquiring Athlete locks', async () => {
  const h = fixture();
  const command = h.command();
  const response = await h.send(command);
  h.mutate((saved) => {
    saved.entries[0].archivedAt = new Date();
    saved.rows[0].revision += 10;
    saved.rows[1].status = 'ACTIVE';
  });
  const before = h.snapshot();
  h.locks.length = 0;
  assert.deepEqual(await h.send(command), response);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(
    h.locks.some((lock) => lock.query.includes('FROM "Athlete"')),
    false,
  );
});

test('administrative RESET invalidates the old grant without silently transferring its holder', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  const before = h.snapshot();
  await h.admin('RESET');
  const after = h.snapshot();
  assert.equal(after.grants[h.mat].controlGeneration, before.grants[h.mat].controlGeneration + 1);
  assert.equal(after.grants[h.mat].accessRevision, before.grants[h.mat].accessRevision + 1);
  assert.equal(after.grants[h.mat].controllerSessionId, before.grants[h.mat].controllerSessionId);
  assert.equal(after.grants[h.mat].controllerDeviceId, before.grants[h.mat].controllerDeviceId);
  await assert.rejects(h.send(h.command()), conflict('CONTROL_GENERATION_STALE'));
  assert.deepEqual(h.snapshot(), after);
});

test('administrative corrections revalidate the administrator session before effects and receipts', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  h.mutate((saved) => {
    saved.session.expiresAt = new Date('2000-01-01');
  });
  const before = h.snapshot();
  await assert.rejects(h.admin('RESET'), (error) => error.getStatus() === 401);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});

test('administrative offline release clears the old reservation generation and preserves uncertain hold', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  h.mutate((saved) => {
    const row = saved.rows[0];
    row.offlineSessionId = randomUUID();
    row.offlineActorId = h.owner.id;
    row.offlineControlGeneration = saved.grants[h.mat].controlGeneration;
    let value = applyCommand(row.state, {
      id: randomUUID(),
      expectedVersion: row.state.version,
      type: 'START',
    });
    value = applyCommand(value, {
      id: randomUUID(),
      expectedVersion: value.version,
      type: 'HOLD',
      side: 'BLUE',
    });
    value.receipts = {};
    row.state = value;
  });
  const before = h.snapshot();
  await h.admin('RELEASE_OFFLINE');
  const after = h.snapshot();
  assert.equal(after.rows[0].offlineSessionId, null);
  assert.equal(after.rows[0].offlineActorId, null);
  assert.equal(after.rows[0].offlineControlGeneration, null);
  assert.equal(after.rows[0].status, 'ACTIVE');
  assert.equal(after.rows[0].state.status, 'PAUSED');
  assert.deepEqual(after.rows[0].state.hold, before.rows[0].state.hold);
  assert.equal(after.rows[0].state.version, before.rows[0].state.version + 1);
  assert.equal(after.grants[h.mat].controlGeneration, before.grants[h.mat].controlGeneration + 1);
});

test('rest uses sporting finish despite delayed confirmation and keeps legacy fallback', async () => {
  const h = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 1000 });
  h.mutate((saved) => {
    saved.rows[1].endedAt = new Date(Date.now() - 601000);
  });
  assert.equal((await h.send(h.command())).status, 'ACTIVE');
  const blocked = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 601000 });
  blocked.mutate((saved) => {
    saved.rows[1].endedAt = new Date(Date.now() - 1000);
  });
  await assert.rejects(blocked.send(blocked.command()), conflict('REST_REQUIRED'));
});

test('sporting finish survives confirmation and clearing the award clears finish', async () => {
  const h = fixture({ phase: 'ACTIVE' });
  const provisional = await h.send(h.command({ type: 'AWARD', side: 'WHITE', kind: 'IPPON' }));
  const finish = h.snapshot().rows[0].endedAt;
  assert.ok(finish instanceof Date);
  await h.send(h.command({ type: 'CONFIRM' }));
  assert.equal(h.snapshot().rows[0].endedAt.getTime(), finish.getTime());
  assert.equal(provisional.state.status, 'PROVISIONAL');
});

test('explicit rest skip starts one fresh bout, keeps sporting history and returns an idempotent audited receipt', async () => {
  const h = fixture({ foreignStatus: 'CONFIRMED', recentAgo: 1000 });
  const before = h.snapshot().rows[1];
  const command = h.command({ skipRest: true });
  const result = await h.send(command);
  assert.equal(result.state.status, 'RUNNING');
  assert.deepEqual(h.snapshot().rows[1], before);
  assert.equal(h.snapshot().audits[0].payload.restSkipped, true);
  assert.equal(h.snapshot().events[0].payload.command.skipRest, true);
  assert.deepEqual(await h.send(command), result);
  assert.equal(h.snapshot().events.length, 1);
  assert.equal(h.snapshot().audits.length, 1);
  await assert.rejects(h.send({ ...command, skipRest: false }), conflict('COMMAND_ID_REUSED'));
});

test('rest skip never bypasses busy athletes, stale versions or an existing sporting reservation', async () => {
  const busy = fixture({ foreignStatus: 'ACTIVE' });
  await assert.rejects(
    busy.send(busy.command({ skipRest: true })),
    conflict('TATAMI_OR_ATHLETE_BUSY'),
  );
  const stale = fixture({ foreignStatus: 'CONFIRMED' });
  await assert.rejects(
    stale.send(stale.command({ skipRest: true, expectedVersion: 99 })),
    conflict('VERSION_CONFLICT'),
  );
  for (const phase of ['READY', 'PAUSED']) {
    const h = fixture({ phase });
    const before = h.snapshot();
    const command = h.command({
      type: phase === 'READY' ? 'OFFLINE_OPEN' : 'START',
      skipRest: true,
    });
    await assert.rejects(
      h.send(command),
      (e) => e.getStatus() === 400 && e.message === 'INVALID_REST_OVERRIDE',
    );
    assert.deepEqual(h.snapshot(), before);
  }
});

test('assigned judge may skip rest without a reason; a different mat assignment is still denied', async () => {
  const h = fixture({ judge: true, foreignStatus: 'CONFIRMED' });
  const command = h.command({ skipRest: true });
  assert.equal((await h.send(command)).state.status, 'RUNNING');
  assert.equal(h.snapshot().audits[0].actorId, h.owner.id);
  assert.equal(h.snapshot().audits[0].payload.restSkipped, true);
  const denied = fixture({ judge: true, foreignStatus: 'CONFIRMED' });
  denied.mutate((s) => {
    s.session.tatamiId = randomUUID();
  });
  await assert.rejects(denied.send(denied.command({ skipRest: true })), (e) =>
    [401, 403].includes(e.getStatus()),
  );
});
