import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { createRoundRobin } from '@judo/engine/draw';
import { applyCommand, createMatch } from '@judo/engine/match';

const dist = process.env.JUDO_TEST_API_DIST ?? 'apps/api/dist',
  load = (path) => import(pathToFileURL(resolve(dist, path)).href),
  { PublicService } = await load('modules/public/public.service.js'),
  { MatchesService } = await load('modules/matches/matches.service.js');
const tournamentId = randomUUID(),
  matId = randomUUID(),
  categoryId = randomUUID();
function harness() {
  const entries = Array.from({ length: 3 }, (_, index) => ({
      id: randomUUID(),
      firstName: 'QA',
      lastName: 'Athlete-' + index,
      club: 'Club-' + index,
      clubId: 'club-' + index,
    })),
    draw = {
      ...createRoundRobin(entries, 10),
      tieBreak: 'REMATCH',
      tieRanking: 'WINS_ONLY',
      tieMany: 'ADMIN_REVIEW',
    },
    recordId = randomUUID();
  let matchState = createMatch({
    durationMs: 180000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['IPPON'],
    holdThresholds: [{ ms: 20000, score: 'IPPON' }],
  });
  for (const command of [{ type: 'START' }, { type: 'AWARD', side: 'WHITE', kind: 'IPPON' }])
    matchState = applyCommand(matchState, {
      ...command,
      id: randomUUID(),
      expectedVersion: matchState.version,
    });
  matchState.receipts.secret = 'PRIVATE COMMAND FINGERPRINT';
  const rows = draw.matches.map((match, index) => ({
    id: randomUUID(),
    drawId: recordId,
    key: match.id,
    round: match.round,
    whiteEntryId: match.white.entryId,
    blueEntryId: match.blue.entryId,
    winnerEntryId: null,
    status: index ? 'READY' : 'ACTIVE',
    revision: index ? 1 : 3,
    queueOrder: index + 1,
    tatamiId: matId,
    state: index ? null : matchState,
    resultReason: null,
    confirmedAt: null,
    updatedAt: new Date(0),
    offlineSessionId: null,
    offlineActorId: null,
    offlineControlGeneration: null,
  }));
  let saved = {
    tournament: {
      id: tournamentId,
      name: 'Published QA',
      status: 'RUNNING',
      publishedAt: new Date(0),
    },
    category: {
      id: categoryId,
      name: 'QA RR3',
      format: 'ROUND_ROBIN',
      homeTatamiId: matId,
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000,
      minWeightGrams: null,
      durationSeconds: 180,
      entries,
    },
    record: {
      id: recordId,
      categoryId,
      version: 1,
      status: 'CONFIRMED',
      publishedAt: new Date(0),
      snapshot: draw,
    },
    rows,
  };
  let afterTopRead,
    transactions = [],
    reads = [];
  const related = (data, row) => ({ ...row, draw: { ...data.record, category: data.category } });
  const txFor = (data) => ({
    tournament: {
      findFirst: async ({ where }) => {
        reads.push('tournament');
        const result =
          data.tournament.publishedAt && data.tournament.id === where.id
            ? {
                ...data.tournament,
                categories: [{ ...data.category, draw: { ...data.record, contests: data.rows } }],
                tatamis: [
                  {
                    id: matId,
                    number: 1,
                    status: data.rows.some((row) => row.status === 'ACTIVE') ? 'BUSY' : 'IDLE',
                  },
                ],
              }
            : null;
        if (afterTopRead) {
          const hook = afterTopRead;
          afterTopRead = undefined;
          await hook();
        }
        return structuredClone(result);
      },
    },
    tatami: {
      findUnique: async () => {
        reads.push('view.mat');
        return { id: matId, tournamentId, number: 1, tournament: data.tournament };
      },
    },
    contest: {
      findFirst: async ({ where }) => {
        reads.push('view.' + where.status);
        const row = data.rows.find((row) => row.status === where.status);
        return structuredClone(row ? related(data, row) : null);
      },
      findMany: async ({ where }) => {
        reads.push('queue.rows');
        return structuredClone(
          data.rows.filter((row) => row.status === where.status).map((row) => related(data, row)),
        );
      },
      aggregate: async () => {
        reads.push('queue.round');
        const unfinished = data.rows.filter((row) => row.status !== 'CONFIRMED');
        return {
          _min: {
            round: unfinished.length ? Math.min(...unfinished.map((row) => row.round)) : null,
          },
        };
      },
    },
    drawRecord: {
      findMany: async () => {
        reads.push('queue.snapshot');
        return structuredClone([{ ...data.record, contests: data.rows }]);
      },
    },
    category: {
      findMany: async () => {
        reads.push('queue.barrier');
        return structuredClone([
          { ...data.category, draw: { ...data.record, contests: data.rows } },
        ]);
      },
    },
    $queryRaw: async () => assert.fail('public reads must not take row locks'),
  });
  const db = {
    $transaction: async (handler, options) => {
      transactions.push(options);
      return handler(txFor(structuredClone(saved)));
    },
    // Any escape to autocommit can read a later result and breaks the snapshot.
    tatami: { findUnique: async () => assert.fail('view escaped the read transaction') },
    contest: {
      findFirst: async () => assert.fail('view escaped the read transaction'),
      findMany: async () => assert.fail('queue escaped the read transaction'),
    },
    tournament: { findFirst: async () => assert.fail('publication escaped the read transaction') },
  };
  const matches = new MatchesService(db, {}, { notify: () => {} });
  const service = new PublicService(db, matches);
  return {
    service,
    reads,
    transactions,
    snapshot: () => structuredClone(saved),
    mutate: (callback) => callback(saved),
    afterTop: (callback) => {
      afterTopRead = callback;
    },
    confirm: () => {
      const row = saved.rows[0];
      row.status = 'CONFIRMED';
      row.winnerEntryId = row.whiteEntryId;
      row.confirmedAt = new Date();
      row.resultReason = 'IPPON';
      row.state.status = 'CONFIRMED';
      row.revision++;
    },
  };
}

