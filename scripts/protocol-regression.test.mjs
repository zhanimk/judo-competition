import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDraw, resolveMatches } from '@judo/engine/draw';
import { teamStandings } from '../apps/api/dist/modules/protocols/protocol-model.js';
import {
  requireTeamResults,
  teamReadiness,
} from '../apps/api/dist/modules/protocols/protocol-readiness.js';
import { protocolScope } from '../apps/api/dist/modules/protocols/protocol-scope.js';
import { ProtocolsService } from '../apps/api/dist/modules/protocols/protocols.service.js';
const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const { protocolResultClock } = await import(
  `${apiDist}/modules/protocols/protocol-result-clock.js`
);

test('confirmed zero-time Golden Score is shown in protocol details even when its reason is three shido', () => {
  assert.equal(
    protocolResultClock({ phase: 'GOLDEN', elapsedMs: 60000, goldenMs: 0 }),
    '1:00.0 + GS 0:00.0',
  );
  assert.equal(
    protocolResultClock({ phase: 'GOLDEN', elapsedMs: 60000, goldenMs: 35499 }),
    '1:00.0 + GS 0:35.4',
  );
});

test('regular protocol time preserves tenths and absent sporting state stays unknown', () => {
  assert.equal(protocolResultClock({ phase: 'REGULAR', elapsedMs: 35499, goldenMs: 0 }), '0:35.4');
  assert.equal(protocolResultClock(null), '—');
});

function category(id, format = 'ROUND_ROBIN', clubs = ['A', 'B']) {
  const entries = clubs.map((club, i) => ({
    id: `${id}-entry-${i}`,
    firstName: 'QA',
    lastName: `Спортшы ${i}`,
    birthYear: 2012,
    club,
  }));
  const snapshot = generateDraw(
    format,
    entries.map((entry) => ({ id: entry.id, clubId: entry.club })),
    9,
  );
  const winners = {};
  for (const match of snapshot.matches) {
    const row = resolveMatches(snapshot, winners).find((row) => row.id === match.id);
    winners[match.id] =
      entries.findIndex((entry) => entry.id === row.whiteEntryId) <
      entries.findIndex((entry) => entry.id === row.blueEntryId)
        ? row.whiteEntryId
        : row.blueEntryId;
  }
  return {
    id,
    name: `Категория ${id}`,
    birthYearFrom: 2012,
    birthYearTo: 2013,
    minWeightGrams: null,
    maxWeightGrams: 50000,
    durationSeconds: 180,
    format,
    entries,
    draw: {
      status: 'CONFIRMED',
      version: 1,
      publishedAt: null,
      snapshot,
      contests: resolveMatches(snapshot, winners).map((match) => ({
        key: match.id,
        status: 'CONFIRMED',
        whiteEntryId: match.whiteEntryId,
        blueEntryId: match.blueEntryId,
        winnerEntryId: match.winnerEntryId,
        offlineSessionId: null,
        offlineActorId: null,
        offlineControlGeneration: null,
      })),
    },
  };
}

const conflict = (code) => (error) => error.getStatus() === 409 && error.message === code;

test('team results accept complete round robin, repechage and mixed category snapshots immutably', () => {
  for (const [format, count] of [
    ['ROUND_ROBIN', 2],
    ['ROUND_ROBIN', 5],
    ['REPECHAGE', 8],
    ['MIXED', 8],
  ]) {
    const row = category(
      format,
      format,
      Array.from({ length: count }, (_, i) => `Club ${i}`),
    );
    const before = structuredClone(row);
    assert.equal(teamReadiness(row), null, format);
    requireTeamResults([row]);
    assert.deepEqual(row, before);
  }
});

test('team scope skips empty and archived-only configurations but retains incomplete populated categories', () => {
  const ready = category('ready');
  const pending = category('pending');
  pending.draw.status = 'STALE';
  const empty = { id: 'empty', entries: [], draw: { status: 'STALE' } };
  assert.deepEqual(protocolScope([empty, ready], 'TEAMS'), [ready]);
  assert.deepEqual(protocolScope([empty, pending], 'TEAMS'), [pending]);
  assert.throws(() => protocolScope([empty], 'TEAMS'), conflict('NO_ACTIVE_CATEGORIES'));
});

