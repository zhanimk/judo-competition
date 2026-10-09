import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthService } from '../apps/api/dist/modules/auth/auth.service.js';
import { RosterService } from '../apps/api/dist/modules/roster/roster.service.js';
import {
  CreateClubDto,
  RosterCommitDto,
  RosterPreviewDto,
} from '../apps/api/dist/modules/roster/roster.dto.js';
import { TournamentsService } from '../apps/api/dist/modules/tournaments/tournaments.service.js';
import { entryFingerprint } from '../apps/api/dist/modules/draws/draws.service.js';
import { assertUnusedCommandIds } from '../apps/api/dist/modules/matches/command-ids.js';

const owner = { id: randomUUID(), role: 'ORGANIZER' };
const tournamentId = randomUUID();
const categoryId = randomUUID();
const femaleCategoryId = randomUUID();
const clubId = randomUUID();
const createdAt = new Date('2026-10-09T08:00:00.000Z');
const httpError = (status, message) => (error) =>
  error.getStatus() === status && (!message || error.message === message);
const rowError = (code) => (error) =>
  error.getStatus() === 400 &&
  error.getResponse().message === 'ROSTER_VALIDATION_FAILED' &&
  error.getResponse().rows.some((row) => row.errors.includes(code));
const row = (extra = {}) => ({
  firstName: 'Әлихан',
  lastName: 'Серік',
  birthYear: 2012,
  gender: 'MALE',
  categoryId,
  ...extra,
});

