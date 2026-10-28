import { generateDraw, resolveMatches } from '@judo/engine/draw';
import { applyCommand, createMatch } from '@judo/engine/match';

/** Synthetic print fixture, never written to a tournament database. */
export function portraitCategory(count, finished = true) {
  const entries = Array.from({ length: count }, (_, i) => ({
    id: `print-entry-${i}`,
    firstName: `Әлихан${i + 1}`,
    lastName: `ТестовыйСпортсмен${i + 1}`,
    club: `Тестовый клуб ${(i % 5) + 1}`,
    birthYear: 2012,
  }));
  const snapshot = generateDraw(
    'REPECHAGE',
    entries.map((e) => ({ id: e.id, clubId: e.club })),
    17,
    'TWO_FORMATS',
  );
  const winners = {};
  const contests = [];
  for (const match of snapshot.matches) {
    const resolved = resolveMatches(snapshot, winners).find((m) => m.id === match.id);
    let state = null;
    if (finished) {
      winners[match.id] = resolved.whiteEntryId;
      state = createMatch({
        durationMs: 180000,
        shidoLimit: 3,
        wazaForIppon: 2,
        enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
        holdThresholds: [{ ms: 20000, score: 'IPPON' }],
      });
      for (const command of [
        { type: 'START' },
        { type: 'AWARD', side: 'WHITE', kind: 'IPPON' },
        { type: 'CONFIRM' },
      ])
        state = applyCommand(state, {
          ...command,
          id: `${match.id}-${state.version}`,
          expectedVersion: state.version,
        });
    }
    contests.push({
      key: match.id,
      status: finished ? 'CONFIRMED' : 'READY',
      whiteEntryId: resolved.whiteEntryId,
      blueEntryId: resolved.blueEntryId,
      winnerEntryId: finished ? resolved.whiteEntryId : null,
      resultReason: finished ? 'IPPON' : null,
      state,
    });
  }
  return {
    id: `print-${count}`,
    name: `Тестовая категория - ${count} участников`,
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    minWeightGrams: null,
    durationSeconds: 180,
    format: count <= 5 ? 'ROUND_ROBIN' : 'REPECHAGE',
    entries,
    draw: { snapshot, contests, version: 1, status: 'CONFIRMED', publishedAt: null },
  };
}
export function portraitTournament(categories) {
  return {
    name: 'ПРОВЕРКА ПЕЧАТИ - вымышленные участники',
    city: 'Алматы',
    venue: 'Тестовые данные',
    timezone: 'Asia/Almaty',
    startDate: '2026-10-28',
    endDate: '2026-10-28',
    categories,
  };
}
