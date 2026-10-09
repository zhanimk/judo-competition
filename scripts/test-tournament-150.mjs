// Read-only verification of the single current demo. Never creates a second tournament.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { demoCategories } from '../fixtures/demo-tournament.mjs';
const db = new PrismaClient();
try {
  const report = JSON.parse(await readFile('docs/reports/current-demo.json', 'utf8'));
  const t = await db.tournament.findUniqueOrThrow({
    where: { id: report.tournamentId },
    include: {
      tatamis: true,
      categories: {
        orderBy: { name: 'asc' },
        include: { entries: true, draw: { include: { contests: true } } },
      },
    },
  });
  assert.equal(t.categories.length, 12);
  assert.equal(t.tatamis.length, 4);
  const entries = t.categories.flatMap((c) => c.entries);
  assert.equal(entries.length, 150);
  assert.equal(new Set(entries.map((e) => e.id)).size, 150);
  for (const [i, c] of t.categories.entries()) {
    assert.equal(c.format, demoCategories[i].format);
    assert.equal(c.entries.length, demoCategories[i].count);
    assert.equal(c.draw.status, 'CONFIRMED');
    assert.equal(c.draw.contests.length, report.categories[i].matches);
  }
  assert.equal(new Set(t.categories.map((c) => c.format)).size, 4);
  console.log(
    'PASS: single current demo, 150 distinct synthetic athletes, 12 categories, four implemented formats, four tatamis, confirmed draws. No data modified.',
  );
} finally {
  await db.$disconnect();
}