function harness({
  failAudit = false,
  collision = false,
  failEntryWrite = false,
  matchEvents = [],
} = {}) {
  let saved = {
    tournament: { id: tournamentId, ownerId: owner.id, status: 'DRAFT', rosterRevision: 0 },
    categories: [
      {
        id: categoryId,
        tournamentId,
        gender: 'MALE',
        birthYearFrom: 2012,
        birthYearTo: 2013,
        draw: null,
      },
      {
        id: femaleCategoryId,
        tournamentId,
        gender: 'FEMALE',
        birthYearFrom: 2012,
        birthYearTo: 2013,
        draw: null,
      },
    ],
    clubs: [
      { id: clubId, tournamentId, name: 'Жас Қыран', normalizedName: 'жас қыран', createdAt },
    ],
    entries: [],
    receipts: [],
    audits: [],
    matchEvents: structuredClone(matchEvents),
  };
  const notices = [];
  const locks = [];
  let chain = Promise.resolve();
  const viewTournament = (data, options) => {
    if (options.where.id !== tournamentId) return null;
    const clubs = data.clubs.map((club) => ({
      id: club.id,
      name: club.name,
      _count: { entries: data.entries.filter((entry) => entry.clubId === club.id).length },
    }));
    if (options.select) return { rosterRevision: data.tournament.rosterRevision, clubs };
    if (!options.include) return structuredClone(data.tournament);
    return structuredClone({
      ...data.tournament,
      clubs,
      tatamis: [],
      categories: data.categories.map((category) => ({
        ...category,
        entries: data.entries.filter((entry) => entry.categoryId === category.id),
      })),
    });
  };
  const category = (data, where) =>
    data.categories.find(
      (category) =>
        category.id === where.id &&
        (!where.tournamentId || category.tournamentId === where.tournamentId),
    );
  const createClub = (data, input) => {
    const club = { id: randomUUID(), createdAt, ...structuredClone(input) };
    data.clubs.push(club);
    return structuredClone(club);
  };
  const db = {
    tournament: {
      findFirst: async ({ where }) =>
        where.id === tournamentId && where.ownerId === owner.id ? saved.tournament : null,
      findUnique: async (options) => viewTournament(saved, options),
    },
    async $transaction(callback) {
      const operation = chain.then(async () => {
        const staged = structuredClone(saved);
        const tx = {
          $queryRaw: async (strings, ...values) => {
            locks.push({ sql: strings.join('?'), values });
            return [];
          },
          tournament: {
            findUnique: async (options) => viewTournament(staged, options),
            findUniqueOrThrow: async (options) => viewTournament(staged, options),
            update: async ({ data }) => {
              staged.tournament.rosterRevision += data.rosterRevision.increment;
              return structuredClone(staged.tournament);
            },
          },
          category: {
            findFirst: async ({ where }) => {
              const found = category(staged, where);
              return found ? structuredClone({ ...found, tournament: staged.tournament }) : null;
            },
          },
          drawRecord: {
            findFirst: async ({ where }) =>
              staged.categories.find((item) => item.id === where.categoryId)?.draw?.status ===
              where.status
                ? { status: where.status }
                : null,
          },
          club: {
            findFirst: async ({ where }) =>
              structuredClone(
                staged.clubs.find(
                  (club) => club.id === where.id && club.tournamentId === where.tournamentId,
                ) ?? null,
              ),
            findUnique: async ({ where }) => {
              const key = where.tournamentId_normalizedName;
              return structuredClone(
                staged.clubs.find(
                  (club) =>
                    club.tournamentId === key.tournamentId &&
                    club.normalizedName === key.normalizedName,
                ) ?? null,
              );
            },
            create: async ({ data }) => createClub(staged, data),
            upsert: async ({ where, create }) => {
              const key = where.tournamentId_normalizedName;
              return structuredClone(
                staged.clubs.find(
                  (club) =>
                    club.tournamentId === key.tournamentId &&
                    club.normalizedName === key.normalizedName,
                ) ?? createClub(staged, create),
              );
            },
          },
          entry: {
            count: async ({ where }) =>
              staged.entries.filter((entry) => entry.categoryId === where.categoryId).length,
            findMany: async ({ where }) =>
              structuredClone(
                staged.entries.filter((entry) => where.id.in.includes(entry.id)).reverse(),
              ),
            create: async ({ data }) => {
              const entry = { id: randomUUID(), createdAt, ...structuredClone(data) };
              staged.entries.push(entry);
              return structuredClone(entry);
            },
            createMany: async ({ data }) => {
              if (failEntryWrite) {
                staged.entries.push(structuredClone(data[0]));
                throw new Error('entry storage unavailable');
              }
              staged.entries.push(...structuredClone(data));
              return { count: data.length };
            },
          },
          rosterCommand: {
            findUnique: async ({ where }) =>
              structuredClone(staged.receipts.find((receipt) => receipt.id === where.id) ?? null),
            findFirst: async ({ where }) =>
              staged.receipts.find((receipt) => where.id.in.includes(receipt.id)) ?? null,
            create: async ({ data }) => {
              if (collision)
                throw new Prisma.PrismaClientKnownRequestError('command collision', {
                  code: 'P2002',
                  clientVersion: 'test',
                });
              staged.receipts.push(structuredClone(data));
            },
          },
          matchEvent: {
            findFirst: async ({ where }) => {
              const ids = where.OR[0].id.in;
              return (
                staged.matchEvents.find(
                  (event) =>
                    ids.includes(event.id) ||
                    (['OFFLINE_SYNC', 'OFFLINE_RELEASE'].includes(event.type) &&
                      event.payload.events?.some((nested) => ids.includes(nested.id))),
                ) ?? null
              );
            },
          },
          auditEvent: {
            create: async ({ data }) => {
              if (failAudit) throw new Error('audit unavailable');
              staged.audits.push(structuredClone(data));
            },
          },
        };
        const result = await callback(tx);
        saved = staged;
        return result;
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
  const live = { notify: (notice) => notices.push(notice) };
  const auth = new AuthService(db);
  let service = new RosterService(db, auth, live);
  const legacy = new TournamentsService(db, live, auth);
  return {
    notices,
    locks,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => fn(saved),
    dto: (entries = [row()], extra = {}) => ({
      id: randomUUID(),
      expectedRevision: saved.tournament.rosterRevision,
      clubId,
      entries,
      ...extra,
    }),
    commit: (dto, user = owner, id = tournamentId) => service.commit(id, dto, user),
    preview: (entries = [row()], user = owner, targetClubId = clubId) =>
      service.preview(tournamentId, { clubId: targetClubId, entries }, user),
    club: (dto, user = owner, id = tournamentId) => service.createClub(id, dto, user),
    clubs: (user = owner) => service.clubs(tournamentId, user),
    get: () => legacy.get(tournamentId, owner),
    legacy: (entry, catId = categoryId) => legacy.entry(tournamentId, catId, entry, owner),
    restart: () => {
      service = new RosterService(db, auth, live);
    },
  };
}

test('roster DTO validates UUIDs, safe versions, 1–500 rows and explicit gender/category without weight', async () => {
  const valid = { id: randomUUID(), expectedRevision: 0, clubId, entries: [row()] };
  assert.equal((await validate(plainToInstance(RosterCommitDto, valid))).length, 0);
  assert.equal(
    (
      await validate(
        plainToInstance(CreateClubDto, { id: randomUUID(), expectedRevision: 0, name: 'Club' }),
      )
    ).length,
    0,
  );
  for (const value of [
    { ...valid, id: undefined },
    { ...valid, clubId: 'invalid' },
    { ...valid, expectedRevision: undefined },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 0.1 },
    { ...valid, entries: [] },
    { ...valid, entries: Array.from({ length: 501 }, () => row()) },
    { ...valid, entries: [row({ gender: undefined })] },
    { ...valid, entries: [row({ categoryId: undefined })] },
    { ...valid, entries: [row({ duplicateConfirmed: 'true' })] },
  ])
    assert.ok((await validate(plainToInstance(RosterCommitDto, value))).length > 0);
  const weighted = plainToInstance(RosterPreviewDto, {
    clubId,
    entries: [row({ weightGrams: 30000 })],
  });
  assert.ok((await validate(weighted, { whitelist: true, forbidNonWhitelisted: true })).length > 0);
});

test('preview is read-only and a complete batch commits once with club snapshot and stable input order', async () => {
  const h = harness();
  const entries = [
    row({ firstName: '  Әлихан  ', lastName: 'А' }),
    row({ firstName: 'Айша', lastName: 'Б', categoryId: femaleCategoryId, gender: 'FEMALE' }),
  ];
  const before = h.snapshot();
  assert.deepEqual(await h.preview(entries), {
    revision: 0,
    rows: entries.map((_, index) => ({
      index,
      errors: [],
      possibleDuplicates: [],
      duplicateCount: 0,
    })),
    canSave: true,
  });
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
  const dto = h.dto(entries);
  const result = await h.commit(dto);
  assert.equal(result.revision, 1);
  assert.equal(result.clubId, clubId);
  assert.deepEqual(
    result.entries.map((entry) => entry.gender),
    ['MALE', 'FEMALE'],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.categoryId),
    [categoryId, femaleCategoryId],
  );
  assert.ok(result.entries.every((entry) => entry.clubId === clubId && entry.club === 'Жас Қыран'));
  assert.equal(result.entries[0].firstName, 'Әлихан');
  const after = h.snapshot();
  assert.equal(after.receipts.length, 1);
  assert.equal(after.audits.length, 1);
  assert.deepEqual(after.receipts[0].response, result);
  assert.deepEqual(after.receipts[0].command, dto);
  assert.equal(h.notices.at(-1).kind, 'result');
  assert.deepEqual((await h.clubs()).clubs[0]._count, { entries: 2 });
});

test('exact roster receipt survives service restart and later status/version changes', async () => {
  const h = harness();
  const dto = h.dto();
  const result = await h.commit(dto);
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
    state.tournament.rosterRevision = 40;
    state.categories[0].draw = { status: 'CONFIRMED' };
  });
  h.restart();
  const before = h.snapshot();
  assert.deepEqual(await h.commit(dto), result);
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(
    h.commit({ ...dto, entries: [row({ lastName: 'Other' })] }),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.commit(dto, { role: 'SUPER_ADMIN' }, randomUUID()),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
});

test('club creation normalizes name, audits once and retains exact receipt after adding entries', async () => {
  const h = harness();
  const command = { id: randomUUID(), expectedRevision: 0, name: '  Ｊｕｄｏ　 Club ' };
  const result = await h.club(command);
  assert.equal(result.club.name, 'Judo Club');
  assert.deepEqual(result.club._count, { entries: 0 });
  assert.equal(result.revision, 1);
  await h.commit(h.dto([row()], { clubId: result.club.id }));
  assert.deepEqual(await h.club(command), result);
  assert.equal(h.snapshot().receipts.length, 2);
  const before = h.snapshot();
  await assert.rejects(
    h.club({ id: randomUUID(), expectedRevision: 2, name: ' judo  CLUB ' }),
    httpError(409, 'CLUB_ALREADY_EXISTS'),
  );
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(
    h.club({ ...command, name: 'Changed' }),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(
    h.commit(h.dto([row()], { id: command.id })),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
});

test('concurrent same-ID retry stores one receipt; competing fresh commands reject stale version', async () => {
  const h = harness();
  const dto = h.dto();
  const [a, b] = await Promise.all([h.commit(dto), h.commit(dto)]);
  assert.deepEqual(a, b);
  assert.equal(h.snapshot().entries.length, 1);
  assert.equal(h.snapshot().receipts.length, 1);
  const other = harness();
  const results = await Promise.allSettled([
    other.commit(other.dto([row({ lastName: 'One' })])),
    other.commit(other.dto([row({ lastName: 'Two' })])),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    httpError(
      409,
      'VERSION_CONFLICT',
    )(results.find((result) => result.status === 'rejected').reason),
  );
});

test('owner, foreign organizer and judge permissions apply to reads, preview and both writes', async () => {
  const h = harness();
  for (const user of [
    { id: randomUUID(), role: 'ORGANIZER' },
    { id: owner.id, role: 'OPERATOR' },
  ]) {
    await assert.rejects(h.clubs(user), httpError(403, 'FORBIDDEN'));
    await assert.rejects(h.preview([row()], user), httpError(403, 'FORBIDDEN'));
    await assert.rejects(h.commit(h.dto(), user), httpError(403, 'FORBIDDEN'));
    await assert.rejects(
      h.club({ id: randomUUID(), expectedRevision: 0, name: 'Denied' }, user),
      httpError(403, 'FORBIDDEN'),
    );
  }
  await h.commit(h.dto(), { id: randomUUID(), role: 'SUPER_ADMIN' });
});

test('foreign club/category and birth-year/gender/name errors reject the entire batch', async () => {
  const h = harness();
  const before = h.snapshot();
  await assert.rejects(h.preview([row()], owner, randomUUID()), httpError(404, 'CLUB_NOT_FOUND'));
  await assert.rejects(
    h.commit(h.dto([row()], { clubId: randomUUID() })),
    httpError(404, 'CLUB_NOT_FOUND'),
  );
  for (const [invalid, error] of [
    [row({ categoryId: randomUUID() }), 'CATEGORY_NOT_FOUND'],
    [row({ birthYear: 2011 }), 'BIRTH_YEAR_OUT_OF_RANGE'],
    [row({ gender: 'FEMALE' }), 'GENDER_MISMATCH'],
    [row({ firstName: '   ' }), 'NAME_REQUIRED'],
  ]) {
    const entries = [row({ lastName: 'Valid' }), invalid];
    const preview = await h.preview(entries);
    assert.equal(preview.canSave, false);
    assert.ok(preview.rows[1].errors.includes(error));
    await assert.rejects(h.commit(h.dto(entries)), rowError(error));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('only confirmed draws lock admission; preview can become stale without rewriting it', async () => {
  const h = harness();
  h.mutate((state) => {
    state.categories[0].draw = {
      status: 'CONFIRMED',
      fingerprint: 'historic',
      snapshot: { untouched: true },
    };
  });
  const before = h.snapshot();
  assert.ok((await h.preview()).rows[0].errors.includes('DRAW_LOCKED'));
  await assert.rejects(h.commit(h.dto()), rowError('DRAW_LOCKED'));
  assert.deepEqual(h.snapshot(), before);
  h.mutate((state) => {
    state.categories[0].draw.status = 'PREVIEW';
  });
  await h.commit(h.dto());
  assert.deepEqual(h.snapshot().categories[0].draw, {
    ...before.categories[0].draw,
    status: 'PREVIEW',
  });
});

test('running tournament is read-only for new roster commands but preview reports locked rows', async () => {
  const h = harness();
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
  });
  assert.ok((await h.preview()).rows[0].errors.includes('ROSTER_LOCKED'));
  await assert.rejects(h.commit(h.dto()), httpError(409, 'ROSTER_LOCKED'));
  await assert.rejects(
    h.club({ id: randomUUID(), expectedRevision: 0, name: 'Locked' }),
    httpError(409, 'ROSTER_LOCKED'),
  );
});

test('possible duplicates across clubs/categories and in batch require each row acknowledgement', async () => {
  const h = harness();
  await h.commit(h.dto());
  h.mutate((state) => {
    state.clubs.push({
      id: 'other',
      tournamentId,
      name: 'Другой клуб',
      normalizedName: 'другой клуб',
      createdAt,
    });
  });
  const entries = [
    row({ firstName: ' ӘЛИХАН ', categoryId: femaleCategoryId, gender: 'FEMALE' }),
    row({ firstName: 'әлихан', categoryId: femaleCategoryId, gender: 'FEMALE' }),
  ];
  const preview = await h.preview(entries, owner, 'other');
  assert.equal(preview.canSave, false);
  assert.equal(preview.rows[0].possibleDuplicates.length, 2);
  assert.equal(preview.rows[0].possibleDuplicates[0].entryId, h.snapshot().entries[0].id);
  assert.equal(preview.rows[0].possibleDuplicates[1].entryId, 'batch:1');
  const partiallyConfirmed = entries.map((entry, index) => ({
    ...entry,
    duplicateConfirmed: index === 0,
  }));
  await assert.rejects(
    h.commit(h.dto(partiallyConfirmed, { clubId: 'other' })),
    rowError('DUPLICATE_CONFIRMATION_REQUIRED'),
  );
  const acknowledged = entries.map((entry) => ({ ...entry, duplicateConfirmed: true }));
  assert.equal((await h.preview(acknowledged, owner, 'other')).canSave, true);
  const response = await h.commit(h.dto(acknowledged, { clubId: 'other' }));
  assert.equal(response.entries.length, 2);
  assert.equal(
    new Set(h.snapshot().entries.map((entry) => entry.id)).size,
    3,
    'acknowledgement creates separate entries, never merges',
  );
});

test('category capacity validates aggregate batch count at 128, without partial admission', async () => {
  const h = harness();
  h.mutate((state) => {
    state.entries = Array.from({ length: 127 }, (_, index) => ({
      id: randomUUID(),
      ...row({ lastName: `Existing ${index}` }),
      club: 'Жас Қыран',
      clubId,
      createdAt,
    }));
  });
  const before = h.snapshot();
  await assert.rejects(
    h.commit(h.dto([row({ lastName: 'A' }), row({ lastName: 'B' })])),
    rowError('CATEGORY_CAPACITY'),
  );
  assert.deepEqual(h.snapshot(), before);
  await h.commit(h.dto([row({ lastName: 'Boundary' })]));
  assert.equal(h.snapshot().entries.length, 128);
  await assert.rejects(h.commit(h.dto([row({ lastName: '129' })])), rowError('CATEGORY_CAPACITY'));
});

test('500 identical rows retain full duplicate count with a bounded read-only warning response', async () => {
  const h = harness();
  const before = h.snapshot();
  const preview = await h.preview(Array.from({ length: 500 }, () => row()));
  assert.equal(preview.canSave, false);
  for (const result of preview.rows) {
    assert.equal(result.duplicateCount, 499);
    assert.equal(result.possibleDuplicates.length, 5);
    assert.ok(result.errors.includes('DUPLICATE_CONFIRMATION_REQUIRED'));
    assert.ok(
      result.possibleDuplicates.every((duplicate) => duplicate.entryId !== `batch:${result.index}`),
    );
  }
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1000000);
  assert.deepEqual(h.snapshot(), before);
});

test('entry storage, receipt collision and audit failure all roll back entries/revision/receipt', async () => {
  for (const options of [{ failAudit: true }, { collision: true }, { failEntryWrite: true }]) {
    const h = harness(options);
    const before = h.snapshot();
    await assert.rejects(
      h.commit(h.dto()),
      options.collision ? httpError(409, 'COMMAND_ID_REUSED') : undefined,
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
  for (const options of [{ failAudit: true }, { collision: true }]) {
    const h = harness(options);
    const before = h.snapshot();
    await assert.rejects(h.club({ id: randomUUID(), expectedRevision: 0, name: 'Rollback club' }));
    assert.deepEqual(h.snapshot(), before);
  }
});

test('roster commands reject current and legacy nested sporting IDs across the shared namespace', async () => {
  for (const legacy of [false, true]) {
    const id = randomUUID();
    const h = harness({
      matchEvents: [
        legacy
          ? { id: randomUUID(), type: 'OFFLINE_SYNC', payload: { events: [{ id }] } }
          : { id, type: 'START', payload: {} },
      ],
    });
    await assert.rejects(h.commit(h.dto([row()], { id })), httpError(409, 'COMMAND_ID_REUSED'));
    await assert.rejects(
      h.club({ id, expectedRevision: 0, name: 'Reused' }),
      httpError(409, 'COMMAND_ID_REUSED'),
    );
    assert.equal(h.snapshot().receipts.length, 0);
  }
});

test('shared command namespace serializes sorted UUIDs and rejects roster receipts for sporting commands', async () => {
  const ids = [randomUUID(), randomUUID()];
  const locks = [];
  const tx = {
    $queryRaw: async (_strings, id) => {
      locks.push(id);
      return [];
    },
    rosterCommand: { findFirst: async () => ({ id: ids[0] }) },
    matchEvent: { findFirst: async () => null },
  };
  await assert.rejects(assertUnusedCommandIds(tx, ids, null), httpError(409, 'COMMAND_ID_REUSED'));
  assert.deepEqual(locks, [...ids].sort());
  locks.length = 0;
  await assert.rejects(
    assertUnusedCommandIds(tx, [ids[0], ids[0]], null),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
  assert.equal(locks.length, 0);
});

test('legacy entry API joins normalized club, infers gender and audits roster revision atomically', async () => {
  const h = harness();
  const entry = await h.legacy({
    firstName: 'Old',
    lastName: 'Fixture',
    birthYear: 2012,
    club: '  ЖАС  ҚЫРАН  ',
  });
  assert.equal(entry.clubId, clubId);
  assert.equal(entry.gender, 'MALE');
  assert.equal(entry.club, 'ЖАС  ҚЫРАН');
  assert.equal(h.snapshot().clubs.length, 1);
  assert.equal(h.snapshot().tournament.rosterRevision, 1);
  assert.equal(h.snapshot().audits[0].action, 'ENTRY_ADDED');
  assert.ok(h.locks[0].sql.includes('"Tournament"'));
  assert.ok(h.locks[1].sql.includes('"Category"'));
  const fail = harness({ failAudit: true });
  const before = fail.snapshot();
  await assert.rejects(
    fail.legacy({ firstName: 'Old', lastName: 'Fixture', birthYear: 2012, club: 'New Club' }),
  );
  assert.deepEqual(fail.snapshot(), before);
});

test('legacy null gender is inferred on owner read without modifying saved historical fields', async () => {
  const h = harness();
  h.mutate((state) => {
    state.entries.push({
      id: randomUUID(),
      ...row(),
      gender: null,
      clubId: null,
      club: 'Historical club text ',
      createdAt,
    });
  });
  const before = h.snapshot();
  const tournament = await h.get();
  assert.equal(tournament.rosterRevision, 0);
  assert.equal(tournament.categories[0].entries[0].gender, 'MALE');
  assert.equal(tournament.categories[0].entries[0].club, 'Historical club text ');
  assert.deepEqual(h.snapshot(), before);
});

test('draw fingerprints preserve original Entry column order and ignore new club/gender metadata', () => {
  const original = [
    {
      id: randomUUID(),
      categoryId,
      firstName: 'Old',
      lastName: 'Row',
      birthYear: 2012,
      club: '  historical TEXT ',
      createdAt,
    },
  ];
  const oldHash = createHash('sha256').update(JSON.stringify(original)).digest('hex');
  const upgraded = original.map((entry) => ({ gender: 'MALE', clubId, ...entry }));
  assert.equal(entryFingerprint(upgraded), oldHash);
  assert.notEqual(entryFingerprint([...upgraded, { ...upgraded[0], id: randomUUID() }]), oldHash);
  assert.notEqual(
    entryFingerprint(upgraded.map((entry) => ({ ...entry, club: entry.club.trim() }))),
    oldHash,
  );
});
