import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { fixtureRequest } from './test-access.mjs';
import { placements } from '@judo/engine/draw';

// Only the explicitly requested disposable native QA matrix may be completed.
const file = resolve(process.argv[2] ?? '');
assert.ok(file.includes('/tmp/native-production-qa/qa_ui_') && file.endsWith('/processes.json'));
const manifest = JSON.parse(await readFile(file)),
  credentials = JSON.parse(await readFile(join(dirname(file), 'credentials.json'))),
  connection = new URL(process.env.DATABASE_URL);
assert.match(manifest.schema, /^qa_ui_[a-f0-9]{32}$/);
assert.equal(credentials.synthetic, true);
assert.equal(credentials.smallDrawMatrix, true);
assert.equal(credentials.tournamentId, manifest.tournamentId);
connection.searchParams.set('schema', manifest.schema);
const db = new PrismaClient({ datasources: { db: { url: connection.href } } });
let cookie = '';
async function call(path, data, auth = cookie) {
  const response = await fixtureRequest(manifest.base, path, data, auth);
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
try {
  const [{ schema }] = await db.$queryRaw`SELECT current_schema()::text AS schema`;
  assert.equal(schema, manifest.schema);
  const login = await fixtureRequest(manifest.base, '/auth/login', {
    email: credentials.email,
    password: credentials.password,
  });
  assert.equal(login.status, 201);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const tournamentId = manifest.tournamentId;
  const before = await call(`/tournaments/${tournamentId}`);
  assert.equal(before.categories.length, 9);
  assert.deepEqual(
    before.categories.map((c) => c.entries.length),
    [2, 3, 4, 5, 6, 7, 8, 8, 8],
  );
  const initial = await call(`/public/tournaments/${tournamentId}`, undefined, '');
  for (const category of initial.categories) {
    const n = category.entries.length,
      draw = category.draw.snapshot;
    if (n < 8 || category.format === 'ROUND_ROBIN') {
      assert.equal(draw.algorithm, 'custom-round-robin-v1');
      assert.equal(draw.matches.length, (n * (n - 1)) / 2);
      assert.equal(
        new Set(draw.matches.map((m) => [m.white.entryId, m.blue.entryId].sort().join('|'))).size,
        draw.matches.length,
      );
      for (const round of new Set(draw.matches.map((m) => m.round))) {
        const rows = draw.matches.filter((m) => m.round === round);
        const ids = rows.flatMap((m) => [m.white.entryId, m.blue.entryId]);
        assert.equal(ids.length, new Set(ids).size);
        assert.equal(n - ids.length, n % 2);
      }
    } else assert.equal(draw.matches.filter((m) => m.stage === 'BRONZE').length, 2);
  }
  const mats = await call(`/tournaments/${tournamentId}/tatamis`);
  let bouts = 0;
  for (;;) {
    const queues = await Promise.all(
      mats.map((m) => call(`/tournaments/${tournamentId}/tatamis/${m.id}`)),
    );
    const ready = queues.map((m) => m.queue[0]).find((m) => m && !m.blockedByRound);
    if (!ready) break;
    // Deliberately accelerate rest only in this validated, random QA schema.
    await db.contest.updateMany({
      where: { draw: { category: { tournamentId } }, status: 'CONFIRMED' },
      data: { endedAt: new Date(0) },
    });
    const row = await db.contest.findUniqueOrThrow({ where: { id: ready.id } });
    const side = row.whiteEntryId < row.blueEntryId ? 'WHITE' : 'BLUE';
    let revision = row.revision;
    for (const [type, extra] of [
      ['START', {}],
      ['AWARD', { side, kind: 'IPPON' }],
      ['CONFIRM', {}],
    ]) {
      const result = await call(`/tatamis/${row.tatamiId}/live/${row.id}/command`, {
        id: randomUUID(),
        expectedVersion: revision,
        type,
        ...extra,
      });
      revision = result.revision;
    }
    assert.ok(++bouts <= 110);
  }
  assert.equal(bouts, 110);
  assert.equal((await call(`/tournaments/${tournamentId}`)).status, 'FINISHED');
  const completed = await call(`/public/tournaments/${tournamentId}`, undefined, '');
  const categories = completed.categories.map((c) => {
    assert.ok(c.draw.contests.every((m) => m.status === 'CONFIRMED'));
    const winners = Object.fromEntries(c.draw.contests.map((m) => [m.key, m.winnerEntryId]));
    const places = placements(c.draw.snapshot, winners);
    assert.ok(places);
    const sorted = c.entries.map((e) => e.id).sort();
    if (c.draw.snapshot.algorithm === 'custom-round-robin-v1')
      assert.deepEqual(
        places.map((p) => p.entryId),
        sorted,
      );
    else {
      assert.equal(places[0].entryId, sorted[0]);
      assert.deepEqual(
        places.map((p) => p.place),
        [1, 2, 3, 3],
      );
    }
    return {
      id: c.id,
      name: c.name,
      count: c.entries.length,
      algorithm: c.draw.snapshot.algorithm,
      matches: c.draw.contests.length,
      places: places.map((p) => ({
        ...p,
        name: c.entries.find((e) => e.id === p.entryId).lastName,
      })),
    };
  });
  await writeFile(
    join(manifest.output, 'small-draw-results.json'),
    JSON.stringify({ passed: true, bouts, categories }, null, 2) + '\n',
  );
  console.log(
    'PASS small draw matrix: 110 HTTP bouts, 2–8 entrants, all three formats at eight, public results/places and FINISHED',
  );
} finally {
  await db.$disconnect();
}