test('team result errors identify every unready selected category with its reason', () => {
  const noDraw = category('no-draw');
  noDraw.draw = null;
  const preview = category('preview');
  preview.draw.status = 'PREVIEW';
  const provisional = category('provisional');
  provisional.draw.contests[0].status = 'PROVISIONAL';
  const noWinner = category('no-winner');
  noWinner.draw.contests[0].winnerEntryId = null;
  assert.throws(
    () => requireTeamResults([category('ready'), noDraw, preview, provisional, noWinner]),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), {
        message: 'TEAMS_NOT_READY',
        categories: [
          { id: 'no-draw', name: 'Категория no-draw', reason: 'DRAW_NOT_CONFIRMED' },
          { id: 'preview', name: 'Категория preview', reason: 'DRAW_NOT_CONFIRMED' },
          { id: 'provisional', name: 'Категория provisional', reason: 'MATCHES_NOT_CONFIRMED' },
          { id: 'no-winner', name: 'Категория no-winner', reason: 'MATCHES_NOT_CONFIRMED' },
        ],
      });
      return true;
    },
  );
});

test('unreleased offline ownership blocks team PDF even when persisted winners look confirmed', () => {
  for (const [field, value] of [
    ['offlineSessionId', 'offline'],
    ['offlineActorId', 'actor'],
    ['offlineControlGeneration', 0],
  ]) {
    const row = category(field);
    row.draw.contests[0][field] = value;
    assert.equal(teamReadiness(row), 'OFFLINE_OWNED');
  }
});

test('missing, extra and duplicate contest keys cannot certify the snapshot', () => {
  for (const mutate of [
    (row) => row.draw.contests.pop(),
    (row) => row.draw.contests.push({ ...row.draw.contests[0], key: 'foreign-match' }),
    (row) => (row.draw.contests[0].key = 'foreign-match'),
    (row) => (row.draw.contests[1].key = row.draw.contests[0].key),
    (row) => (row.draw.snapshot.matches[1].id = row.draw.snapshot.matches[0].id),
  ]) {
    const row = category('keys', 'ROUND_ROBIN', ['A', 'B', 'C']);
    mutate(row);
    assert.equal(teamReadiness(row), 'RESULTS_INCONSISTENT');
  }
});

test('winners and stored pairs must agree with the sporting dependency graph', () => {
  const row = category(
    'winner',
    'REPECHAGE',
    Array.from({ length: 8 }, (_, i) => `Club ${i}`),
  );
  const stranger = structuredClone(row);
  stranger.draw.contests[0].winnerEntryId = 'foreign-entry';
  assert.equal(teamReadiness(stranger), 'RESULTS_INCONSISTENT');
  const pair = structuredClone(row);
  pair.draw.contests[0].whiteEntryId = pair.draw.contests[0].blueEntryId;
  assert.equal(teamReadiness(pair), 'RESULTS_INCONSISTENT');
  const dependency = structuredClone(row);
  const final = dependency.draw.snapshot.matches.findLast(
    (match) => !match.stage || match.stage === 'MAIN',
  );
  const finalContest = dependency.draw.contests.find((contest) => contest.key === final.id);
  finalContest.winnerEntryId = dependency.entries.find(
    (entry) => entry.id !== finalContest.whiteEntryId && entry.id !== finalContest.blueEntryId,
  ).id;
  assert.equal(teamReadiness(dependency), 'RESULTS_INCONSISTENT');
});

test('missing or duplicated historical entries and malformed draws never manufacture medals', () => {
  for (const mutate of [
    (row) => row.entries.pop(),
    (row) => row.entries.push({ ...row.entries[0] }),
    (row) => (row.draw.snapshot = {}),
    (row) => (row.draw.snapshot.matches = []),
  ]) {
    const row = category('history');
    mutate(row);
    assert.equal(teamReadiness(row), 'RESULTS_INCONSISTENT');
  }
});

test('a complete cyclic group still waits for its required tie-break results', () => {
  const row = category('cycle', 'ROUND_ROBIN', ['A', 'B', 'C']);
  row.draw.snapshot.tieBreak = 'REMATCH';
  for (const contest of row.draw.contests) {
    const white = row.entries.findIndex((entry) => entry.id === contest.whiteEntryId);
    const blue = row.entries.findIndex((entry) => entry.id === contest.blueEntryId);
    contest.winnerEntryId = (white + 1) % 3 === blue ? contest.whiteEntryId : contest.blueEntryId;
  }
  assert.equal(teamReadiness(row), 'RESULTS_UNRESOLVED');
});

