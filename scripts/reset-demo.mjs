// Explicit destructive maintenance command. No automatic startup reset; preserves every user account.
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { demoCategories } from '../fixtures/demo-tournament.mjs';
if (!process.argv.includes('--reset-all-tournaments'))
  throw new Error('Requires --reset-all-tournaments; deletes all tournament data after backup.');
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
let session;
try {
  // Verify server first, before destructive work.
  const health = await fetch(base + '/public/tournaments');
  if (!health.ok) throw new Error('API unavailable');
  const admin = await db.user.findFirstOrThrow({
    where: { role: 'SUPER_ADMIN', email: 'admin@judo.local' },
  });
  await mkdir('tmp/backups', { recursive: true });
  const backup = `tmp/backups/tournaments-reset-${new Date().toISOString().replaceAll(':', '-')}.json`;
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" ORDER BY id FOR UPDATE`;
      const data = {};
      for (const key of [
        'tournament',
        'category',
        'entry',
        'tatami',
        'drawRecord',
        'contest',
        'matchEvent',
        'auditEvent',
      ])
        data[key] = await tx[key].findMany();
      await writeFile(backup, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
      await tx.session.deleteMany({ where: { tatamiId: { not: null } } });
      await tx.contest.deleteMany();
      await tx.drawRecord.deleteMany();
      await tx.auditEvent.deleteMany({
        where: { tournamentId: { in: data.tournament.map((t) => t.id) } },
      });
      await tx.entry.deleteMany();
      await tx.category.deleteMany();
      await tx.tatami.deleteMany();
      await tx.tournament.deleteMany();
    },
    { timeout: 20000 },
  );
  const token = randomBytes(32).toString('hex');
  session = await db.session.create({
    data: {
      userId: admin.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  async function post(path, data = {}) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Judo-Client': 'web',
        Cookie: `judo_session=${token}`,
      },
      body: JSON.stringify(data),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const t = await post('/tournaments', {
    name: 'ДЕМО · Judo Cup · 150 қатысушы',
    city: 'Алматы',
    venue: 'Тестовая арена · Сынақ алаңы',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    tatamiCount: 4,
  });
  const report = {
    tournamentId: t.id,
    backup,
    status: 'DRAFT',
    participantCount: 150,
    categories: [],
  };
  let number = 0;
  for (const [i, spec] of demoCategories.entries()) {
    const from = i < 4 ? 2016 : i < 7 || i === 8 ? 2014 : 2012;
    const c = await post(`/tournaments/${t.id}/categories`, {
      name: spec.label,
      gender: i % 2 ? 'FEMALE' : 'MALE',
      birthYearFrom: from,
      birthYearTo: from + 1,
      maxWeightGrams: Number(spec.label.match(/−(\d+)/)[1]) * 1000,
      durationSeconds: i < 4 ? 120 : 180,
      format: spec.format,
    });
    for (let j = 0; j < spec.count; j++) {
      number++;
      await post(`/tournaments/${t.id}/categories/${c.id}/entries`, {
        firstName: (i % 2
          ? ['Айша', 'Әсел', 'Аружан', 'Інжу']
          : ['Әлихан', 'Ерлан', 'Данияр', 'Нұрсұлтан'])[j % 4],
        lastName: `ДЕМО-${String(number).padStart(3, '0')}`,
        birthYear: from + (j % 2),
        club: `Клуб ${spec.allSameClub ? 1 : (j % 8) + 1}`,
      });
    }
    const preview = await post(`/categories/${c.id}/draw/preview`);
    const draw = await post(`/categories/${c.id}/draw/confirm`, { version: preview.version });
    await post(`/categories/${c.id}/draw/publication`, { published: true, expectedRevision: 0 });
    report.categories.push({
      id: c.id,
      name: c.name,
      count: spec.count,
      format: spec.format,
      matches: draw.contests.length,
    });
  }
  await post(`/tournaments/${t.id}/publish`);
  // Prepared, not running: the administrator reviews draws and presses Start tournament.
  report.tatamis = await db.tatami.findMany({
    where: { tournamentId: t.id },
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
  });
  await mkdir('docs/reports', { recursive: true });
  await writeFile('docs/reports/current-demo.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (session) await db.session.deleteMany({ where: { id: session.id } });
  await db.$disconnect();
}
