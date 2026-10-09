import { scoreboardScores, type MatchState } from '@judo/engine/match';
import type { Contest } from '@prisma/client';
import { ProtocolPdf, ink } from './pdf-document.js';
export type BoutCard = { label: string; white: string; blue: string; record?: Contest };
/** Per-side scores retain their meaning: I/W/Y/S, never an invented combined judo score. */
export function paintBoutCard(
  pdf: ProtocolPdf,
  bout: BoutCard,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const d = pdf.doc,
    record = bout.record,
    confirmed = record?.status === 'CONFIRMED';
  const state = confirmed && record.state ? (record.state as unknown as MatchState) : null;
  d.font('Bold')
    .fontSize(7)
    .fillColor(ink.muted)
    .text(pdf.safe(bout.label), x, y - 12, { width, height: 10, ellipsis: true });
  d.roundedRect(x, y, width, height, 5).fillAndStroke('#ffffff', ink.line);
  const half = height / 2;
  for (const [i, label] of [bout.white, bout.blue].entries()) {
    const sy = y + i * half,
      side = i === 0 ? 'WHITE' : 'BLUE',
      won =
        confirmed &&
        !!record.winnerEntryId &&
        record.winnerEntryId === (i === 0 ? record.whiteEntryId : record.blueEntryId);
    d.rect(x + 1, sy + 1, width - 2, half - 1).fill(
      won ? ink.goldLight : i === 1 ? ink.blueLight : '#ffffff',
    );
    d.rect(x + 1, sy + 1, 3, half - 1).fill(i === 0 ? '#b9c4d1' : ink.blue);
    const [name, ...club] = pdf.safe(label).split('\n');
    d.font('Bold')
      .fontSize(width < 220 ? 8.5 : 10)
      .fillColor(ink.navy)
      .text(name, x + 10, sy + 3, { width: width - 20, height: 13, ellipsis: true });
    d.font('Regular')
      .fontSize(7.5)
      .fillColor(ink.muted)
      .text(club.join(' '), x + 10, sy + 15, {
        width: width - (won ? 65 : 20),
        height: 8,
        ellipsis: true,
      });
    if (won)
      d.font('Bold')
        .fontSize(6.6)
        .fillColor('#805709')
        .text(pdf.text('ПОБЕДА', 'ЖЕҢІС'), x + width - 55, sy + 15, { width: 45, align: 'right' });
    if (state) {
      const score = scoreboardScores(state, side);
      const values = [
        ['I', score.IPPON],
        ['W', score.WAZA_ARI],
        ['Y', score.YUKO],
        ['S', score.SHIDO],
      ];
      const chipW = Math.min(width > 260 ? 72 : 42, (width - 26) / 4);
      values.forEach(([key, value], j) => {
        const cx = x + 10 + j * (chipW + 2),
          cy = sy + half - (width > 260 ? 16 : 11);
        d.roundedRect(cx, cy, chipW, width > 260 ? 14 : 10, 2).fill(
          Number(value) > 0 ? (key === 'S' ? '#b63838' : ink.navy) : '#e8edf3',
        );
        d.font('Bold')
          .fontSize(width > 260 ? 8 : 7)
          .fillColor(Number(value) > 0 ? '#ffffff' : ink.muted)
          .text(
            `${width > 260 ? ({ I: 'IPPON', W: 'WAZA-ARI', Y: 'YUKO', S: 'SHIDO' } as Record<string, string>)[key] : key}  ${value}`,
            cx,
            cy + 0.2,
            { width: chipW, align: 'center', height: 10 },
          );
      });
    } else
      d.font('Regular')
        .fontSize(6.8)
        .fillColor(ink.muted)
        .text(
          label === 'BYE'
            ? pdf.text('Без схватки', 'Белдесусіз')
            : pdf.text('Оценки после подтверждения', 'Бағалар расталғаннан кейін'),
          x + 10,
          sy + half - 11,
          { width: width - 20, height: 10 },
        );
  }
  d.strokeColor(ink.line)
    .lineWidth(0.5)
    .moveTo(x + 4, y + half)
    .lineTo(x + width - 4, y + half)
    .stroke();
}
export function scoreLegend(pdf: ProtocolPdf) {
  pdf.line(
    pdf.text(
      'Оценки: I - IPPON · W - WAZA-ARI · Y - YUKO · S - SHIDO. Верхняя строка - белый, нижняя - синий.',
      'Бағалар: I - IPPON · W - WAZA-ARI · Y - YUKO · S - SHIDO. Жоғарғы жол - ақ, төменгі жол - көк.',
    ),
    8,
    ink.muted,
  );
}