test('team medals use lexicographic order, shared competition places and no invented bronze', () => {
  const rows = [category('two'), category('rr', 'ROUND_ROBIN', ['A', 'B', 'C', 'D', 'E'])];
  const summary = teamStandings(rows);
  assert.equal(summary.complete, 2);
  assert.equal(
    summary.teams.reduce((n, team) => n + team.gold, 0),
    2,
  );
  assert.equal(
    summary.teams.reduce((n, team) => n + team.silver, 0),
    2,
  );
  assert.equal(
    summary.teams.reduce((n, team) => n + team.bronze, 0),
    1,
  );
  const zeros = summary.teams.filter((team) => !team.gold && !team.silver && !team.bronze);
  assert.equal(zeros.length, 2);
  assert.ok(zeros.every((team) => team.rank === summary.teams.length - zeros.length + 1));
  const medals = teamStandings([
    category('gold-a', 'ROUND_ROBIN', ['A', 'S1']),
    category('gold-b', 'ROUND_ROBIN', ['B', 'S2']),
    category('silver-more-1', 'ROUND_ROBIN', ['A', 'S1']),
    category('silver-more-2', 'ROUND_ROBIN', ['A', 'S1']),
  ]);
  assert.ok(
    medals.teams.findIndex((team) => team.club === 'B') <
      medals.teams.findIndex((team) => team.club === 'S1'),
  );
  const tied = teamStandings([
    category('tie-a', 'ROUND_ROBIN', ['A', 'S1']),
    category('tie-b', 'ROUND_ROBIN', ['B', 'S2']),
  ]);
  assert.deepEqual(
    tied.teams.map((team) => team.rank),
    [1, 1, 3, 3],
  );
});

test('unfinished internal team previews retain unranked clubs without medals', () => {
  const row = category('unfinished');
  row.draw.contests[0].status = 'PROVISIONAL';
  assert.ok(
    teamStandings([row]).teams.every(
      (team) => team.rank === null && team.gold + team.silver + team.bronze === 0,
    ),
  );
});

function serviceFor(rows, status = 'RUNNING') {
  const reads = [];
  const db = {
    $transaction: async (callback, options) => {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      return callback({
        tournament: {
          findUniqueOrThrow: async (query) => {
            reads.push(query);
            const ids = query.include.categories.where.id?.in;
            return {
              name: 'Командный зачёт QA',
              city: 'Алматы',
              venue: 'QA arena',
              startDate: '2026-10-10',
              endDate: '2026-10-10',
              timezone: 'Asia/Almaty',
              status,
              categories: rows.filter((row) => !ids || ids.includes(row.id)),
            };
          },
        },
      });
    },
  };
  const ownerCalls = [];
  return {
    reads,
    ownerCalls,
    service: new ProtocolsService(db, { owner: async (...args) => ownerCalls.push(args) }),
  };
}

test('owner can download a ready selected team scope while other tournament categories are unfinished', async () => {
  const ready = category('ready');
  const pending = category('pending');
  pending.draw.contests[0].status = 'PROVISIONAL';
  const empty = { id: 'empty', entries: [], draw: { status: 'STALE' } };
  const { service, ownerCalls, reads } = serviceFor([ready, pending, empty]);
  const user = { id: 'owner' };
  for (const lang of ['ru', 'kk']) {
    const pdf = await service.create('tournament', undefined, lang, user, 'TEAMS', [
      'ready',
      'empty',
    ]);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const title = lang === 'ru' ? 'выбранные категории' : 'таңдалған санаттар';
    assert.ok(
      pdf.includes(Buffer.from(title, 'utf16le').swap16()),
      'PDF metadata names its selected category scope',
    );
  }
  assert.equal(reads.length, 2);
  assert.deepEqual(ownerCalls, [
    [user, 'tournament'],
    [user, 'tournament'],
  ]);
  await assert.rejects(
    service.create('tournament', undefined, 'ru', user, 'TEAMS'),
    conflict('TEAMS_NOT_READY'),
  );
});

test('finished tournament status cannot override an incomplete team category or a foreign category ID', async () => {
  const row = category('pending');
  row.draw.contests[0].status = 'PROVISIONAL';
  const { service } = serviceFor([row], 'FINISHED');
  await assert.rejects(
    service.create('tournament', undefined, 'ru', {}, 'TEAMS'),
    conflict('TEAMS_NOT_READY'),
  );
  await assert.rejects(
    service.create('tournament', undefined, 'ru', {}, 'TEAMS', ['pending', 'foreign']),
    (error) => error.getStatus() === 404 && error.message === 'CATEGORY_NOT_FOUND',
  );
  for (const kind of ['BOUTS', 'RESULTS', 'MEDALS', 'ALL'])
    await assert.rejects(
      service.create('tournament', undefined, 'ru', {}, kind),
      conflict('PROTOCOL_NOT_AVAILABLE'),
    );
});
