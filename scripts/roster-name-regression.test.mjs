import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const apiModule = (path) => import(new URL(`${apiDist}/modules/${path}.js`, import.meta.url));
const { RosterService } = await apiModule('roster/roster.service');
const { EntryNameDto } = await apiModule('roster/roster.dto');
const rejects = (status, reason) => (error) =>
  error.getStatus() === status && error.message === reason;
const json = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const owner = {
    id: randomUUID(),
    name: 'Name QA',
    role: 'ORGANIZER',
    sessionId: randomUUID(),
    tatamiId: null,
  };
  const tournamentId = randomUUID(),
    historicalId = randomUUID(),
    categoryId = randomUUID(),
    historicalCategoryId = randomUUID(),
    entryId = randomUUID(),
    athleteId = randomUUID();
  const entry = {
    id: entryId,
    athleteId,
    categoryId,
    firstName: 'Әли',
    lastName: 'Original',
    birthYear: 2012,
    gender: null,
    club: 'Name QA Club',
    clubId: randomUUID(),
    archivedAt: null,
    createdAt: new Date('2026-10-10T01:00:00Z'),
  };
  let saved = {
    tournaments: [
      { id: tournamentId, ownerId: owner.id, status: 'RUNNING', rosterRevision: 7 },
      { id: historicalId, ownerId: owner.id, status: 'FINISHED', rosterRevision: 19 },
    ],
    categories: [
      { id: categoryId, tournamentId },
      { id: historicalCategoryId, tournamentId: historicalId },
    ],
    entries: [
      entry,
      {
        ...entry,
        id: randomUUID(),
        categoryId: historicalCategoryId,
        firstName: 'Historical name',
        lastName: 'Historical surname',
      },
      { ...entry, id: randomUUID(), athleteId: randomUUID(), lastName: 'Corrected' },
    ],
    draws: [
      {
        id: randomUUID(),
        categoryId,
        status: 'CONFIRMED',
        version: 3,
        fingerprint: 'original-name-dependent-fingerprint',
        snapshot: { positions: [{ id: entryId, clubId: entry.clubId }], matches: [] },
      },
    ],
    contests: [
      {
        id: randomUUID(),
        whiteEntryId: entryId,
        status: 'ACTIVE',
        revision: 12,
        tatamiId: randomUUID(),
        queueOrder: 5,
        state: {
          status: 'PAUSED',
          phase: 'GOLDEN',
          goldenMs: 3000,
          hold: { side: 'WHITE', elapsedMs: 5000 },
          awards: [{ id: randomUUID(), side: 'WHITE', kind: 'YUKO', active: true }],
        },
        offlineSessionId: randomUUID(),
        offlineActorId: owner.id,
        offlineControlGeneration: 4,
      },
    ],
    mats: [{ id: randomUUID(), tournamentId, controlGeneration: 4, accessRevision: 8 }],
    athletes: [{ id: athleteId, ownerId: owner.id }],
    session: {
      id: owner.sessionId,
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3600000),
      invitationId: null,
      user: { id: owner.id, role: owner.role },
    },
    receipts: [],
    audits: [],
    accessCommands: [],
    matchEvents: [],
  };
  const locks = [],
    notices = [];
  let failure = null,
    afterEntryLock = null,
    afterSessionLock = null,
    queue = Promise.resolve();
  const tournament = (state, id) => state.tournaments.find((row) => row.id === id);
  const scopedEntry = (state, where) =>
    state.entries.find(
      (row) =>
        row.id === where.id &&
        state.categories.find((category) => category.id === row.categoryId)?.tournamentId ===
          where.category.tournamentId,
    );
  const db = {
    async $transaction(callback) {
      const work = queue.then(async () => {
        const staged = structuredClone(saved);
        const tx = {
          $queryRaw: async (strings, ...values) => {
            const sql = strings.join('');
            locks.push(sql);
            if (sql.includes('FROM "Session"') && afterSessionLock) afterSessionLock(staged);
            if (sql.includes('FROM "Entry"') && afterEntryLock) afterEntryLock(staged);
            return [];
          },
          tournament: {
            findUnique: async ({ where }) => structuredClone(tournament(staged, where.id)),
            findUniqueOrThrow: async ({ where }) => structuredClone(tournament(staged, where.id)),
            update: async ({ where, data }) => {
              assert.deepEqual(Object.keys(data), ['rosterRevision']);
              const row = tournament(staged, where.id);
              row.rosterRevision += data.rosterRevision.increment;
              return structuredClone(row);
            },
          },
          session: {
            findUnique: async ({ where }) =>
              where.id === owner.sessionId ? structuredClone(staged.session) : null,
          },
          invitation: { findUnique: async () => null },
          drawRecord: {
            findUnique: async ({ where }) =>
              structuredClone(staged.draws.find((row) => row.categoryId === where.categoryId)),
          },
          entry: {
            findFirst: async ({ where }) => structuredClone(scopedEntry(staged, where) ?? null),
            update: async ({ where, data }) => {
              assert.deepEqual(Object.keys(data).sort(), ['firstName', 'lastName']);
              if (failure === 'entry') throw new Error('entry unavailable');
              const row = staged.entries.find((entry) => entry.id === where.id);
              Object.assign(row, data);
              return structuredClone(row);
            },
          },
          rosterCommand: {
            findUnique: async ({ where }) =>
              structuredClone(staged.receipts.find((receipt) => receipt.id === where.id) ?? null),
            findFirst: async ({ where }) =>
              structuredClone(staged.receipts.find((receipt) => where.id.in.includes(receipt.id))),
            create: async ({ data }) => {
              if (failure === 'collision')
                throw new Prisma.PrismaClientKnownRequestError('collision', {
                  code: 'P2002',
                  clientVersion: 'test',
                });
              staged.receipts.push(structuredClone(data));
            },
          },
          matchEvent: {
            findFirst: async ({ where }) => {
              const ids = where.OR[0].id.in;
              return structuredClone(
                staged.matchEvents.find(
                  (event) =>
                    ids.includes(event.id) ||
                    event.payload.events?.some((nested) => ids.includes(nested.id)),
                ),
              );
            },
          },
          accessCommand: {
            findFirst: async ({ where }) =>
              structuredClone(
                staged.accessCommands.find((command) => where.id.in.includes(command.id)),
              ),
          },
          auditEvent: {
            create: async ({ data }) => {
              if (failure === 'audit') throw new Error('audit unavailable');
              staged.audits.push(structuredClone(data));
            },
          },
        };
        const value = await callback(tx);
        saved = staged;
        return value;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
  const auth = {
    owner: async (actor, id) => {
      const t = tournament(saved, id);
      if (
        !t ||
        (actor.role !== 'SUPER_ADMIN' && (actor.role !== 'ORGANIZER' || t.ownerId !== actor.id))
      )
        throw new ForbiddenException('FORBIDDEN');
    },
  };
  const service = new RosterService(db, auth, { notify: (notice) => notices.push(notice) });
  return {
    owner,
    tournamentId,
    historicalId,
    entryId,
    locks,
    notices,
    snapshot: () => structuredClone(saved),
    mutate: (callback) => callback(saved),
    fail: (value) => (failure = value),
    afterEntryLock: (callback) => (afterEntryLock = callback),
    afterSessionLock: (callback) => (afterSessionLock = callback),
    packet: (extra = {}) => ({
      id: randomUUID(),
      expectedRevision: tournament(saved, tournamentId).rosterRevision,
      firstName: 'Әли',
      lastName: 'Corrected',
      reason: 'Исправлена опечатка в имени',
      ...extra,
    }),
    send: (packet, actor = owner, targetEntryId = entryId, targetTournamentId = tournamentId) =>
      service.correctName(targetTournamentId, targetEntryId, packet, actor),
  };
}

test('name DTO accepts only names and durable command fields, with UUID/revision/reason limits', async () => {
  const packet = fixture().packet();
  assert.equal((await validate(plainToInstance(EntryNameDto, packet))).length, 0);
  for (const change of [
    { id: 'bad-id' },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { firstName: undefined },
    { lastName: '' },
    { firstName: 'a'.repeat(81) },
    { reason: '   ' },
    { reason: 'a'.repeat(501) },
    { categoryId: randomUUID() },
    { athleteId: randomUUID() },
    { clubId: randomUUID() },
    { middleName: 'Unsupported field' },
  ])
    assert.ok(
      (
        await validate(plainToInstance(EntryNameDto, { ...packet, ...change }), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length > 0,
    );
});

test('RUNNING name correction updates one Entry and roster revision while preserving every sporting and historical field', async () => {
  const h = fixture(),
    before = h.snapshot(),
    packet = h.packet();
  const response = await h.send(packet),
    after = h.snapshot();
  assert.equal(response.revision, 8);
  assert.deepEqual(response.invalidatedCategoryIds, []);
  assert.equal(response.entry.id, h.entryId);
  assert.equal(response.entry.gender, null);
  assert.equal(response.entry.lastName, 'Corrected');
  assert.deepEqual(after.entries[0], { ...before.entries[0], lastName: 'Corrected' });
  assert.deepEqual(after.entries.slice(1), before.entries.slice(1));
  for (const field of ['draws', 'contests', 'mats', 'athletes', 'session'])
    assert.deepEqual(after[field], before[field]);
  assert.deepEqual(after.tournaments[0], { ...before.tournaments[0], rosterRevision: 8 });
  assert.deepEqual(after.tournaments[1], before.tournaments[1]);
  assert.equal(after.receipts.length, 1);
  assert.equal(after.receipts[0].actorId, h.owner.id);
  assert.deepEqual(after.receipts[0].command, { ...packet, entryId: h.entryId });
  assert.deepEqual(after.receipts[0].response, response);
  assert.equal(after.audits[0].action, 'ENTRY_NAME_CORRECTED');
  assert.deepEqual(after.audits[0].payload.before, json(before.entries[0]));
  assert.deepEqual(after.audits[0].payload.after, json(after.entries[0]));
  assert.deepEqual(h.notices, [{ kind: 'roster', tournamentId: h.tournamentId }]);
  const index = (table) => h.locks.findIndex((sql) => sql.includes(`FROM "${table}"`));
  assert.ok(index('Tournament') < index('Tatami'));
  assert.ok(index('Tatami') < index('Session'));
  assert.ok(index('Session') < index('Category'));
  assert.ok(index('Category') < index('Entry'));
});

test('FINISHED name correction preserves confirmed results and medal inputs, including old aliases of the same athlete', async () => {
  const h = fixture();
  h.mutate((saved) => {
    saved.tournaments[0].status = 'FINISHED';
    saved.contests[0].status = 'CONFIRMED';
    saved.contests[0].winnerEntryId = h.entryId;
    saved.contests[0].resultReason = 'ACCUMULATED_SHIDO';
  });
  const before = h.snapshot();
  await h.send(h.packet());
  assert.deepEqual(h.snapshot().contests, before.contests);
  assert.deepEqual(h.snapshot().draws, before.draws);
  assert.deepEqual(h.snapshot().entries[1], before.entries[1]);
});

test('DRAFT allows only confirmed draws and never rewrites a preview fingerprint or snapshot', async () => {
  for (const status of ['CONFIRMED', 'PREVIEW', 'STALE', null]) {
    const h = fixture();
    h.mutate((saved) => {
      saved.tournaments[0].status = 'DRAFT';
      if (status) saved.draws[0].status = status;
      else saved.draws = [];
    });
    const before = h.snapshot();
    if (status === 'CONFIRMED') {
      await h.send(h.packet());
      assert.deepEqual(h.snapshot().draws, before.draws);
    } else {
      await assert.rejects(h.send(h.packet()), rejects(409, 'NAME_CORRECTION_NOT_ALLOWED'));
      assert.deepEqual(h.snapshot(), before);
    }
  }
});

test('normalization and an identical name of another participant never merge identities', async () => {
  const h = fixture(),
    before = h.snapshot();
  const response = await h.send(h.packet({ firstName: '  Ａli\t Khan ', lastName: 'Corrected' }));
  assert.equal(response.entry.firstName, 'Ali Khan');
  assert.equal(response.entry.athleteId, before.entries[0].athleteId);
  assert.equal(h.snapshot().entries.length, 3);
  assert.deepEqual(h.snapshot().athletes, before.athletes);
  const collision = fixture();
  const result = await collision.send(collision.packet());
  assert.equal(result.entry.firstName, collision.snapshot().entries[2].firstName);
  assert.equal(result.entry.lastName, collision.snapshot().entries[2].lastName);
  assert.notEqual(result.entry.id, collision.snapshot().entries[2].id);
});

test('lost-response name replay returns its immutable response after a later correction without replacing the current name', async () => {
  const h = fixture(),
    packet = h.packet();
  const original = await h.send(packet);
  await h.send(h.packet({ lastName: 'Latest name' }));
  const before = h.snapshot(),
    noticeCount = h.notices.length;
  assert.deepEqual(await h.send(packet), original);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, noticeCount);
  assert.equal(h.snapshot().entries[0].lastName, 'Latest name');
  await assert.rejects(
    h.send({ ...packet, firstName: 'Different' }),
    rejects(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.send(packet, h.owner, before.entries[2].id),
    rejects(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.send(packet, h.owner, before.entries[1].id, h.historicalId),
    rejects(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('name receipt is bound to the live author, with authorization repeated after the tournament and Session locks', async () => {
  const h = fixture(),
    packet = h.packet();
  await h.send(packet);
  for (const change of [
    (saved) => {
      saved.session = null;
    },
    (saved) => {
      saved.session.expiresAt = new Date(0);
    },
    (saved) => {
      saved.session.user.role = 'OPERATOR';
    },
    (saved) => {
      saved.tournaments[0].ownerId = randomUUID();
    },
  ]) {
    const fresh = fixture(),
      command = fresh.packet();
    await fresh.send(command);
    fresh.mutate(change);
    const before = fresh.snapshot();
    await assert.rejects(fresh.send(command), (error) => [401, 403].includes(error.getStatus()));
    assert.deepEqual(fresh.snapshot(), before);
  }
  h.mutate((saved) => {
    saved.receipts[0].actorId = randomUUID();
  });
  const before = h.snapshot();
  await assert.rejects(h.send(packet), rejects(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(
    h.send(h.packet(), { ...h.owner, role: 'OPERATOR' }),
    rejects(403, 'FORBIDDEN'),
  );
});

test('archived, missing and foreign Entries cannot be changed through the name endpoint', async () => {
  const h = fixture();
  h.mutate((saved) => {
    saved.entries[0].archivedAt = new Date();
  });
  const before = h.snapshot();
  await assert.rejects(h.send(h.packet()), rejects(409, 'ENTRY_ARCHIVED'));
  await assert.rejects(h.send(h.packet(), h.owner, randomUUID()), rejects(404, 'ENTRY_NOT_FOUND'));
  await assert.rejects(
    h.send(h.packet(), h.owner, before.entries[1].id),
    rejects(404, 'ENTRY_NOT_FOUND'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('Session deletion, expiry and changed ownership after the initial permission check are rejected under locks', async () => {
  for (const [change, code, reason] of [
    [
      (staged) => {
        staged.session = null;
      },
      401,
      'AUTH_REQUIRED',
    ],
    [
      (staged) => {
        staged.session.expiresAt = new Date(0);
      },
      401,
      'AUTH_REQUIRED',
    ],
    [
      (staged) => {
        staged.tournaments[0].ownerId = randomUUID();
      },
      403,
      'FORBIDDEN',
    ],
  ]) {
    const h = fixture(),
      before = h.snapshot();
    h.afterSessionLock(change);
    await assert.rejects(h.send(h.packet()), rejects(code, reason));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('Entry state is re-read after its lock instead of trusting the earlier lookup', async () => {
  const h = fixture();
  h.afterEntryLock((staged) => {
    staged.entries[0].archivedAt = new Date();
  });
  const before = h.snapshot();
  await assert.rejects(h.send(h.packet()), rejects(409, 'ENTRY_ARCHIVED'));
  assert.deepEqual(h.snapshot(), before);
});

test('malformed names, empty reason, unchanged display and forbidden fields reject without partial writes', async () => {
  for (const [extra, code, reason] of [
    [{ firstName: '   ' }, 400, 'NAME_REQUIRED'],
    [{ lastName: undefined }, 400, 'NAME_REQUIRED'],
    [{ firstName: '㍿'.repeat(30) }, 400, 'NAME_TOO_LONG'],
    [{ reason: '   ' }, 400, 'REASON_REQUIRED'],
    [{ reason: 'a'.repeat(501) }, 400, 'REASON_REQUIRED'],
    [{ firstName: 'Әли', lastName: 'Original' }, 409, 'NAME_UNCHANGED'],
    [{ categoryId: randomUUID() }, 400, 'UNEXPECTED_NAME_PAYLOAD'],
    [{ clubId: randomUUID() }, 400, 'UNEXPECTED_NAME_PAYLOAD'],
    [{ athleteId: randomUUID() }, 400, 'UNEXPECTED_NAME_PAYLOAD'],
    [{ gender: 'FEMALE' }, 400, 'UNEXPECTED_NAME_PAYLOAD'],
  ]) {
    const h = fixture(),
      before = h.snapshot();
    await assert.rejects(h.send(h.packet(extra)), rejects(code, reason));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('name command shares the access, roster and historical nested match-event UUID namespace', async () => {
  for (const source of ['accessCommands', 'receipts', 'matchEvents', 'nested']) {
    const h = fixture(),
      packet = h.packet();
    h.mutate((saved) => {
      if (source === 'nested')
        saved.matchEvents.push({
          id: randomUUID(),
          type: 'OFFLINE_SYNC',
          payload: { events: [{ id: packet.id }] },
        });
      else if (source === 'matchEvents') saved.matchEvents.push({ id: packet.id, payload: {} });
      else saved[source].push({ id: packet.id });
    });
    const before = h.snapshot();
    await assert.rejects(h.send(packet), rejects(409, 'COMMAND_ID_REUSED'));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('entry, receipt collision and audit failures roll back the name and roster revision together', async () => {
  for (const failure of ['entry', 'collision', 'audit']) {
    const h = fixture(),
      before = h.snapshot();
    h.fail(failure);
    await assert.rejects(
      h.send(h.packet()),
      failure === 'collision' ? rejects(409, 'COMMAND_ID_REUSED') : /unavailable/,
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('concurrent same revision has one mutation; concurrent identical retries reuse one receipt', async () => {
  const h = fixture(),
    packet = h.packet();
  const results = await Promise.allSettled([
    h.send(packet),
    h.send({ ...packet, id: randomUUID(), lastName: 'Second administrator' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.message,
    'VERSION_CONFLICT',
  );
  assert.equal(h.snapshot().receipts.length, 1);
  const identical = fixture(),
    command = identical.packet();
  const replies = await Promise.all([identical.send(command), identical.send(command)]);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(identical.snapshot().receipts.length, 1);
  assert.equal(identical.snapshot().audits.length, 1);
  assert.equal(identical.notices.length, 1);
});
