import type { MatchState } from '@judo/engine/match';
import { categoryResults, slotName, type ProtocolCategory } from './protocol-model.js';
import { ProtocolPdf, ink } from './pdf-document.js';
import { paintBoutCard, scoreLegend } from './pdf-bout-card.js';
export function renderBouts(pdf: ProtocolPdf, c: ProtocolCategory) {
  const data = categoryResults(c),
    text = pdf.text;
  if (!data) {
    pdf.notice(text('Схватки ещё не сформированы.', 'Белдесулер әлі құрылмаған.'));
    return;
  }
  const name = slotName(c, text),
    duration = (ms: number) =>
      `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const records = new Map(c.draw!.contests.map((m) => [m.key, m]));
  const completed = c.draw!.contests.filter((m) => m.status === 'CONFIRMED').length;
  pdf.metrics([
    { label: text('Всего схваток', 'Барлық белдесулер'), value: data.draw.matches.length },
    { label: text('Подтверждено', 'Расталған'), value: completed },
    { label: text('Осталось', 'Қалды'), value: data.draw.matches.length - completed },
  ]);
  scoreLegend(pdf);
  const reasons: Record<string, [string, string]> = {
    IPPON: ['Иппон', 'Иппон'],
    COMBINATION: ['Два Waza-ari', 'Екі Waza-ari'],
    TIME: ['По оценкам', 'Бағалар бойынша'],
    ACCUMULATED_SHIDO: ['Три Shido', 'Үш Shido'],
    GOLDEN_SCORE: ['Golden Score', 'Golden Score'],
  };
  for (let i = 0; i < data.draw.matches.length; i += 2) {
    pdf.ensure(151);
    const y = pdf.doc.y + 14,
      w = (pdf.width - 20) / 2;
    data.draw.matches.slice(i, i + 2).forEach((m, j) => {
      const record = records.get(m.id),
        confirmed = record?.status === 'CONFIRMED',
        state = confirmed && record?.state ? (record.state as unknown as MatchState) : null;
      const stage =
        m.stage === 'BRONZE'
          ? text('Бронза', 'Қола')
          : m.stage === 'REPECHAGE'
            ? text('Утешение', 'Жұбаныш')
            : m.pool
              ? text('Группа ', 'Топ ') + m.pool
              : text('Тур ', 'Айналым ') + m.round;
      const x = 36 + j * (w + 20);
      paintBoutCard(
        pdf,
        {
          label: `№ ${i + j + 1} · ${stage} · ${confirmed ? text('ЗАВЕРШЕНА', 'АЯҚТАЛҒАН') : text('ОЖИДАЕТ', 'КҮТІЛУДЕ')}`,
          white: name(m.white),
          blue: name(m.blue),
          record,
        },
        x,
        y,
        w,
        100,
      );
      const reason = record?.resultReason
        ? reasons[record.resultReason]
          ? text(...reasons[record.resultReason])
          : record.resultReason
        : '';
      pdf.doc
        .font('Bold')
        .fontSize(8)
        .fillColor(ink.navy)
        .text(
          confirmed
            ? `${reason} · ${text('Время', 'Уақыт')} ${state ? duration(state.elapsedMs) : '—'}${state?.goldenMs ? ` + GS ${duration(state.goldenMs)}` : ''}`
            : text('Результат не подтверждён', 'Нәтиже расталмаған'),
          x + 10,
          y + 107,
          { width: w - 20, height: 20 },
        );
    });
    pdf.doc.y = y + 137;
  }
}
