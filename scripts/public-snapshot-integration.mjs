import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PublicService } from '../apps/api/dist/modules/public/public.service.js';
import { MatchesService } from '../apps/api/dist/modules/matches/matches.service.js';
import { fixtureControl, fixtureRequest } from './test-access.mjs';
import { createTestUser } from './test-user.mjs';

// The real service uses real PostgreSQL MVCC. A test-only adapter pauses just
// after the top SELECT, then an actual HTTP sporting command commits. There are
// no production hooks, database function replacements or row locks on the read.
const db = new PrismaClient(),
  base = process.env.TEST_API_URL;
let owner, tournament;
async function call(path, data, cookie = '') {
  const response = await fixtureRequest(base, path, data, cookie);
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, data, cookie) {
  const response = await call(path, data, cookie);
  assert.ok(response.status < 300, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
async function snapshotAcrossCommit(write) {
  let capturedResolve, capturedReject, resume;
  const captured = new Promise((resolve, reject) => {
      capturedResolve = resolve;
      capturedReject = reject;
    }),
    released = new Promise((resolve) => {
      resume = resolve;
    });
  const adapter = new Proxy(db, {
    get(target, property) {
      if (property === '$transaction')
        return (handler, options) => {
          assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.RepeatableRead);
          return target.$transaction(async (tx) => {
            const reader = new Proxy(tx, {
              get(transaction, delegate) {
                if (delegate === 'tournament')
                  return new Proxy(transaction.tournament, {
                    get(model, method) {
                      if (method === 'findFirst')
                        return async (args) => {
                          const selected = await model.findFirst(args);
                          assert.ok(selected);
                          capturedResolve();
                          await released;
                          return selected;
                        };
                      const member = Reflect.get(model, method);
                      return typeof member === 'function' ? member.bind(model) : member;
                    },
                  });
                const member = Reflect.get(transaction, delegate);
                return typeof member === 'function' ? member.bind(transaction) : member;
              },
            });
            return handler(reader);
          }, options);
        };
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const service = new PublicService(adapter, new MatchesService(adapter, {}, { notify: () => {} })),
    pendingRead = service.get(tournament.id);
  pendingRead.catch(capturedReject);
  let timeout;
  try {
    await Promise.race([
      captured,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('public read did not reach its real top SELECT')),
          4000,
        );
      }),
    ]);
    clearTimeout(timeout);
    // A read lock regression would prevent this HTTP writer from completing
    // before resume; the timeout fails without releasing the reader early.
    await Promise.race([
      write(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('the public read blocked the real HTTP writer')),
          4000,
        );
      }),
    ]);
    clearTimeout(timeout);
    resume();
    return await pendingRead;
  } finally {
    clearTimeout(timeout);
    resume();
    await Promise.allSettled([pendingRead]);
  }
}

async function seedHistoricalReceiptFixture(contestId) {
  // Current commands use MatchEvent receipts and intentionally clear this map.
  // An isolated pre-upgrade state is still required to prove public privacy.
  const row = await db.contest.findFirstOrThrow({
    where: {
      id: contestId,
      status: 'CONFIRMED',
      draw: { category: { tournamentId: tournament.id } },
    },
  });
  assert.equal(row.state.status, 'CONFIRMED');
  const receipts = { [randomUUID()]: 'QA PRIVATE LEGACY COMMAND FINGERPRINT' };
  await db.contest.update({ where: { id: row.id }, data: { state: { ...row.state, receipts } } });
  return db.contest.findUniqueOrThrow({ where: { id: row.id } });
}

