import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const apiModule = (path) => import(new URL(`${apiDist}/modules/${path}.js`, import.meta.url));
const { AuthService } = await apiModule('auth/auth.service');
const { RosterService } = await apiModule('roster/roster.service');
const {
  CreateClubDto,
  RosterCommitDto,
  RosterPreviewDto,
  EntryPreviewDto,
  EntryUpdateDto,
  EntryArchiveDto,
  EntryRestoreDto,
  EntryIdentityPreviewDto,
  EntryIdentityBindDto,
  AthleteDirectoryQueryDto,
} = await apiModule('roster/roster.dto');
const { TournamentsService } = await apiModule('tournaments/tournaments.service');
const { DrawsService, entryFingerprint } = await apiModule('draws/draws.service');
const { assertUnusedCommandIds } = await apiModule('matches/command-ids');

const owner = {
  id: randomUUID(),
  role: 'ORGANIZER',
  sessionId: randomUUID(),
  name: 'QA Administrator',
};
const superAdmin = {
  id: randomUUID(),
  role: 'SUPER_ADMIN',
  sessionId: randomUUID(),
  name: 'QA Super Administrator',
};
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
  failAthleteWrite = false,
  matchEvents = [],
} = {}) {
  let principalValid = true;
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
    athletes: [],
    otherTournaments: [],
    receipts: [],
    audits: [],
    matchEvents: structuredClone(matchEvents),
    contests: [],
  };
  const notices = [];
  const locks = [];
  const athleteReads = [];
  let chain = Promise.resolve();
  const findTournament = (data, id) =>
    id === tournamentId
      ? data.tournament
      : data.otherTournaments.find((tournament) => tournament.id === id);
  const entryMatches = (data, entry, where = {}) =>
    (!where.id ||
      (typeof where.id === 'string'
        ? entry.id === where.id
        : (!where.id.in || where.id.in.includes(entry.id)) && entry.id !== where.id.not)) &&
    (!where.athleteId ||
      (typeof where.athleteId === 'string'
        ? entry.athleteId === where.athleteId
        : where.athleteId.in.includes(entry.athleteId))) &&
    (!where.categoryId || entry.categoryId === where.categoryId) &&
    (!where.category ||
      ((!where.category.tournamentId ||
        data.categories.find((category) => category.id === entry.categoryId)?.tournamentId ===
          where.category.tournamentId) &&
        (!where.category.tournament ||
          findTournament(
            data,
            data.categories.find((category) => category.id === entry.categoryId)?.tournamentId,
          )?.ownerId === where.category.tournament.ownerId))) &&
    (where.archivedAt !== null || entry.archivedAt == null) &&
    (where.archivedAt?.not !== null || entry.archivedAt != null);
  const viewTournament = (data, options) => {
    if (options.where.id !== tournamentId) return null;
    const clubs = data.clubs.map((club) => ({
      id: club.id,
      name: club.name,
      _count: {
        entries: data.entries.filter(
          (entry) =>
            entry.clubId === club.id &&
            entryMatches(data, entry, {
              archivedAt: (options.select?.clubs ?? options.include?.clubs)?.select?._count?.select
                ?.entries?.where?.archivedAt,
            }),
        ).length,
      },
    }));
    if (options.select) return { rosterRevision: data.tournament.rosterRevision, clubs };
    if (!options.include) return structuredClone(data.tournament);
    return structuredClone({
      ...data.tournament,
      clubs,
      tatamis: [],
      categories: data.categories
        .filter((category) => category.tournamentId === tournamentId)
        .map((category) => ({
          ...category,
          entries: data.entries.filter(
            (entry) =>
              entry.categoryId === category.id &&
              entryMatches(data, entry, options.include?.categories?.include?.entries?.where),
          ),
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
  const athleteMatches = (data, athlete, where = {}) =>
    (!where.id ||
      (typeof where.id === 'string'
        ? athlete.id === where.id
        : where.id.in.includes(athlete.id))) &&
    (where.ownerId === undefined || athlete.ownerId === where.ownerId) &&
    (!where.entries ||
      data.entries.some(
        (entry) => entry.athleteId === athlete.id && entryMatches(data, entry, where.entries.some),
      ));
  const byNewest = (a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt) || a.id.localeCompare(b.id);
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
          session: {
            findUnique: async ({ where }) => {
              if (!principalValid) return null;
              const principal = where.id === superAdmin.sessionId ? superAdmin : owner;
              return {
                id: principal.sessionId,
                userId: principal.id,
                user: { id: principal.id, role: principal.role, name: principal.name },
                expiresAt: new Date('2099-01-01'),
                invitationId: null,
                tatamiId: null,
              };
            },
          },
          $queryRaw: async (strings, ...values) => {
            locks.push({ sql: strings.join('?'), values });
            if (strings.join('').includes('SELECT a."id" FROM "Athlete" a')) {
              const [scopeOwner, authorized, search, limit] = values;
              const words = search.values;
              return staged.athletes
                .filter(
                  (athlete) =>
                    athlete.ownerId === scopeOwner &&
                    staged.entries.some((entry) => {
                      const current = category(staged, { id: entry.categoryId });
                      const permitted =
                        scopeOwner === null
                          ? current.tournamentId === authorized.values[0]
                          : findTournament(staged, current.tournamentId)?.ownerId === scopeOwner;
                      const text =
                        `${entry.lastName} ${entry.firstName} ${entry.birthYear} ${entry.club}`
                          .normalize('NFKC')
                          .trim()
                          .replace(/\s+/g, ' ')
                          .toLocaleLowerCase('ru');
                      return (
                        permitted &&
                        entry.athleteId === athlete.id &&
                        words.every((word) => text.includes(word))
                      );
                    }),
                )
                .sort(byNewest)
                .slice(0, limit)
                .map(({ id }) => ({ id }));
            }
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
            findMany: async ({ where }) =>
              staged.categories
                .filter(
                  (category) =>
                    where.categoryId.in.includes(category.id) &&
                    category.draw?.status === where.status,
                )
                .map((category) => ({
                  id: category.draw.id ?? `draw:${category.id}`,
                  categoryId: category.id,
                  version: category.draw.version ?? 1,
                  status: category.draw.status,
                  fingerprint: category.draw.fingerprint ?? 'saved-fingerprint',
                  snapshot: structuredClone(category.draw.snapshot ?? {}),
                })),
            update: async ({ where, data }) => {
              const category = staged.categories.find(
                (category) =>
                  category.draw && (category.draw.id ?? `draw:${category.id}`) === where.id,
              );
              category.draw = {
                ...category.draw,
                ...data,
                version: (category.draw.version ?? 1) + (data.version?.increment ?? 0),
              };
              return structuredClone(category.draw);
            },
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
          athlete: {
            findMany: async (options) => {
              athleteReads.push(structuredClone(options));
              return structuredClone(
                staged.athletes
                  .filter((athlete) => athleteMatches(staged, athlete, options.where))
                  .sort(byNewest)
                  .map((athlete) =>
                    options.include?.entries
                      ? {
                          ...athlete,
                          entries: staged.entries
                            .filter(
                              (entry) =>
                                entry.athleteId === athlete.id &&
                                entryMatches(staged, entry, options.include.entries.where),
                            )
                            .sort(byNewest)
                            .slice(0, options.include.entries.take)
                            .map((entry) => ({
                              ...entry,
                              category: category(staged, { id: entry.categoryId }),
                            })),
                        }
                      : athlete,
                  ),
              );
            },
            create: async ({ data }) => {
              const athlete = { id: randomUUID(), createdAt, ...structuredClone(data) };
              staged.athletes.push(athlete);
              return structuredClone(athlete);
            },
            createMany: async ({ data }) => {
              if (failAthleteWrite) {
                staged.athletes.push(structuredClone(data[0]));
                throw new Error('identity storage unavailable');
              }
              staged.athletes.push(...structuredClone(data));
              return { count: data.length };
            },
          },
          entry: {
            count: async ({ where }) =>
              staged.entries.filter((entry) => entryMatches(staged, entry, where)).length,
            findFirst: async ({ where }) =>
              structuredClone(
                staged.entries.find((entry) => entryMatches(staged, entry, where)) ?? null,
              ),
            findMany: async ({ where, include }) =>
              structuredClone(
                staged.entries
                  .filter((entry) => entryMatches(staged, entry, where))
                  .reverse()
                  .map((entry) =>
                    include?.category
                      ? {
                          ...entry,
                          category: category(staged, { id: entry.categoryId }),
                        }
                      : entry,
                  ),
              ),
            update: async ({ where, data }) => {
              const entry = staged.entries.find((entry) => entry.id === where.id);
              if (failEntryWrite) throw new Error('entry storage unavailable');
              const { category, clubRecord, athlete, ...values } = data;
              Object.assign(entry, structuredClone(values));
              if (category) entry.categoryId = category.connect.id;
              if (clubRecord) entry.clubId = clubRecord.connect.id;
              if (athlete) entry.athleteId = athlete.connect.id;
              return structuredClone(entry);
            },
            create: async ({ data }) => {
              const entry = {
                id: randomUUID(),
                createdAt,
                archivedAt: null,
                ...structuredClone(data),
              };
              staged.entries.push(entry);
              return structuredClone(entry);
            },
            createMany: async ({ data }) => {
              if (failEntryWrite) {
                staged.entries.push(structuredClone(data[0]));
                throw new Error('entry storage unavailable');
              }
              staged.entries.push(
                ...structuredClone(data).map((entry) => ({ archivedAt: null, ...entry })),
              );
              return { count: data.length };
            },
          },
          accessCommand: { findFirst: async () => null },
          tournamentCommand: { findFirst: async () => null },
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
          contest: {
            findFirst: async ({ where }) =>
              staged.contests.find((contest) =>
                where.OR.some((condition) =>
                  Object.entries(condition).every(([key, value]) => contest[key] === value),
                ),
              ) ?? null,
          },
          drawCommand: { findFirst: async () => null },
          protocolCommand: { findFirst: async () => null },
          liveOutbox: { create: async () => ({ id: 1n }) },
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
    revokePrincipal: () => {
      principalValid = false;
    },
    locks,
    athleteReads,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => {
      fn(saved);
      for (const entry of saved.entries) {
        entry.athleteId ??= entry.id;
        if (!saved.athletes.some((athlete) => athlete.id === entry.athleteId))
          saved.athletes.push({
            id: entry.athleteId,
            ownerId:
              findTournament(saved, category(saved, { id: entry.categoryId }).tournamentId)
                ?.ownerId ?? null,
            createdAt,
          });
      }
    },
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
    correction: (extra = {}) => ({
      id: randomUUID(),
      expectedRevision: saved.tournament.rosterRevision,
      reason: 'Исправление заявки',
      ...extra,
    }),
    update: (entryId, dto, user = owner, id = tournamentId) =>
      service.updateEntry(id, entryId, dto, user),
    archive: (entryId, dto, user = owner, id = tournamentId) =>
      service.archiveEntry(id, entryId, dto, user),
    restore: (entryId, dto, user = owner, id = tournamentId) =>
      service.restoreEntry(id, entryId, dto, user),
    previewEntry: (entryId, dto, user = owner) =>
      service.previewEntry(tournamentId, entryId, dto, user),
    archived: (user = owner) => service.archived(tournamentId, user),
    athletes: (query = '', limit = 20, user = owner) =>
      service.athletes(tournamentId, { query, limit }, user),
    previewIdentity: (entryId, athleteId, user = owner) =>
      service.previewIdentity(tournamentId, entryId, { athleteId }, user),
    bind: (entryId, dto, user = owner, id = tournamentId) =>
      service.bindIdentity(id, entryId, dto, user),
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
  await assert.rejects(h.commit(dto, superAdmin, randomUUID()), httpError(403, 'FORBIDDEN'));
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
  await h.commit(h.dto(), superAdmin);
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
    status: 'STALE',
    version: 2,
  });
  assert.equal(
    h.snapshot().audits.find((audit) => audit.action === 'DRAW_INVALIDATED').payload
      .invalidatedDraws[0].fingerprint,
    'historic',
  );
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
    tournamentCommand: { findFirst: async () => null },
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
  assert.ok(h.locks[1].sql.includes('"Tatami"'));
  assert.ok(h.locks[2].sql.includes('"Session"'));
  assert.ok(h.locks[3].sql.includes('"Category"'));
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
  const upgraded = original.map((entry) => ({
    gender: 'MALE',
    clubId,
    athleteId: randomUUID(),
    ...entry,
  }));
  assert.equal(entryFingerprint(upgraded), oldHash);
  assert.notEqual(entryFingerprint([...upgraded, { ...upgraded[0], id: randomUUID() }]), oldHash);
  assert.notEqual(
    entryFingerprint(upgraded.map((entry) => ({ ...entry, club: entry.club.trim() }))),
    oldHash,
  );
});

const savedEntry = (extra = {}) => ({
  id: randomUUID(),
  categoryId,
  firstName: 'Әлихан',
  lastName: 'Серік',
  birthYear: 2012,
  gender: 'MALE',
  club: 'Жас Қыран',
  clubId,
  createdAt,
  archivedAt: null,
  ...extra,
});
const previewEntry = (entry, extra = {}) => ({
  firstName: entry.firstName,
  lastName: entry.lastName,
  birthYear: entry.birthYear,
  gender: entry.gender ?? 'MALE',
  clubId: entry.clubId,
  categoryId: entry.categoryId,
  ...extra,
});
const seeded = (options = {}, extra = {}) => {
  const h = harness(options);
  const entry = savedEntry(extra);
  h.mutate((state) => state.entries.push(entry));
  return { h, entry };
};

test('correction DTOs require safe ID/version and a trimmed 3–500 character reason', async () => {
  const entry = savedEntry();
  const base = { id: randomUUID(), expectedRevision: 0, reason: '  Исправить ошибку  ' };
  for (const [Dto, valid] of [
    [EntryPreviewDto, previewEntry(entry)],
    [EntryUpdateDto, { ...base, ...previewEntry(entry) }],
    [EntryArchiveDto, base],
    [EntryRestoreDto, { ...base, duplicateConfirmed: true }],
  ])
    assert.equal((await validate(plainToInstance(Dto, valid))).length, 0);
  for (const Dto of [EntryArchiveDto, EntryRestoreDto, EntryUpdateDto])
    for (const bad of [
      { reason: undefined },
      { reason: '  ' },
      { reason: '  ab  ' },
      { reason: 'a'.repeat(501) },
      { id: 'bad' },
      { expectedRevision: 0.1 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.ok(
        (await validate(plainToInstance(Dto, { ...base, ...previewEntry(entry), ...bad }))).length >
          0,
      );
  assert.ok(
    (await validate(plainToInstance(EntryRestoreDto, { ...base, duplicateConfirmed: 'yes' })))
      .length > 0,
  );
});

test('editing preview excludes itself from duplicates and category capacity at 128', async () => {
  const { h, entry } = seeded();
  h.mutate((state) =>
    state.entries.push(
      ...Array.from({ length: 127 }, (_, index) => savedEntry({ lastName: `Other ${index}` })),
    ),
  );
  const before = h.snapshot();
  const result = await h.previewEntry(entry.id, previewEntry(entry));
  assert.equal(result.canSave, true);
  assert.deepEqual(result.rows, [
    { index: 0, errors: [], possibleDuplicates: [], duplicateCount: 0 },
  ]);
  assert.equal(result.before.id, entry.id);
  assert.equal(result.proposed.id, entry.id);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
  const updated = await h.update(entry.id, {
    ...h.correction(),
    ...previewEntry(entry, { lastName: 'Corrected' }),
  });
  assert.equal(updated.entry.id, entry.id);
  assert.equal(h.snapshot().entries.length, 128);
});

test('moving an entry preserves its identity and archives both affected preview snapshots in audit', async () => {
  const { h, entry } = seeded({}, { club: '  Historical text  ' });
  const destinationClub = randomUUID();
  h.mutate((state) => {
    state.clubs.push({
      id: destinationClub,
      tournamentId,
      name: 'Новый клуб',
      normalizedName: 'новый клуб',
      createdAt,
    });
    state.categories.forEach((category, index) => {
      category.draw = {
        id: `draw${index}`,
        status: 'PREVIEW',
        version: 7 + index,
        fingerprint: `hash${index}`,
        snapshot: { positions: [{ id: entry.id, clubId }], custom: index },
      };
    });
  });
  const before = h.snapshot();
  const dto = {
    ...h.correction({ reason: '  Перенести заявку  ' }),
    ...previewEntry(entry, {
      clubId: destinationClub,
      categoryId: femaleCategoryId,
      gender: 'FEMALE',
      lastName: 'Исправлено',
    }),
  };
  const preview = await h.previewEntry(entry.id, dto);
  assert.deepEqual(preview.affectedCategoryIds, [categoryId, femaleCategoryId].sort());
  assert.deepEqual(preview.invalidatedCategoryIds, [categoryId, femaleCategoryId].sort());
  assert.deepEqual(h.snapshot(), before);
  const response = await h.update(entry.id, dto);
  assert.equal(response.revision, 1);
  assert.equal(response.entry.id, entry.id);
  assert.equal(response.entry.createdAt, createdAt.toISOString());
  assert.equal(response.entry.categoryId, femaleCategoryId);
  assert.equal(response.entry.clubId, destinationClub);
  assert.equal(response.entry.club, 'Новый клуб');
  const after = h.snapshot();
  assert.equal(after.entries.length, 1);
  for (let index = 0; index < 2; index++) {
    assert.equal(after.categories[index].draw.status, 'STALE');
    assert.equal(after.categories[index].draw.version, before.categories[index].draw.version + 1);
    assert.equal(
      after.categories[index].draw.fingerprint,
      before.categories[index].draw.fingerprint,
    );
    assert.deepEqual(after.categories[index].draw.snapshot, before.categories[index].draw.snapshot);
  }
  const history = after.audits
    .filter((audit) => audit.action === 'DRAW_INVALIDATED')
    .flatMap((audit) => audit.payload.invalidatedDraws);
  assert.equal(history.length, 2);
  for (const item of history)
    assert.deepEqual(
      item.snapshot,
      before.categories.find((category) => category.id === item.categoryId).draw.snapshot,
    );
  const audit = after.audits.find((audit) => audit.action === 'ENTRY_UPDATED');
  assert.equal(audit.payload.reason, 'Перенести заявку');
  assert.equal(audit.payload.command.reason, dto.reason);
  assert.equal(audit.payload.command.entryId, entry.id);
  assert.equal(audit.payload.before.club, '  Historical text  ');
  assert.equal(audit.payload.after.id, entry.id);
  const categoryLocks = h.locks
    .filter((lock) => lock.sql.includes('"Category"'))
    .map((lock) => lock.values[0]);
  assert.deepEqual(categoryLocks, [categoryId, femaleCategoryId].sort());
});

test('archive and restore retain one Entry ID, full historical data and only active catalog counts', async () => {
  const { h, entry } = seeded({}, { club: 'Historical club snapshot', gender: null });
  const archived = await h.archive(entry.id, h.correction());
  assert.ok(archived.entry.archivedAt);
  assert.equal(h.snapshot().entries.length, 1);
  assert.equal((await h.get()).categories[0].entries.length, 0);
  assert.equal((await h.clubs()).clubs[0]._count.entries, 0);
  const listing = await h.archived();
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].id, entry.id);
  assert.equal(listing.entries[0].gender, 'MALE');
  const check = await h.previewEntry(entry.id, previewEntry(entry));
  assert.equal(check.canSave, true);
  assert.equal(check.before.gender, null);
  assert.equal(check.proposed.gender, 'MALE');
  assert.equal(check.proposed.archivedAt, null);
  const restored = await h.restore(entry.id, h.correction());
  assert.equal(restored.entry.archivedAt, null);
  assert.equal(restored.entry.gender, 'MALE');
  assert.deepEqual(h.snapshot().entries[0], entry, 'restore keeps raw legacy gender and club text');
  assert.equal((await h.archived()).entries.length, 0);
  assert.equal((await h.get()).categories[0].entries.length, 1);
  assert.equal((await h.clubs()).clubs[0]._count.entries, 1);
});

test('archived entries do not cause duplicate warnings but restore requires acknowledgement if name was reused', async () => {
  const { h, entry } = seeded();
  await h.archive(entry.id, h.correction());
  assert.equal((await h.preview()).canSave, true);
  const newEntry = await h.commit(h.dto());
  const before = h.snapshot();
  const preview = await h.previewEntry(entry.id, previewEntry(entry));
  assert.equal(preview.canSave, false);
  assert.equal(preview.rows[0].duplicateCount, 1);
  assert.equal(preview.rows[0].possibleDuplicates[0].entryId, newEntry.entries[0].id);
  await assert.rejects(
    h.restore(entry.id, h.correction()),
    rowError('DUPLICATE_CONFIRMATION_REQUIRED'),
  );
  assert.deepEqual(h.snapshot(), before);
  await h.restore(entry.id, h.correction({ duplicateConfirmed: true }));
  assert.equal((await h.get()).categories[0].entries.length, 2);
  assert.equal(new Set(h.snapshot().entries.map((entry) => entry.id)).size, 2);
});

test('restore preview rejects changes to archived original fields', async () => {
  const { h, entry } = seeded({}, { archivedAt: createdAt });
  const before = h.snapshot();
  const preview = await h.previewEntry(
    entry.id,
    previewEntry(entry, { lastName: 'Changed while archived' }),
  );
  assert.equal(preview.canSave, false);
  assert.ok(preview.rows[0].errors.includes('RESTORE_ORIGINAL_ONLY'));
  assert.deepEqual(h.snapshot(), before);
});

test('exact correction receipts replay after restart/status changes and anchor the target Entry path', async () => {
  const { h, entry } = seeded();
  const other = savedEntry({ lastName: 'Other' });
  h.mutate((state) => state.entries.push(other));
  const command = h.correction();
  const result = await h.archive(entry.id, command);
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
    state.tournament.rosterRevision = 99;
    state.contests.push({ whiteEntryId: entry.id });
  });
  h.restart();
  const before = h.snapshot();
  assert.deepEqual(await h.archive(entry.id, command), result);
  await assert.rejects(h.archive(other.id, command), httpError(409, 'COMMAND_ID_REUSED'));
  await assert.rejects(
    h.archive(entry.id, { ...command, reason: 'Changed reason' }),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
  await assert.rejects(h.restore(entry.id, command), httpError(409, 'COMMAND_ID_REUSED'));
  await assert.rejects(
    h.archive(entry.id, command, superAdmin, randomUUID()),
    httpError(403, 'FORBIDDEN'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('corrections reject foreign owners/judges, invalid reason/version and wrong archive state', async () => {
  const { h, entry } = seeded();
  for (const user of [
    { id: randomUUID(), role: 'ORGANIZER' },
    { id: owner.id, role: 'OPERATOR' },
  ]) {
    await assert.rejects(
      h.update(entry.id, { ...h.correction(), ...previewEntry(entry) }, user),
      httpError(403, 'FORBIDDEN'),
    );
    await assert.rejects(h.archive(entry.id, h.correction(), user), httpError(403, 'FORBIDDEN'));
    await assert.rejects(h.restore(entry.id, h.correction(), user), httpError(403, 'FORBIDDEN'));
    await assert.rejects(
      h.previewEntry(entry.id, previewEntry(entry), user),
      httpError(403, 'FORBIDDEN'),
    );
    await assert.rejects(h.archived(user), httpError(403, 'FORBIDDEN'));
  }
  const before = h.snapshot();
  await assert.rejects(
    h.archive(entry.id, h.correction({ reason: ' ab ' })),
    httpError(400, 'REASON_REQUIRED'),
  );
  await assert.rejects(
    h.archive(entry.id, h.correction({ expectedRevision: 12 })),
    httpError(409, 'VERSION_CONFLICT'),
  );
  await assert.rejects(h.restore(entry.id, h.correction()), httpError(409, 'ENTRY_NOT_ARCHIVED'));
  await assert.rejects(h.archive(randomUUID(), h.correction()), httpError(404, 'ENTRY_NOT_FOUND'));
  assert.deepEqual(h.snapshot(), before);
  await h.archive(entry.id, h.correction());
  await assert.rejects(h.archive(entry.id, h.correction()), httpError(409, 'ENTRY_ARCHIVED'));
  await assert.rejects(
    h.update(entry.id, { ...h.correction(), ...previewEntry(entry) }),
    httpError(409, 'ENTRY_ARCHIVED'),
  );
});

test('correction validation rolls back age/gender/category/duplicate errors without changing identity', async () => {
  const { h, entry } = seeded();
  h.mutate((state) =>
    state.entries.push(savedEntry({ firstName: 'Другой', lastName: 'Спортсмен' })),
  );
  const before = h.snapshot();
  for (const [fields, code] of [
    [{ birthYear: 2011 }, 'BIRTH_YEAR_OUT_OF_RANGE'],
    [{ gender: 'FEMALE' }, 'GENDER_MISMATCH'],
    [{ categoryId: randomUUID() }, 'CATEGORY_NOT_FOUND'],
    [{ lastName: '  ' }, 'NAME_REQUIRED'],
    [{ firstName: 'Другой', lastName: 'Спортсмен' }, 'DUPLICATE_CONFIRMATION_REQUIRED'],
  ]) {
    await assert.rejects(
      h.update(entry.id, { ...h.correction(), ...previewEntry(entry, fields) }),
      rowError(code),
    );
    assert.deepEqual(h.snapshot(), before);
  }
});

test('archive can remove an invalid admission without requiring new age or duplicate confirmation', async () => {
  const { h, entry } = seeded({}, { birthYear: 1999 });
  h.mutate((state) => state.entries.push(savedEntry({ birthYear: 1999 })));
  assert.ok((await h.archive(entry.id, h.correction())).entry.archivedAt);
});

test('source/destination confirmed draws and any contest reference block roster changes', async () => {
  const { h, entry } = seeded();
  const before = h.snapshot();
  for (const index of [0, 1]) {
    h.mutate((state) => {
      state.categories[index].draw = { status: 'CONFIRMED' };
    });
    await assert.rejects(
      h.update(entry.id, {
        ...h.correction(),
        ...previewEntry(entry, { categoryId: femaleCategoryId, gender: 'FEMALE' }),
      }),
      rowError('DRAW_LOCKED'),
    );
    h.mutate((state) => {
      state.categories[index].draw = null;
    });
  }
  assert.deepEqual(h.snapshot(), before);
  for (const field of ['whiteEntryId', 'blueEntryId', 'winnerEntryId']) {
    h.mutate((state) => {
      state.contests = [{ [field]: entry.id }];
    });
    assert.ok(
      (await h.previewEntry(entry.id, previewEntry(entry))).rows[0].errors.includes(
        'ENTRY_IN_DRAW',
      ),
    );
    await assert.rejects(
      h.update(entry.id, { ...h.correction(), ...previewEntry(entry) }),
      httpError(409, 'ENTRY_IN_DRAW'),
    );
    await assert.rejects(h.archive(entry.id, h.correction()), httpError(409, 'ENTRY_IN_DRAW'));
  }
});

test('restore cannot exceed category capacity and new mutations cannot change running roster', async () => {
  const { h, entry } = seeded({}, { archivedAt: createdAt });
  h.mutate((state) =>
    state.entries.push(
      ...Array.from({ length: 128 }, (_, index) => savedEntry({ lastName: `Active ${index}` })),
    ),
  );
  await assert.rejects(h.restore(entry.id, h.correction()), rowError('CATEGORY_CAPACITY'));
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
  });
  await assert.rejects(h.restore(entry.id, h.correction()), httpError(409, 'ROSTER_LOCKED'));
});

test('correction receipt/storage/audit failures roll back edits and draw invalidation together', async () => {
  for (const options of [{ failAudit: true }, { collision: true }, { failEntryWrite: true }]) {
    const { h, entry } = seeded(options);
    h.mutate((state) => {
      state.categories[0].draw = {
        id: 'preview',
        status: 'PREVIEW',
        version: 4,
        fingerprint: 'old',
        snapshot: { position: entry.id },
      };
    });
    const before = h.snapshot();
    await assert.rejects(
      h.update(entry.id, { ...h.correction(), ...previewEntry(entry, { lastName: 'Changed' }) }),
      options.collision ? httpError(409, 'COMMAND_ID_REUSED') : undefined,
    );
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('competing fresh edit/archive commands admit only one current roster version', async () => {
  const { h, entry } = seeded();
  const results = await Promise.allSettled([
    h.update(entry.id, { ...h.correction(), ...previewEntry(entry, { lastName: 'Changed' }) }),
    h.archive(entry.id, h.correction()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    httpError(
      409,
      'VERSION_CONFLICT',
    )(results.find((result) => result.status === 'rejected').reason),
  );
  assert.equal(h.snapshot().receipts.length, 1);
});

test('STALE draw confirmation rejects even if restoring entries returns the previous fingerprint', async () => {
  let entryReads = 0;
  const db = {
    category: { findUnique: async () => ({ id: categoryId, tournamentId }) },
    $transaction: async (callback) =>
      callback({
        $queryRaw: async () => [],
        session: {
          findUnique: async () => ({
            id: owner.sessionId,
            userId: owner.id,
            user: owner,
            expiresAt: new Date('2099-01-01'),
            invitationId: null,
          }),
        },
        tournament: { findUnique: async () => ({ id: tournamentId, ownerId: owner.id }) },
        drawCommand: { findUnique: async () => null },
        drawRecord: {
          findUnique: async () => ({ status: 'STALE', version: 8, fingerprint: 'old' }),
        },
        entry: {
          findMany: async () => {
            entryReads++;
            throw new Error('stale draw must not reach regeneration');
          },
        },
      }),
  };
  const service = new DrawsService({}, db, { owner: async () => {} });
  await assert.rejects(
    service.confirm(categoryId, { id: randomUUID(), version: 7 }, owner),
    httpError(409, 'DRAW_ENTRIES_CHANGED'),
  );
  assert.equal(entryReads, 0);
});

function history(h, extra = {}, historyOwner = owner.id) {
  const pastTournamentId = randomUUID();
  const pastCategoryId = randomUUID();
  const entry = savedEntry({
    categoryId: pastCategoryId,
    archivedAt: new Date(createdAt),
    ...extra,
  });
  h.mutate((state) => {
    state.otherTournaments.push({
      id: pastTournamentId,
      ownerId: historyOwner,
      status: 'FINISHED',
    });
    state.categories.push({
      id: pastCategoryId,
      tournamentId: pastTournamentId,
      gender: 'MALE',
      draw: null,
    });
    state.entries.push(entry);
  });
  return entry;
}

test('identity DTOs keep batch selection explicit and ordinary entry edits reject athleteId', async () => {
  const athleteId = randomUUID();
  const command = {
    id: randomUUID(),
    expectedRevision: 0,
    reason: 'Выбран существующий спортсмен',
    athleteId,
  };
  for (const [Dto, value] of [
    [EntryIdentityPreviewDto, { athleteId }],
    [EntryIdentityBindDto, command],
    [
      RosterCommitDto,
      { id: randomUUID(), expectedRevision: 0, clubId, entries: [row({ athleteId })] },
    ],
    [AthleteDirectoryQueryDto, { query: 'Әлихан', limit: '20' }],
  ])
    assert.equal((await validate(plainToInstance(Dto, value))).length, 0);
  for (const value of [
    { ...command, athleteId: 'wrong' },
    { ...command, expectedRevision: -1 },
    { ...command, reason: ' x ' },
    { ...command, id: undefined },
  ])
    assert.ok((await validate(plainToInstance(EntryIdentityBindDto, value))).length > 0);
  for (const limit of [0, 51, 1.5])
    assert.ok((await validate(plainToInstance(AthleteDirectoryQueryDto, { limit }))).length > 0);
  assert.ok(
    (
      await validate(
        plainToInstance(EntryUpdateDto, { ...command, ...previewEntry(savedEntry()) }),
        {
          whitelist: true,
          forbidNonWhitelisted: true,
        },
      )
    ).some((error) => error.property === 'athleteId'),
  );
  const { h, entry } = seeded();
  const before = h.snapshot();
  await assert.rejects(
    h.update(entry.id, { ...h.correction(), ...previewEntry(entry), athleteId }),
    httpError(400, 'IDENTITY_CHANGE_REQUIRES_BIND'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('new admissions never merge equal names and preserve independent identity metadata', async () => {
  const h = harness();
  const result = await h.commit(
    h.dto([row({ duplicateConfirmed: true }), row({ duplicateConfirmed: true })]),
  );
  assert.notEqual(result.entries[0].athleteId, result.entries[1].athleteId);
  assert.equal(h.snapshot().athletes.length, 2);
  for (const athlete of h.snapshot().athletes)
    assert.deepEqual(Object.keys(athlete).sort(), ['createdAt', 'id', 'ownerId']);
  const dto = h.correction();
  await h.update(result.entries[0].id, {
    ...dto,
    ...previewEntry(result.entries[0], { lastName: 'Новая фамилия', duplicateConfirmed: true }),
  });
  assert.equal(h.snapshot().entries[1].lastName, 'Серік');
  assert.equal(h.snapshot().entries[0].athleteId, result.entries[0].athleteId);
  assert.equal(h.snapshot().athletes.length, 2);
});

test('owner history selection reuses one identity without rewriting historical snapshots', async () => {
  const h = harness();
  const past = history(h, { gender: null, club: 'Historical snapshot', lastName: 'Old name' });
  const before = h.snapshot().entries[0];
  const result = await h.commit(h.dto([row({ athleteId: past.athleteId })]));
  assert.equal(result.entries[0].athleteId, past.athleteId);
  assert.notEqual(result.entries[0].id, past.id);
  assert.deepEqual(
    h.snapshot().entries.find((entry) => entry.id === past.id),
    before,
  );
  assert.equal(h.snapshot().athletes.length, 1);
});

test('one active admission per identity spans clubs and categories and batch duplicates cannot override it', async () => {
  const h = harness();
  const first = (await h.commit(h.dto())).entries[0];
  const before = h.snapshot();
  const attempted = row({
    firstName: 'Different',
    lastName: 'Name',
    gender: 'FEMALE',
    categoryId: femaleCategoryId,
    athleteId: first.athleteId,
    duplicateConfirmed: true,
  });
  assert.ok((await h.preview([attempted])).rows[0].errors.includes('ATHLETE_ALREADY_REGISTERED'));
  await assert.rejects(h.commit(h.dto([attempted])), rowError('ATHLETE_ALREADY_REGISTERED'));
  assert.deepEqual(h.snapshot(), before);
  const past = history(h);
  const batch = [
    row({ athleteId: past.athleteId, lastName: 'А' }),
    row({
      athleteId: past.athleteId,
      lastName: 'Б',
      categoryId: femaleCategoryId,
      gender: 'FEMALE',
    }),
  ];
  assert.ok(
    (await h.preview(batch)).rows.every((row) => row.errors.includes('ATHLETE_ALREADY_REGISTERED')),
  );
  await assert.rejects(h.commit(h.dto(batch)), rowError('ATHLETE_ALREADY_REGISTERED'));
});

test('foreign owner identities are unavailable even to a superadmin operating the target tournament', async () => {
  const { h, entry } = seeded();
  const foreign = history(h, {}, randomUUID());
  const before = h.snapshot();
  await assert.rejects(
    h.commit(h.dto([row({ athleteId: foreign.athleteId })]), superAdmin),
    rowError('ATHLETE_NOT_FOUND'),
  );
  await assert.rejects(
    h.previewIdentity(entry.id, foreign.athleteId, superAdmin),
    httpError(404, 'ATHLETE_NOT_FOUND'),
  );
  await assert.rejects(
    h.bind(entry.id, h.correction({ athleteId: foreign.athleteId }), superAdmin),
    httpError(404, 'ATHLETE_NOT_FOUND'),
  );
  assert.deepEqual(h.snapshot(), before);
  assert.ok(
    !(await h.athletes('', 20, superAdmin)).athletes.some(
      (athlete) => athlete.id === foreign.athleteId,
    ),
  );
});

test('directory filters authorized historical Unicode snapshots before a bounded latest-display read', async () => {
  const h = harness();
  const old = history(h, { lastName: '  Ｓｅｒｉｋ\uFEFFҚЫРАН ', gender: null });
  const latest = history(h, {
    athleteId: old.athleteId,
    lastName: 'Changed family',
    createdAt: new Date('2026-10-10T08:00:00.000Z'),
  });
  history(h, { lastName: 'ҚЫРАН' }, randomUUID());
  const before = h.snapshot();
  const result = await h.athletes('serik қыран', 1);
  assert.equal(result.athletes.length, 1);
  assert.equal(result.athletes[0].id, old.athleteId);
  assert.equal(result.athletes[0].display.entryId, latest.id);
  assert.equal(result.athletes[0].display.gender, 'MALE');
  assert.equal(result.athletes[0].activeEntry, null);
  assert.ok(h.athleteReads.every((read) => !read.include || read.include.entries.take === 1));
  const query = h.locks.find((lock) => lock.sql.includes('SELECT a."id" FROM "Athlete" a'));
  assert.ok(query.sql.includes('LIMIT'));
  assert.equal(query.values.at(-1), 1);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
  assert.equal((await h.athletes('%')).athletes.length, 0);
});

test('orphan identities never cross null-owner tournament boundaries', async () => {
  const { h, entry } = seeded();
  const otherOrphan = history(h, {}, null);
  h.mutate((state) => {
    state.tournament.ownerId = null;
    state.athletes.find((athlete) => athlete.id === entry.athleteId).ownerId = null;
  });
  const admin = superAdmin;
  const directory = await h.athletes('', 20, admin);
  assert.deepEqual(
    directory.athletes.map((athlete) => athlete.id),
    [entry.athleteId],
  );
  await assert.rejects(
    h.previewIdentity(entry.id, otherOrphan.athleteId, admin),
    httpError(404, 'ATHLETE_NOT_FOUND'),
  );
  await assert.rejects(
    h.commit(h.dto([row({ athleteId: otherOrphan.athleteId })]), admin),
    rowError('ATHLETE_NOT_FOUND'),
  );
});

test('identity preview is read-only and bind preserves raw snapshot while invalidating preview with history', async () => {
  const { h, entry } = seeded({}, { gender: null, club: '  Original club snapshot ' });
  const past = history(h, { firstName: 'Reference', lastName: 'Different' });
  h.mutate((state) => {
    state.categories[0].draw = {
      id: randomUUID(),
      status: 'PREVIEW',
      version: 2,
      fingerprint: 'old hash',
      snapshot: { entryId: entry.id },
    };
  });
  const before = h.snapshot();
  const preview = await h.previewIdentity(entry.id, past.athleteId);
  assert.equal(preview.canSave, true);
  assert.equal(preview.before.gender, null);
  assert.equal(preview.proposed.gender, null);
  assert.deepEqual(preview.proposed, { ...preview.before, athleteId: past.athleteId });
  assert.deepEqual(h.snapshot(), before);
  const command = h.correction({
    athleteId: past.athleteId,
    reason: '  Та же личность, подтверждено администратором  ',
  });
  const receipt = await h.bind(entry.id, command);
  assert.equal(receipt.entry.id, entry.id);
  assert.equal(receipt.entry.gender, 'MALE');
  assert.equal(receipt.entry.athleteId, past.athleteId);
  const after = h.snapshot();
  assert.deepEqual(
    after.entries.find((saved) => saved.id === entry.id),
    { ...before.entries.find((saved) => saved.id === entry.id), athleteId: past.athleteId },
  );
  assert.deepEqual(
    after.entries.find((saved) => saved.id === past.id),
    before.entries.find((saved) => saved.id === past.id),
  );
  assert.deepEqual(after.athletes, before.athletes);
  assert.equal(after.categories[0].draw.status, 'STALE');
  assert.equal(after.categories[0].draw.version, 3);
  assert.deepEqual(after.categories[0].draw.snapshot, before.categories[0].draw.snapshot);
  const audit = after.audits.find((audit) => audit.action === 'ENTRY_IDENTITY_BOUND');
  assert.equal(audit.payload.before.athleteId, entry.athleteId);
  assert.equal(audit.payload.after.athleteId, past.athleteId);
  assert.equal(audit.payload.reason, command.reason.trim());
  assert.deepEqual(
    after.audits.find((audit) => audit.action === 'DRAW_INVALIDATED').payload.invalidatedDraws[0]
      .snapshot,
    before.categories[0].draw.snapshot,
  );
  const athleteLocks = h.locks.filter((lock) => lock.sql.includes('FROM "Athlete" WHERE'));
  assert.deepEqual(
    athleteLocks.map((lock) => lock.values[0]),
    [entry.athleteId, past.athleteId].sort(),
  );
});

test('identity bind exact receipt survives restart/current changes and anchors tournament and entry paths', async () => {
  const { h, entry } = seeded();
  const past = history(h);
  const command = h.correction({ athleteId: past.athleteId });
  const receipt = await h.bind(entry.id, command);
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
    state.tournament.rosterRevision = 90;
    state.categories[0].draw = { status: 'CONFIRMED' };
  });
  h.restart();
  const before = h.snapshot();
  assert.deepEqual(await h.bind(entry.id, command), receipt);
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(h.bind(randomUUID(), command), httpError(409, 'COMMAND_ID_REUSED'));
  await assert.rejects(
    h.bind(entry.id, command, superAdmin, randomUUID()),
    httpError(403, 'FORBIDDEN'),
  );
  await assert.rejects(
    h.bind(entry.id, { ...command, reason: 'Другая причина' }),
    httpError(409, 'COMMAND_ID_REUSED'),
  );
  assert.equal(before.receipts.length, 1);
  assert.equal(before.audits.length, 1);
});

test('binding guards owner permissions, reason/version, current identity and archived/confirmed/contest state', async () => {
  const { h, entry } = seeded();
  const past = history(h);
  for (const user of [
    { id: randomUUID(), role: 'ORGANIZER' },
    { id: owner.id, role: 'OPERATOR' },
  ]) {
    await assert.rejects(h.previewIdentity(entry.id, past.athleteId, user), httpError(403));
    await assert.rejects(
      h.bind(entry.id, h.correction({ athleteId: past.athleteId }), user),
      httpError(403),
    );
    await assert.rejects(h.athletes('', 20, user), httpError(403));
  }
  await assert.rejects(
    h.bind(entry.id, h.correction({ athleteId: past.athleteId, reason: ' x ' })),
    httpError(400, 'REASON_REQUIRED'),
  );
  await assert.rejects(
    h.bind(entry.id, h.correction({ athleteId: past.athleteId, expectedRevision: 99 })),
    httpError(409, 'VERSION_CONFLICT'),
  );
  await assert.rejects(
    h.bind(entry.id, h.correction({ athleteId: entry.athleteId })),
    httpError(409, 'IDENTITY_UNCHANGED'),
  );
  for (const [prepare, code] of [
    [
      (state) => {
        state.entries[0].archivedAt = createdAt;
      },
      'ENTRY_ARCHIVED',
    ],
    [
      (state) => {
        state.categories[0].draw = { status: 'CONFIRMED' };
      },
      'DRAW_LOCKED',
    ],
    [
      (state) => {
        state.contests.push({ winnerEntryId: entry.id });
      },
      'ENTRY_IN_DRAW',
    ],
    [
      (state) => {
        state.tournament.status = 'RUNNING';
      },
      'ROSTER_LOCKED',
    ],
  ]) {
    h.mutate((state) => {
      state.entries[0].archivedAt = null;
      state.categories[0].draw = null;
      state.contests = [];
      state.tournament.status = 'DRAFT';
      prepare(state);
    });
    const before = h.snapshot();
    assert.ok((await h.previewIdentity(entry.id, past.athleteId)).errors.includes(code));
    await assert.rejects(
      h.bind(entry.id, h.correction({ athleteId: past.athleteId })),
      httpError(409, code),
    );
    assert.deepEqual(h.snapshot(), before);
  }
});

test('binding an identity already active elsewhere in the same tournament is always rejected', async () => {
  const h = harness();
  const entries = (
    await h.commit(
      h.dto([
        row({ lastName: 'А' }),
        row({ lastName: 'Б', categoryId: femaleCategoryId, gender: 'FEMALE' }),
      ]),
    )
  ).entries;
  const before = h.snapshot();
  assert.ok(
    (await h.previewIdentity(entries[0].id, entries[1].athleteId)).errors.includes(
      'ATHLETE_ALREADY_REGISTERED',
    ),
  );
  await assert.rejects(
    h.bind(entries[0].id, h.correction({ athleteId: entries[1].athleteId })),
    httpError(409, 'ATHLETE_ALREADY_REGISTERED'),
  );
  assert.deepEqual(h.snapshot(), before);
});

test('archiving frees tournament registration but restore preserves identity and rejects a replacement active admission', async () => {
  const h = harness();
  const original = (await h.commit(h.dto())).entries[0];
  await h.archive(original.id, h.correction());
  const second = (
    await h.commit(h.dto([row({ athleteId: original.athleteId, lastName: 'New registration' })]))
  ).entries[0];
  const before = h.snapshot();
  const preview = await h.previewEntry(
    original.id,
    previewEntry(original, { duplicateConfirmed: true }),
  );
  assert.ok(preview.rows[0].errors.includes('ATHLETE_ALREADY_REGISTERED'));
  await assert.rejects(
    h.restore(original.id, h.correction({ duplicateConfirmed: true })),
    rowError('ATHLETE_ALREADY_REGISTERED'),
  );
  assert.deepEqual(h.snapshot(), before);
  await h.archive(second.id, h.correction());
  const restored = await h.restore(original.id, h.correction());
  assert.equal(restored.entry.athleteId, original.athleteId);
  assert.equal(h.snapshot().athletes.length, 1);
});

test('identity creation and binding storage/audit failures roll back identities, snapshots and revision', async () => {
  const h = harness({ failAthleteWrite: true });
  const before = h.snapshot();
  await assert.rejects(h.commit(h.dto()), /identity storage unavailable/);
  assert.deepEqual(h.snapshot(), before);
  for (const options of [{ failAudit: true }, { collision: true }, { failEntryWrite: true }]) {
    const { h, entry } = seeded(options);
    const past = history(h);
    h.mutate((state) => {
      state.categories[0].draw = {
        status: 'PREVIEW',
        version: 1,
        fingerprint: 'old',
        snapshot: { entryId: entry.id },
      };
    });
    const before = h.snapshot();
    await assert.rejects(h.bind(entry.id, h.correction({ athleteId: past.athleteId })));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.notices.length, 0);
  }
});

test('competing bind and batch-registration commands admit only one current identity decision', async () => {
  const { h, entry } = seeded();
  const past = history(h);
  const results = await Promise.allSettled([
    h.bind(entry.id, h.correction({ athleteId: past.athleteId })),
    h.commit(
      h.dto([row({ athleteId: past.athleteId, lastName: 'Other', duplicateConfirmed: true })]),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    httpError(
      409,
      'VERSION_CONFLICT',
    )(results.find((result) => result.status === 'rejected').reason),
  );
  assert.equal(
    h
      .snapshot()
      .entries.filter(
        (entry) =>
          entry.athleteId === past.athleteId &&
          !entry.archivedAt &&
          entry.categoryId === categoryId,
      ).length,
    1,
  );
});

test('legacy roster writes and exact receipts recheck a revoked administrator session', async () => {
  const fresh = harness();
  fresh.revokePrincipal();
  const before = fresh.snapshot();
  await assert.rejects(fresh.commit(fresh.dto()), httpError(401, 'AUTH_REQUIRED'));
  await assert.rejects(
    fresh.club({ id: randomUUID(), expectedRevision: 0, name: 'Denied' }),
    httpError(401, 'AUTH_REQUIRED'),
  );
  await assert.rejects(
    fresh.legacy({ firstName: 'QA', lastName: 'Denied', club: 'QA', birthYear: 2012 }),
    httpError(401, 'AUTH_REQUIRED'),
  );
  assert.deepEqual(fresh.snapshot(), before);
  const retry = harness();
  const command = retry.dto();
  await retry.commit(command);
  retry.revokePrincipal();
  const saved = retry.snapshot();
  await assert.rejects(retry.commit(command), httpError(401, 'AUTH_REQUIRED'));
  assert.deepEqual(retry.snapshot(), saved);
});
