import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { scoreboardScores } from '@judo/engine/match';
import { fixtureRequest } from './test-access.mjs';
import { createTestUser } from './test-user.mjs';
import { pdfText } from './pdf-text.mjs';
import { appendJournalCommand } from '../apps/web/src/features/offline/journal.ts';
import {
  categoryResults,
  teamStandings,
} from '../apps/api/dist/modules/protocols/protocol-model.js';

// All sporting results use real commands. Only rest on our disposable fixture is accelerated.
const db = new PrismaClient(),
  base = process.env.TEST_API_URL,
  output = 'tmp/pdfs/scoreboard-v4';
assert.ok(base, 'Run through the isolated rehearsal');
const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
assert.match(schema, /^qa_rehearsal_[a-f0-9]{32}$/);
const cases = [
  'IPPON_REVOKE',
  'TWO_WAZA',
  'THIRD_SHIDO_REVOKE',
  'YUKO_TIME',
  'WAZA_BEATS_YUKO_TIME',
  'GOLDEN_YUKO',
  'GOLDEN_HOLD',
  'HOLD_IPPON',
  'HOLD_TOKETA_YUKO_TIME',
  'HOLD_SECOND_WAZA',
];
let owner, tournament, cookie;
const evidence = [],
  categories = [],
  coverage = new Map();
