import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { generateDraw, drawFormat, placements, resolveMatches } from '@judo/engine/draw';
import { fixtureRequest } from './test-access.mjs';
import { createTestUser, createTestEntries } from './test-user.mjs';
import {
  categoryResults,
  teamStandings,
} from '../apps/api/dist/modules/protocols/protocol-model.js';
import { pdfText } from './pdf-text.mjs';
import { liveSocket, connectLive } from './test-live.mjs';

const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
assert.match(schema ?? '', /^qa_rehearsal_[a-f0-9]{32}$/);
const base = process.env.TEST_API_URL;
assert.ok(base, 'Run only through the isolated rehearsal');
const db = new PrismaClient();
const sizes = [2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128];
const output = 'tmp/pdfs/full-tournament-matrix';
const report = {
  schema,
  passed: false,
  core: [],
  categories: [],
  pdfs: [],
  synthetic: true,
  limits: [
    'Rest is accelerated only in this disposable QA tournament; live venue timing is tested separately.',
    'Deterministic complete paths are not exhaustive sporting outcomes.',
  ],
};
let tournament,
  owner,
  cookie = '',
  socket;
const notices = [];
async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(base, path, data, auth);
  const body = await response.json();
  assert.equal(response.status, data === undefined ? 200 : 201, `${path}: ${JSON.stringify(body)}`);
  return body;
}
try {
  await mkdir(output, { recursive: true });
  // Every supported count, with distinct champions/bronzes and no unresolved real bouts.
  for (let n = 2; n <= 128; n++)
    for (const format of ['REPECHAGE', 'ROUND_ROBIN', 'MIXED']) {
      const draw = {
        ...generateDraw(
          format,
          Array.from({ length: n }, (_, i) => ({
            id: String(i).padStart(3, '0'),
            clubId: 'c' + (i % 5),
          })),
          n * 17,
          'TWO_FORMATS',
        ),
        tieBreak: 'REMATCH',
        tieRanking: 'WINS_ONLY',
        tieMany: 'ADMIN_REVIEW',
        roundRobinMedals: 'TWO_BRONZE_FOR_FOUR_FIVE',
      };
      const winners = {};
      let count = 0;
      for (;;) {
        const ready = resolveMatches(draw, winners).filter((m) => m.ready && !winners[m.id]);
        if (!ready.length) break;
        for (const m of ready) {
          winners[m.id] = [m.whiteEntryId, m.blueEntryId].sort()[0];
          count++;
        }
      }
      const places = placements(draw, winners);
      assert.ok(places, `No places for ${n}/${format}`);
      assert.equal(new Set(places.map((p) => p.entryId)).size, places.length);
      if (n >= 6)
        assert.deepEqual(
          places.filter((p) => p.place <= 3).map((p) => p.place),
          [1, 2, 3, 3],
        );
      assert.equal(Object.keys(winners).length, draw.matches.length);
      assert.equal(drawFormat(draw), n <= 5 ? 'ROUND_ROBIN' : 'REPECHAGE');
      report.core.push({ n, requested: format, actual: drawFormat(draw), bouts: count });
    }
  owner = await createTestUser(db);
  const login = await fixtureRequest(base, '/auth/login', {
    email: owner.email,
    password: owner.password,
  });
  assert.equal(login.status, 201);
  cookie = login.headers.get('set-cookie').split(';')[0];
  tournament = await call('/tournaments', {
    name: 'ТЕСТ QA · Полный турнир v7 · 19 размеров',
    city: 'Тест',
    venue: 'Изолированная QA-схема',
    startDate: '2026-10-28',
    endDate: '2026-10-28',
    tatamiCount: 3,
  });
  assert.equal(tournament.rulesSnapshot.version, 'custom-2026-v7');
  for (const n of sizes) {
    const category = await call(`/tournaments/${tournament.id}/categories`, {
      name: `QA ${String(n).padStart(3, '0')} участников`,
      format: 'REPECHAGE',
      gender: 'MALE',
      birthYearFrom: 2012,
      birthYearTo: 2013,
      maxWeightGrams: 20000 + n * 100,
      durationSeconds: 180,
    });
    await createTestEntries(
      db,
      Array.from({ length: n }, (_, i) => ({
        id: randomUUID(),
        categoryId: category.id,
        firstName: 'Әлихан',
        lastName: `QA${n}Спортсмен${i}`,
        birthYear: 2012,
        gender: 'MALE',
        club: `ТЕСТ клуб ${i % 5}`,
      })),
    );
    const preview = await call(`/categories/${category.id}/draw/preview`, {});
    assert.equal(drawFormat(preview.snapshot), n <= 5 ? 'ROUND_ROBIN' : 'REPECHAGE');
    await call(`/categories/${category.id}/draw/confirm`, { version: preview.version });
    await call(`/categories/${category.id}/draw/publication`, {
      published: true,
      expectedRevision: 0,
    });
    report.categories.push({ id: category.id, n, bouts: preview.snapshot.matches.length });
  }
  await call(`/tournaments/${tournament.id}/publish`, {});
  socket = liveSocket(base, tournament.id);
  socket.on('notice', (n) => notices.push(n));
  await connectLive(socket);
  await call(`/tournaments/${tournament.id}/start`, {});
  const mats = await call(`/tournaments/${tournament.id}/tatamis`);
  const remainingTotal = async () => {
    const views = await Promise.all(mats.map((mat) => call(`/tatamis/${mat.id}/live`)));
    assert.ok(views.every((view) => Number.isSafeInteger(view.remainingMatches)));
    return views.reduce((sum, view) => sum + view.remainingMatches, 0);
  };
  const expectedBouts = report.categories.reduce((sum, category) => sum + category.bouts, 0);
  assert.equal(
    await remainingTotal(),
    expectedBouts,
    'remaining count includes future bracket dependencies',
  );
  let completed = 0;
  for (;;) {
    const ready = await db.contest.findMany({
      where: { draw: { category: { tournamentId: tournament.id } }, status: 'READY' },
    });
    if (!ready.length) break;
    const queues = await Promise.all(
      mats.map(async (m) => (await call(`/tournaments/${tournament.id}/tatamis/${m.id}`)).queue),
    );
    const next = queues.map((q) => q[0]).find((m) => m && !m.blockedByRound);
    assert.ok(next, 'An earliest round must be schedulable');
    const row = ready.find((m) => m.id === next.id);
    assert.ok(row?.tatamiId);
    let result = await call(`/tatamis/${row.tatamiId}/live/${row.id}/command`, {
      id: randomUUID(),
      expectedVersion: row.revision,
      type: 'START',
    });
    const side = row.whiteEntryId < row.blueEntryId ? 'WHITE' : 'BLUE';
    result = await call(`/tatamis/${row.tatamiId}/live/${row.id}/command`, {
      id: randomUUID(),
      expectedVersion: result.revision,
      type: 'AWARD',
      side,
      kind: 'IPPON',
    });
    const confirmation = { id: randomUUID(), expectedVersion: result.revision, type: 'CONFIRM' };
    await call(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirmation);
    if (completed % 50 === 0)
      await call(`/tatamis/${row.tatamiId}/live/${row.id}/command`, confirmation);
    const saved = await db.contest.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(saved.status, 'CONFIRMED');
    assert.equal(saved.winnerEntryId, side === 'WHITE' ? row.whiteEntryId : row.blueEntryId);
    // Never accelerate any working schema or other tournament. This is a guarded QA fixture.
    await db.contest.update({
      where: { id: row.id },
      data: { endedAt: new Date(Date.now() - 601000) },
    });
    completed++;
    if (completed % 100 === 0) {
      assert.equal(await remainingTotal(), expectedBouts - completed);
      console.log(`MATRIX ${completed} real confirmed bouts`);
    }
  }
  const savedTournament = await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } });
  assert.equal(savedTournament.status, 'FINISHED');
  assert.equal(await remainingTotal(), 0);
  const publicView = await call(`/public/tournaments/${tournament.id}`, undefined, '');
  assert.equal(publicView.tatamis.flatMap((m) => m.queue).length, 0);
  assert.equal(
    publicView.categories.flatMap((c) => c.draw.contests).filter((c) => c.status === 'CONFIRMED')
      .length,
    completed,
  );
  assert.equal(
    completed,
    report.categories.reduce((sum, c) => sum + c.bouts, 0),
  );
  const categories = await db.category.findMany({
    where: { tournamentId: tournament.id },
    include: { entries: true, draw: { include: { contests: true } } },
  });
  for (const category of categories) {
    const result = categoryResults(category);
    assert.ok(result.places);
    const pub = publicView.categories.find((c) => c.id === category.id);
    assert.deepEqual(
      pub.draw.contests.map((c) => c.id).sort(),
      category.draw.contests.map((c) => c.id).sort(),
    );
    for (const bout of pub.draw.contests) {
      const saved = category.draw.contests.find((c) => c.id === bout.id);
      assert.equal(bout.winnerEntryId, saved.winnerEntryId);
      assert.deepEqual(bout.state.awards, saved.state.awards);
    }
    const expected = report.categories.find((c) => c.id === category.id);
    expected.places = result.places;
    expected.confirmed = category.draw.contests.length;
  }
  const teams = teamStandings(categories).teams;
  const totalMedals = teams.reduce((sum, t) => sum + t.gold + t.silver + t.bronze, 0);
  assert.equal(
    totalMedals,
    categories.reduce(
      (sum, c) => sum + categoryResults(c).places.filter((p) => p.place <= 3).length,
      0,
    ),
  );
  for (const lang of ['ru', 'kk'])
    for (const kind of ['DRAW', 'PARTICIPANTS', 'TEAMS']) {
      const history = await call(`/tournaments/${tournament.id}/protocols`);
      const command = {
        id: randomUUID(),
        expectedRevision: history.revision,
        reason: 'QA: полный турнир, сверка итогов и публикации',
        kind,
        lang,
      };
      const artifact = (await call(`/tournaments/${tournament.id}/protocols`, command)).artifact;
      const response = await fixtureRequest(
        base,
        `/tournaments/${tournament.id}/protocols/${artifact.id}.pdf`,
        undefined,
        cookie,
      );
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = pdfText(bytes).replace(/\s+/g, ' ');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
      if (kind === 'PARTICIPANTS')
        for (const category of categories)
          for (const e of category.entries)
            assert.ok(text.includes(e.lastName), `Participant missing in ${lang}: ${e.lastName}`);
      if (kind === 'DRAW')
        for (const category of categories)
          for (const p of categoryResults(category).places.filter((p) => p.place <= 3))
            assert.ok(text.includes(category.entries.find((e) => e.id === p.entryId).lastName));
      const before = (
        await fixtureRequest(
          base,
          `/public/tournaments/${tournament.id}/protocols/${artifact.id}.pdf`,
          undefined,
          '',
        )
      ).status;
      assert.equal(before, 404);
      const current = await call(`/tournaments/${tournament.id}/protocols`);
      await call(`/tournaments/${tournament.id}/protocols/${artifact.id}/command`, {
        id: randomUUID(),
        expectedRevision: current.revision,
        type: 'PUBLISH',
        reason: 'QA: публикация проверенного PDF',
        sha256: artifact.sha256,
      });
      const published = await fixtureRequest(
        base,
        `/public/tournaments/${tournament.id}/protocols/${artifact.id}.pdf`,
        undefined,
        '',
      );
      assert.equal(published.status, 200);
      assert.deepEqual(Buffer.from(await published.arrayBuffer()), bytes);
      const file = `${output}/${kind.toLowerCase()}-${lang}.pdf`;
      await writeFile(file, bytes);
      report.pdfs.push({ kind, lang, file, sha256: artifact.sha256, bytes: bytes.length });
    }
  assert.ok(notices.some((n) => n.kind === 'result'));
  assert.ok(notices.some((n) => n.kind === 'protocol'));
  Object.assign(report, {
    passed: true,
    tournamentId: tournament.id,
    athletes: sizes.reduce((a, b) => a + b, 0),
    completed,
    teams,
    notices: notices.length,
  });
  console.log(
    `PASS full v7 matrix: ${sizes.length} categories, ${completed} actual API bouts, 381 complete engine grids, 6 published PDFs`,
  );
} finally {
  socket?.disconnect();
  await db.$disconnect();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
}
