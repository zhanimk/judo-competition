// Fictitious print sample. Does not read or mutate the competition database.
import { mkdir, writeFile } from 'node:fs/promises';
import { generateDraw, resolveMatches } from '@judo/engine/draw';
import { createMatch } from '@judo/engine/match';
import { renderProtocol } from '../apps/api/dist/modules/protocols/render-protocol.js';
const names = [
  ['Серікұлы', 'Әлихан'],
  ['Болатов', 'Ерлан'],
  ['Нұрланов', 'Мирас'],
  ['Кенжебеков', 'Бауыржан'],
  ['Оразов', 'Серік'],
  ['Жүнісов', 'Асылбек'],
  ['Тілеулі', 'Тимур'],
  ['Сейітов', 'Бекзат'],
];
const entries = names.map(([lastName, firstName], i) => ({
  id: `sample-${i + 1}`,
  categoryId: 'sample-category',
  firstName,
  lastName,
  club: ['Алматы Judo', 'Астана Judo', 'Жас Батыр', 'Барыс'][i % 4],
  birthYear: 2013,
  createdAt: new Date('2026-10-08T10:00:00Z'),
}));
const draw = generateDraw(
  'REPECHAGE',
  entries.map((e) => ({ id: e.id, clubId: e.club })),
  21,
);
const winners = {},
  contests = [];
for (const [i, m] of draw.matches.entries()) {
  const resolved = resolveMatches(draw, winners).find((r) => r.id === m.id),
    side = i % 3 === 0 ? 'BLUE' : 'WHITE';
  const state = createMatch({
    durationMs: 180000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['IPPON', 'WAZA_ARI', 'YUKO'],
    holdThresholds: [
      { ms: 10000, score: 'WAZA_ARI' },
      { ms: 20000, score: 'IPPON' },
    ],
  });
  state.status = 'CONFIRMED';
  state.elapsedMs = 47000 + i * 8000;
  state.awards = [{ id: `score-${i}`, side, kind: 'IPPON', active: true }];
  if (i % 2)
    state.awards.push({
      id: `yuko-${i}`,
      side: side === 'WHITE' ? 'BLUE' : 'WHITE',
      kind: 'YUKO',
      active: true,
    });
  if (i % 3) state.awards.push({ id: `shido-${i}`, side: 'BLUE', kind: 'SHIDO', active: true });
  state.outcome = { winner: side, reason: 'IPPON' };
  const winnerEntryId = side === 'WHITE' ? resolved.whiteEntryId : resolved.blueEntryId;
  winners[m.id] = winnerEntryId;
  contests.push({
    id: `bout-${i}`,
    drawId: 'sample-draw',
    key: m.id,
    round: m.round,
    whiteEntryId: resolved.whiteEntryId,
    blueEntryId: resolved.blueEntryId,
    winnerEntryId,
    status: 'CONFIRMED',
    state,
    resultReason: 'IPPON',
    confirmedAt: new Date('2026-10-08T10:00:00Z'),
  });
}
const category = {
  id: 'sample-category',
  name: 'Юноши U15 · -50 кг',
  gender: 'MALE',
  birthYearFrom: 2012,
  birthYearTo: 2013,
  maxWeightGrams: 50000,
  durationSeconds: 180,
  format: 'REPECHAGE',
  entries,
  draw: {
    version: 1,
    status: 'CONFIRMED',
    publishedAt: new Date('2026-10-08T10:00:00Z'),
    snapshot: draw,
    contests,
  },
};
const tournament = {
  id: 'sample-tournament',
  name: 'ОБРАЗЕЦ · Кубок Judo Child League',
  city: 'Алматы',
  venue: 'Учебный пример · данные вымышлены',
  startDate: '2026-10-10',
  endDate: '2026-10-10',
  timezone: 'Asia/Almaty',
  categories: [category],
};
await mkdir('output/pdf', { recursive: true });
for (const [kind, name] of [
  ['DRAW', 'jcl-draw-preview'],
  ['PARTICIPANTS', 'jcl-participants-preview'],
]) {
  await writeFile(`output/pdf/${name}.pdf`, await renderProtocol(tournament, kind, 'kk'));
}
console.log(
  'Samples: output/pdf/jcl-draw-preview.pdf, output/pdf/jcl-participants-preview.pdf (fictitious data; no database writes)',
);
