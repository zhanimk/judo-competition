import { drawProgress, poolStandings } from '@judo/engine/draw';
import { categoryResults, type ProtocolCategory } from './protocol-model.js';
import { ProtocolPdf } from './pdf-document.js';

/** Same numbering, wins-only policy and opponent cells as RoundStandings on the website. */
export function paintRoundMatrix(pdf: ProtocolPdf, c: ProtocolCategory, poolId?: string) {
  const data = categoryResults(c);
  if (!data) return;
  const { draw, winners, places } = data;
  const t = pdf.text;
  const members = poolId
    ? (draw.pools?.find((p) => p.id === poolId)?.entries ?? [])
    : draw.positions.flatMap((e) => (e ? [e.id] : []));
  const matches = draw.matches.filter((m) => !poolId || m.pool === poolId);
  const confirmed = c.draw!.contests.filter(
    (row) => row.status === 'CONFIRMED' && matches.some((m) => m.id === row.key),
  );
  const final = poolStandings(draw, winners, poolId);
  const pending = drawProgress(draw, winners).pendingReviews.some((r) => r.pool === poolId);
  pdf.line(
    final
      ? t('Итоговые места', 'Қорытынды орындар')
      : pending
        ? t('Равенство: ожидается решение администратора', 'Теңдік: әкімшінің шешімі күтілуде')
        : t(
            'Места ещё не определены · порядок по жребию',
            'Орындар әлі анықталмаған · жеребе ретімен',
          ),
  );
  const matrix = members.length <= 8;
  const order = final?.map((r) => r.entryId) ?? members;
  pdf.table(
    [
      '№',
      t('Место', 'Орын'),
      t('Участник / клуб', 'Қатысушы / клуб'),
      ...(matrix ? members.map((_, i) => String(i + 1)) : []),
      t('Схватки', 'Белдесулер'),
      t('Победы', 'Жеңістер'),
      t('Поражения', 'Жеңілістер'),
    ],
    order.map((id, index) => {
      const entry = c.entries.find((e) => e.id === id);
      const played = confirmed.filter((r) => r.whiteEntryId === id || r.blueEntryId === id);
      const wins = played.filter((r) => r.winnerEntryId === id);
      const additional = wins.filter((r) => matches.find((m) => m.id === r.key)?.tieBreakRound);
      const total = matches.filter(
        (m) =>
          ('entryId' in m.white && m.white.entryId === id) ||
          ('entryId' in m.blue && m.blue.entryId === id),
      ).length;
      const withdrawn = draw.withdrawnEntryIds?.includes(id);
      return [
        String(members.indexOf(id) + 1),
        final && !withdrawn
          ? String(places?.find((p) => p.entryId === id)?.place ?? index + 1)
          : '—',
        `${entry?.lastName ?? ''} ${entry?.firstName ?? ''}\n${entry?.club ?? ''}${withdrawn ? '\n' + t('Удалён', 'Шығарылған') : ''}`,
        ...(matrix
          ? members.map((opponent) => {
              if (opponent === id) return '×';
              const pair = matches.find(
                (m) =>
                  !m.tieBreakRound &&
                  'entryId' in m.white &&
                  'entryId' in m.blue &&
                  ((m.white.entryId === id && m.blue.entryId === opponent) ||
                    (m.blue.entryId === id && m.white.entryId === opponent)),
              );
              const result = confirmed.find((r) => r.key === pair?.id);
              return result?.winnerEntryId ? (result.winnerEntryId === id ? '1' : '0') : '—';
            })
          : []),
        `${played.length} / ${total}`,
        String(draw.tieRanking === 'WINS_ONLY' ? wins.length - additional.length : wins.length) +
          (draw.tieRanking === 'WINS_ONLY' && additional.length
            ? `\n+${additional.length} ${t('доп.', 'қос.')}`
            : ''),
        String(played.length - wins.length),
      ];
    }),
    [
      0.045,
      0.065,
      matrix ? 0.41 - members.length * 0.035 : 0.41,
      ...(matrix ? members.map(() => 0.035) : []),
      0.16,
      0.16,
      0.16,
    ],
    { horizontalPadding: 4, strongColumn: 2 },
  );
  if (matrix)
    pdf.line(
      t(
        '1 — победа · 0 — поражение · × — сам участник',
        '1 — жеңіс · 0 — жеңіліс · × — қатысушының өзі',
      ),
    );
}
