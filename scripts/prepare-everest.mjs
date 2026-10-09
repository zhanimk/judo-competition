// Additive, resumable setup of the user-approved real tournament. Never seeds athletes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const configPath = new URL('../configs/tournaments/everest-2026.json', import.meta.url);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let session;
async function saveConfig() {
  const temporary = new URL(configPath.href + '.tmp');
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n');
  await rename(temporary, configPath);
}
const categories = config.ageGroups.flatMap((group) =>
  [
    ...group.upperWeightsKg.map((weight) => ({
      name: `${group.label} · −${weight} кг`,
      maxWeightGrams: weight * 1000,
      minWeightGrams: null,
    })),
    {
      name: `${group.label} · +${group.openWeightAboveKg} кг`,
      maxWeightGrams: null,
      minWeightGrams: group.openWeightAboveKg * 1000,
    },
  ].map((weight) => ({
    ...weight,
    gender: group.gender,
    birthYearFrom: group.birthYearFrom,
    birthYearTo: group.birthYearTo,
    durationSeconds: group.durationSeconds,
  })),
);
assert.equal(categories.length, 40);
assert.equal(config.startDate, '2026-10-10');
assert.equal(config.endDate, config.startDate);
assert.equal(config.tatamiCount, 3);
assert.equal(config.publish, false);
assert.equal(config.startCompetition, false);
assert.equal(config.participants.length, 0);
try {
  const admin = await db.user.findFirstOrThrow({
    where: { role: 'SUPER_ADMIN', email: 'admin@judo.local' },
  });
  const token = randomBytes(32).toString('hex');
  session = await db.session.create({
    data: {
      userId: admin.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  async function request(path, data) {
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Judo-Client': 'web',
        Cookie: `judo_session=${token}`,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  const expected = Object.fromEntries(
    ['name', 'city', 'venue', 'startDate', 'endDate', 'tatamiCount'].map((key) => [
      key,
      config[key],
    ]),
  );
  let tournament;
  if (config.tournamentId) {
    tournament = await request(`/tournaments/${config.tournamentId}`);
  } else {
    const matches = await db.tournament.findMany({
      where: { name: config.name, ownerId: admin.id },
    });
    assert.ok(matches.length <= 1, 'Multiple matching tournaments: refuse ambiguous setup');
    tournament = matches[0] ?? (await request('/tournaments', expected));
    config.tournamentId = tournament.id;
    await saveConfig();
  }
  for (const [key, value] of Object.entries(expected)) assert.equal(tournament[key], value, key);
  assert.equal(tournament.status, 'DRAFT', 'Setup only operates on an unstarted draft');
  assert.equal(tournament.publishedAt, null, 'Setup only operates on a private draft');
  assert.equal(tournament.timezone, config.timezone);
  const id = tournament.id;
  const existing = await db.category.findMany({
    where: { tournamentId: id },
    include: { _count: { select: { entries: true } }, draw: true },
  });
  for (const category of existing) {
    assert.ok(
      categories.some((c) => c.name === category.name),
      'Unexpected category: no data changed',
    );
    assert.equal(category._count.entries, 0, 'A populated tournament cannot be prepared again');
    assert.equal(category.draw, null, 'Draw already exists: stop setup');
    for (const [key, value] of Object.entries(categories.find((c) => c.name === category.name))) {
      assert.equal(category[key], value, `${category.name}: ${key}`);
    }
  }
  for (const spec of categories) {
    if (!existing.some((c) => c.name === spec.name))
      await request(`/tournaments/${id}/categories`, spec);
  }
  const saved = await request(`/tournaments/${id}`);
  assert.equal(saved.categories.length, 40);
  assert.deepEqual(saved.tatamis.map((t) => t.number).sort(), [1, 2, 3]);
  assert.equal(
    saved.categories.reduce((sum, c) => sum + c.entries.length, 0),
    0,
  );
  for (const spec of categories) {
    const category = saved.categories.find((c) => c.name === spec.name);
    for (const [key, value] of Object.entries(spec)) assert.equal(category[key], value);
  }
  const action = 'REGULATION_DRAFT_PREPARED';
  if (!(await db.auditEvent.findFirst({ where: { tournamentId: id, action } }))) {
    await db.auditEvent.create({
      data: {
        actorId: admin.id,
        tournamentId: id,
        entityId: id,
        action,
        payload: {
          source: 'configs/tournaments/everest-2026.json',
          categoryCount: 40,
          confirmedByUser: config.confirmedByUser,
          provisionalFormat: 'SINGLE_ELIMINATION',
          note: 'Format is the application default, not specified by the regulation; review after participant counts. Planned time windows and technique restrictions are reference notes, not automated enforcement.',
        },
      },
    });
  }
  config.status = 'DRAFT_CREATED';
  config.pending = config.pending.filter((note) => !note.startsWith('Represent open weight'));
  await saveConfig();
  const report = {
    tournamentId: id,
    name: saved.name,
    date: saved.startDate,
    status: saved.status,
    publishedAt: saved.publishedAt,
    ageGroupCount: 5,
    categoryCount: saved.categories.length,
    openWeightCategoryCount: saved.categories.filter((c) => c.maxWeightGrams === null).length,
    participantCount: 0,
    tatamiCount: saved.tatamis.length,
    provisionalFormat: 'SINGLE_ELIMINATION',
    formatReviewRequired: true,
    url: `http://127.0.0.1:4318/tournaments/${id}`,
    categories: saved.categories.map(
      ({
        id,
        name,
        birthYearFrom,
        birthYearTo,
        maxWeightGrams,
        minWeightGrams,
        durationSeconds,
      }) => ({
        id,
        name,
        birthYearFrom,
        birthYearTo,
        maxWeightGrams,
        minWeightGrams,
        durationSeconds,
      }),
    ),
  };
  await mkdir('docs/reports', { recursive: true });
  await writeFile('docs/reports/everest-2026.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, categories: undefined }, null, 2));
} finally {
  if (session) await db.session.deleteMany({ where: { id: session.id } });
  await db.$disconnect();
}