try {
  assert.ok(base, 'explicit TEST_API_URL is required');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  assert.match(schema ?? '', /^qa_[a-z0-9_]+$/, 'only disposable qa_ schemas are allowed');
  const [{ actual }] = await db.$queryRaw`SELECT current_schema()::text AS actual`;
  assert.equal(actual, schema);
  owner = await createTestUser(db);
  const login = await call('/auth/login', { email: owner.email, password: owner.password });
  assert.equal(login.status, 201);
  const cookie = login.cookie;
  tournament = await ok(
    '/tournaments',
    {
      name: 'QA · Public RepeatableRead confirmation race',
      city: 'QA',
      venue: 'Isolated rehearsal',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 1,
    },
    cookie,
  );
  const category = await ok(
    `/tournaments/${tournament.id}/categories`,
    {
      name: 'QA public RR3',
      format: 'ROUND_ROBIN',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      durationSeconds: 180,
    },
    cookie,
  );
  for (let i = 0; i < 3; i++)
    await ok(
      `/tournaments/${tournament.id}/categories/${category.id}/entries`,
      {
        firstName: 'Әлихан',
        lastName: 'Public snapshot-' + i,
        birthYear: 2012,
        club: 'QA Snapshot ' + i,
      },
      cookie,
    );
  const preview = await ok(`/categories/${category.id}/draw/preview`, {}, cookie);
  await ok(`/categories/${category.id}/draw/confirm`, { version: preview.version }, cookie);
  await ok(
    `/categories/${category.id}/draw/publication`,
    { published: true, expectedRevision: 0 },
    cookie,
  );
  await ok(`/tournaments/${tournament.id}/start`, {}, cookie);
  await ok(`/tournaments/${tournament.id}/publish`, {}, cookie);
  const [mat] = await ok(`/tournaments/${tournament.id}/tatamis`, undefined, cookie),
    dashboard = await ok(`/tournaments/${tournament.id}/tatamis/${mat.id}`, undefined, cookie),
    first = dashboard.queue[0],
    grant = await fixtureControl(base, mat.id, cookie),
    commandPath = `/tatamis/${mat.id}/live/${first.id}/command`;
  let state = await ok(
    commandPath,
    { id: randomUUID(), type: 'START', expectedVersion: first.revision, ...grant },
    cookie,
  );
  state = await ok(
    commandPath,
    {
      id: randomUUID(),
      type: 'AWARD',
      kind: 'IPPON',
      side: 'WHITE',
      expectedVersion: state.revision,
      ...grant,
    },
    cookie,
  );
  const original = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
  const confirmDto = {
    id: randomUUID(),
    type: 'CONFIRM',
    expectedVersion: state.revision,
    ...grant,
  };
  const old = await snapshotAcrossCommit(async () => {
    const confirmed = await ok(commandPath, confirmDto, cookie);
    assert.equal(confirmed.status, 'CONFIRMED');
  });
  const oldContest = old.categories
    .find((row) => row.id === category.id)
    .draw.contests.find((row) => row.id === first.id);
  assert.equal(oldContest.status, 'ACTIVE');
  assert.equal(oldContest.winnerEntryId, null);
  assert.deepEqual(oldContest.state.receipts, {});
  assert.equal(old.tatamis[0].currentMatch.id, first.id);
  assert.equal(old.tatamis[0].currentMatch.state.status, 'PROVISIONAL');
  assert.deepEqual(old.tatamis[0].currentMatch.state.receipts, {});
  assert.ok(old.tatamis[0].queue.every((row) => row.blockedByRound));

  const privateLegacy = await seedHistoricalReceiptFixture(first.id);
  const fresh = await ok(`/public/tournaments/${tournament.id}`),
    newContest = fresh.categories
      .find((row) => row.id === category.id)
      .draw.contests.find((row) => row.id === first.id);
  assert.equal(newContest.status, 'CONFIRMED');
  assert.equal(newContest.winnerEntryId, original.whiteEntryId);
  assert.deepEqual(newContest.state.receipts, {});
  assert.equal(fresh.tatamis[0].currentMatch, null);
  assert.equal(fresh.tatamis[0].queue[0].blockedByRound, false);
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: first.id } }),
    privateLegacy,
    'public sanitization does not mutate the private durable receipts',
  );
  assert.equal(JSON.stringify(fresh).includes('QA PRIVATE LEGACY COMMAND FINGERPRINT'), false);

  const visibleBeforeHide = await snapshotAcrossCommit(async () => {
    await ok(
      `/categories/${category.id}/draw/publication`,
      {
        published: false,
        expectedRevision: 1,
      },
      cookie,
    );
  });
  assert.ok(visibleBeforeHide.categories.find((row) => row.id === category.id).draw);
  assert.equal(
    (await ok(`/public/tournaments/${tournament.id}`)).categories.find(
      (row) => row.id === category.id,
    ).draw,
    null,
  );
  console.log(
    'PASS real PostgreSQL public RepeatableRead: HTTP CONFIRM/hide commit between reads without blocking; response remains entirely old and next HTTP GET entirely new; historical/current receipt fingerprints stay private',
  );
} finally {
  if (tournament) {
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament.id } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament.id } } });
    await db.category.deleteMany({ where: { tournamentId: tournament.id } });
    await db.club.deleteMany({ where: { tournamentId: tournament.id } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament.id } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament.id } });
    await db.tournament.delete({ where: { id: tournament.id } });
  }
  if (owner) {
    await db.athlete.deleteMany({ where: { ownerId: owner.id } });
    await db.user.delete({ where: { id: owner.id } });
  }
  await db.$disconnect();
}