test('public draw, current match and round queue retain one old snapshot while confirmation commits between their reads', async () => {
  const h = harness(),
    initial = h.snapshot();
  h.afterTop(h.confirm);
  const old = await h.service.get(tournamentId),
    row = old.categories[0].draw.contests[0];
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.winnerEntryId, null);
  assert.equal(old.tatamis[0].currentMatch.id, row.id);
  assert.ok(old.tatamis[0].queue.every((row) => row.blockedByRound));
  assert.equal(
    h.snapshot().rows[0].status,
    'CONFIRMED',
    'the writer has committed before the remaining public reads',
  );
  const next = await h.service.get(tournamentId);
  assert.equal(next.categories[0].draw.contests[0].status, 'CONFIRMED');
  assert.equal(next.tatamis[0].currentMatch, null);
  assert.equal(next.tatamis[0].queue[0].blockedByRound, false);
  assert.deepEqual(h.transactions, [
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  ]);
  assert.deepEqual(old.categories[0].draw.contests[0].state.receipts, {});
  assert.deepEqual(old.tatamis[0].currentMatch.state.receipts, {});
  assert.ok(initial.rows[0].state.receipts.secret);
});

test('historical public draw states never expose receipt fingerprints or mutate the stored state', async () => {
  const h = harness();
  h.confirm();
  const saved = h.snapshot(),
    result = await h.service.get(tournamentId);
  assert.deepEqual(result.categories[0].draw.contests[0].state.receipts, {});
  assert.equal(JSON.stringify(result).includes('PRIVATE COMMAND FINGERPRINT'), false);
  assert.deepEqual(h.snapshot(), saved);
});

test('publication visibility uses the same snapshot; later hiding denies the next read before scoreboard or queue queries', async () => {
  const h = harness();
  h.afterTop(() =>
    h.mutate((data) => {
      data.tournament.publishedAt = null;
    }),
  );
  const old = await h.service.get(tournamentId);
  assert.equal(old.id, tournamentId);
  const previousReads = h.reads.length;
  await assert.rejects(
    h.service.get(tournamentId),
    (error) => error.getStatus() === 404 && error.message === 'PUBLIC_TOURNAMENT_NOT_FOUND',
  );
  assert.deepEqual(h.reads.slice(previousReads), ['tournament']);
});

test('hidden draw state stays private while its public scoreboard/queue still read the same authorized tournament', async () => {
  const h = harness();
  h.mutate((data) => {
    data.record.publishedAt = null;
  });
  const result = await h.service.get(tournamentId);
  assert.equal(result.categories[0].draw, null);
  assert.ok(result.tatamis[0].currentMatch);
  assert.equal(result.tatamis[0].queue.length, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE COMMAND FINGERPRINT'), false);
});