async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(base, path, data, auth);
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
async function pdf(kind, lang, phase) {
  const response = await fetch(
    `${base}/tournaments/${tournament.id}/protocol.pdf?kind=${kind}&lang=${lang}`,
    {
      headers: { Cookie: cookie },
    },
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = pdfText(bytes).replace(/\s+/g, ' ');
  assert.ok(text.includes(tournament.name));
  await writeFile(`${output}/${phase}-${kind.toLowerCase()}-${lang}.pdf`, bytes);
  return text;
}
try {
  await mkdir(output, { recursive: true });
  owner = await createTestUser(db);
  const login = await fixtureRequest(base, '/auth/login', {
    email: owner.email,
    password: owner.password,
  });
  assert.equal(login.status, 201);
  cookie = login.headers.get('set-cookie').split(';')[0];
  tournament = await call('/tournaments', {
    name: 'СЫНАҚ · Полный цикл v4',
    city: 'Алматы',
    venue: 'Изолированная проверка',
    startDate: '2026-10-16',
    endDate: '2026-10-16',
    tatamiCount: 3,
  });
  for (const [format, count, durationSeconds] of [
    ['ROUND_ROBIN', 8, 120],
    ['REPECHAGE', 9, 180],
    ['MIXED', 12, 240],
  ]) {
    const category = await call(`/tournaments/${tournament.id}/categories`, {
      name: `QA-${format}-${count}`,
      format,
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 30000 + categories.length * 10000,
      durationSeconds,
    });
    for (let i = 0; i < count; i++)
      await call(`/tournaments/${tournament.id}/categories/${category.id}/entries`, {
        firstName: 'Әлихан',
        lastName: `${format}-${String(i + 1).padStart(2, '0')}`,
        birthYear: 2012,
        club: `Сынақ клубы ${(i % 4) + 1}`,
      });
    const draw = await call(`/categories/${category.id}/draw/preview`, {});
    assert.equal(draw.snapshot.tieRanking, 'WINS_ONLY');
    assert.equal(draw.snapshot.tieMany, 'ADMIN_REVIEW');
    await call(`/categories/${category.id}/draw/confirm`, { version: draw.version });
    await call(`/categories/${category.id}/draw/publication`, {
      published: true,
      expectedRevision: 0,
    });
    categories.push(category);
    coverage.set(category.id, []);
  }
  await call(`/tournaments/${tournament.id}/publish`, {});
  for (const lang of ['ru', 'kk']) {
    const before = await pdf('DRAW', lang, 'before');
    assert.ok(before.includes(lang === 'ru' ? 'Ещё не определено' : 'Әлі анықталмаған'));
    assert.ok(!before.includes(lang === 'ru' ? 'Результаты подтверждены' : 'Нәтижелер расталған'));
    const participants = await pdf('PARTICIPANTS', lang, 'before');
    for (const category of categories) {
      const entries = await db.entry.findMany({ where: { categoryId: category.id } });
      for (const entry of entries)
        assert.ok(participants.includes(`${entry.lastName} ${entry.firstName}`));
    }
  }
  await call(`/tournaments/${tournament.id}/start`, {});
  const mats = await call(`/tournaments/${tournament.id}/tatamis`);
  let baselineRules;
  while (true) {
    const queues = await Promise.all(
      mats.map((m) => call(`/tournaments/${tournament.id}/tatamis/${m.id}`)),
    );
    const ready = queues.map((m) => m.queue[0]).find((m) => m && !m.blockedByRound);
    if (!ready) break;
    let current = await db.contest.findUniqueOrThrow({
      where: { id: ready.id },
      include: { draw: { include: { category: true } } },
    });
    const category = current.draw.category;
    const count = coverage.get(category.id).length;
    const scenario = cases[count % cases.length];
    const side = current.whiteEntryId < current.blueEntryId ? 'WHITE' : 'BLUE';
    const other = side === 'WHITE' ? 'BLUE' : 'WHITE';
    const winner = side === 'WHITE' ? current.whiteEntryId : current.blueEntryId;
    const path = `/tatamis/${current.tatamiId}/live/${current.id}/command`;
    const contestId = current.id;
    await db.contest.updateMany({
      where: { draw: { category: { tournamentId: tournament.id } }, status: 'CONFIRMED' },
      data: { endedAt: new Date(0) },
    });
    async function sport(type, extra = {}) {
      const row = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
      current = await call(path, {
        id: randomUUID(),
        expectedVersion: row.revision,
        type,
        ...extra,
      });
      return current;
    }
    async function expire() {
      if (current.state.status === 'RUNNING') await sport('STOP');
      const impact = await call(`/tournaments/${tournament.id}/control/${contestId}/impact`);
      current = await call(`/tournaments/${tournament.id}/control/${contestId}/command`, {
        id: randomUUID(),
        expectedRevision: impact.revision,
        impactToken: impact.impactToken,
        type: 'EDIT_TIME',
        phase: 'REGULAR',
        elapsedMs: category.durationSeconds * 1000,
        reason: 'QA: проверка окончания основного времени',
      });
    }
    async function hold(actions) {
      if (current.state.status === 'RUNNING') await sport('STOP');
      const sessionId = randomUUID();
      await sport('OFFLINE_OPEN', { sessionId });
      let journal = { sessionId, state: current.state, events: [] };
      for (const action of [{ type: 'START' }, ...actions])
        journal = appendJournalCommand(journal, action);
      await sport('OFFLINE_SYNC', { sessionId, events: journal.events });
      assert.deepEqual(current.state.awards, journal.state.awards);
      assert.deepEqual(current.state.outcome, journal.state.outcome);
      await sport('OFFLINE_RELEASE', { sessionId, events: [] });
    }
    await sport('START');
    const { durationMs, ...sharedRules } = current.state.rules;
    assert.equal(durationMs, category.durationSeconds * 1000);
    if (baselineRules) assert.deepEqual(sharedRules, baselineRules);
    else baselineRules = sharedRules;
    let reason;
    if (scenario === 'IPPON_REVOKE') {
      await sport('AWARD', { side: other, kind: 'IPPON' });
      await sport('REVOKE', { awardId: current.state.awards.at(-1).id });
      assert.equal(current.state.outcome, null);
      assert.equal(current.state.status, 'PAUSED');
      await sport('START');
      await sport('AWARD', { side, kind: 'IPPON' });
      reason = 'IPPON';
    } else if (scenario === 'TWO_WAZA') {
      await sport('AWARD', { side, kind: 'WAZA_ARI' });
      assert.equal(current.state.outcome, null);
      await sport('AWARD', { side, kind: 'WAZA_ARI' });
      reason = 'COMBINATION';
    } else if (scenario === 'THIRD_SHIDO_REVOKE') {
      for (let i = 0; i < 3; i++) await sport('AWARD', { side: other, kind: 'SHIDO' });
      assert.equal(scoreboardScores(current.state, side).IPPON, 1);
      const last = current.state.awards.at(-1).id;
      await sport('REVOKE', { awardId: last });
      assert.equal(scoreboardScores(current.state, side).IPPON, 0);
      assert.equal(current.state.outcome, null);
      await sport('AWARD', { side: other, kind: 'SHIDO' });
      reason = 'ACCUMULATED_SHIDO';
    } else if (scenario === 'YUKO_TIME' || scenario === 'WAZA_BEATS_YUKO_TIME') {
      if (scenario === 'WAZA_BEATS_YUKO_TIME') {
        for (let i = 0; i < 3; i++) await sport('AWARD', { side: other, kind: 'YUKO' });
        await sport('AWARD', { side, kind: 'WAZA_ARI' });
      } else await sport('AWARD', { side, kind: 'YUKO' });
      await expire();
      reason = 'TIME';
    } else if (scenario === 'GOLDEN_YUKO' || scenario === 'GOLDEN_HOLD') {
      await sport('AWARD', { side: other, kind: 'SHIDO' });
      await expire();
      assert.equal(
        current.state.status,
        'DECISION',
        'a non-terminal shido does not decide a tied score',
      );
      await sport('GOLDEN');
      if (scenario === 'GOLDEN_HOLD')
        await hold([
          { type: 'HOLD', side },
          { type: 'ADVANCE', ms: 5000 },
        ]);
      else {
        await sport('START');
        await sport('AWARD', { side, kind: 'YUKO' });
      }
      reason = 'GOLDEN_SCORE';
    } else if (scenario === 'HOLD_IPPON') {
      await hold([
        { type: 'HOLD', side },
        ...[4999, 1, 4999, 1, 10000].map((ms) => ({ type: 'ADVANCE', ms })),
      ]);
      assert.deepEqual(
        current.state.awards.filter((a) => a.active).map((a) => a.kind),
        ['IPPON'],
      );
      reason = 'IPPON';
    } else if (scenario === 'HOLD_TOKETA_YUKO_TIME') {
      await hold([
        { type: 'HOLD', side },
        { type: 'ADVANCE', ms: 5000 },
        { type: 'TOKETA' },
        { type: 'STOP' },
      ]);
      assert.equal(current.state.hold, null);
      assert.equal(scoreboardScores(current.state, side).YUKO, 1);
      await expire();
      reason = 'TIME';
    } else if (scenario === 'HOLD_SECOND_WAZA') {
      await sport('AWARD', { side, kind: 'WAZA_ARI' });
      await hold([
        { type: 'HOLD', side },
        { type: 'ADVANCE', ms: 10000 },
      ]);
      assert.equal(scoreboardScores(current.state, side).WAZA_ARI, 2);
      reason = 'COMBINATION';
    }
    assert.equal(current.state.status, 'PROVISIONAL', scenario);
    assert.deepEqual(current.state.outcome, { winner: side, reason }, scenario);
    const before = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
    assert.equal(before.winnerEntryId, null, 'provisional scoreboard cannot advance a winner');
    const packet = { id: randomUUID(), type: 'CONFIRM', expectedVersion: before.revision };
    const confirmed = await call(path, packet);
    assert.deepEqual(await call(path, packet), confirmed, 'confirmation has an immutable receipt');
    const saved = await db.contest.findUniqueOrThrow({ where: { id: contestId } });
    assert.equal(saved.winnerEntryId, winner);
    assert.equal(saved.resultReason, reason);
    const publicView = await call(`/public/tournaments/${tournament.id}`, undefined, '');
    const visible = publicView.categories
      .flatMap((c) => c.draw.contests)
      .find((m) => m.id === contestId);
    assert.equal(visible.winnerEntryId, winner);
    assert.equal(visible.resultReason, reason);
    assert.deepEqual(visible.state.awards, confirmed.state.awards);
    coverage.get(category.id).push(scenario);
    evidence.push({ format: category.format, key: before.key, scenario, side, winner, reason });
    assert.ok(evidence.length < 150, 'finite fixture tournament');
  }
  assert.equal((await call(`/tournaments/${tournament.id}`)).status, 'FINISHED');
  const completed = await db.category.findMany({
    where: { tournamentId: tournament.id },
    include: { entries: true, draw: { include: { contests: true } } },
  });
  const expectedTeams = new Map();
  for (const category of completed) {
    assert.deepEqual(
      new Set(coverage.get(category.id)),
      new Set(cases),
      `${category.format}: all scoreboard paths must run`,
    );
    const results = categoryResults(category);
    assert.ok(results.places);
    assert.ok(category.draw.contests.every((m) => m.status === 'CONFIRMED'));
    if (category.format === 'ROUND_ROBIN')
      assert.deepEqual(
        results.places.map((p) => p.entryId),
        category.entries.map((e) => e.id).sort(),
      );
    else {
      const main = category.draw.snapshot.matches.filter((m) => !m.stage || m.stage === 'MAIN');
      const final = category.draw.contests.find((m) => m.key === main.at(-1).id);
      const bronze = category.draw.contests.filter((m) =>
        category.draw.snapshot.matches.some((s) => s.id === m.key && s.stage === 'BRONZE'),
      );
      assert.equal(results.places.find((p) => p.place === 1).entryId, final.winnerEntryId);
      assert.equal(
        results.places.find((p) => p.place === 2).entryId,
        final.winnerEntryId === final.whiteEntryId ? final.blueEntryId : final.whiteEntryId,
      );
      assert.deepEqual(
        new Set(results.places.filter((p) => p.place === 3).map((p) => p.entryId)),
        new Set(bronze.map((m) => m.winnerEntryId)),
      );
    }
    for (const p of results.places.filter((p) => p.place <= 3)) {
      const entry = category.entries.find((e) => e.id === p.entryId);
      const medals = expectedTeams.get(entry.club) ?? [0, 0, 0];
      medals[p.place - 1]++;
      expectedTeams.set(entry.club, medals);
    }
  }
  const teams = teamStandings(completed);
  assert.equal(teams.complete, 3);
  for (const team of teams.teams)
    assert.deepEqual(
      [team.gold, team.silver, team.bronze],
      expectedTeams.get(team.club) ?? [0, 0, 0],
    );
  for (const lang of ['ru', 'kk'])
    for (const kind of ['DRAW', 'PARTICIPANTS', 'TEAMS']) {
      const text = await pdf(kind, lang, 'after');
      for (const category of completed) {
        assert.ok(text.includes(category.name));
        if (kind !== 'DRAW')
          for (const entry of category.entries)
            assert.ok(text.includes(`${entry.lastName} ${entry.firstName}`));
        else
          for (const p of categoryResults(category).places.filter((p) => p.place <= 3)) {
            const entry = category.entries.find((e) => e.id === p.entryId);
            assert.ok(text.includes(entry.lastName), `podium missing from PDF: ${entry.lastName}`);
            assert.ok(text.includes(entry.club));
          }
      }
    }
  await writeFile(
    `${output}/expected.json`,
    JSON.stringify(
      {
        passed: true,
        cases,
        evidence,
        categories: completed.map((c) => ({
          name: c.name,
          format: c.format,
          entries: c.entries,
          places: categoryResults(c).places,
        })),
        teams,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS v4 scoreboard -> draw -> public -> three PDFs/RU+KK: ${evidence.length} real confirmed bouts; ten scoring paths in each format; independent round-robin order, final/bronze and medal counts.`,
  );
} finally {
  // The enclosing rehearsal always drops the guarded disposable schema, including audit/receipts.
  await db.$disconnect();
}
