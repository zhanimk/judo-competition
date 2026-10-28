import { ProtocolPdf, ink } from './pdf-document.js';
import { scoreboardScores, type MatchState } from '@judo/engine/match';
import type { BoutCard } from './pdf-bout-card.js';
/** Print bracket: names and clubs take priority over detailed scoreboard statistics. */
export function paintDrawCard(
  pdf: ProtocolPdf,
  bout: BoutCard,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const d = pdf.doc;
  d.font('Bold')
    .fontSize(8)
    .fillColor(ink.muted)
    .text(pdf.safe(bout.label), x, y - 13, { width, height: 11, ellipsis: true });
  d.roundedRect(x, y, width, height, 4).fillAndStroke('#ffffff', '#acbacb');
  for (const [i, label] of [bout.white, bout.blue].entries()) {
    const sy = y + (i * height) / 2;
    const won =
      bout.record?.status === 'CONFIRMED' &&
      !!bout.record.winnerEntryId &&
      bout.record.winnerEntryId === (i === 0 ? bout.record.whiteEntryId : bout.record.blueEntryId);
    d.rect(x + 1, sy + 1, width - 2, height / 2 - 1).fill(
      won ? ink.goldLight : i ? ink.blueLight : '#ffffff',
    );
    d.rect(x + 1, sy + 1, 3, height / 2 - 1).fill(i ? ink.blue : '#adbac9');
    const [name, ...club] = pdf.safe(label).split('\n');
    const textWidth = width - 18;
    const half = height / 2;
    const state =
      bout.record?.status === 'CONFIRMED' && bout.record.state
        ? (bout.record.state as unknown as MatchState)
        : null;
    const score = state ? scoreboardScores(state, i === 0 ? 'WHITE' : 'BLUE') : null;
    const clubText = label === 'BYE' ? pdf.text('Без схватки', 'Белдесусіз') : club.join(' ');
    const clubHeight = 18;
    const nameHeight = half - clubHeight - 17;
    let size = 10;
    d.font('Bold').fontSize(size);
    while (size > 7 && d.heightOfString(name, { width: textWidth }) > nameHeight) {
      size -= 0.5;
      d.fontSize(size);
    }
    d.fillColor(ink.navy).text(name, x + 9, sy + 3, {
      width: textWidth,
      height: nameHeight,
    });
    d.font('Regular')
      .fontSize(7)
      .fillColor(ink.muted)
      .text(clubText, x + 9, sy + half - clubHeight - 12, {
        width: textWidth,
        height: clubHeight,
      });
    if (score)
      d.font('Bold')
        .fontSize(7)
        .fillColor(ink.navy)
        .text(
          `I ${score.IPPON}   W ${score.WAZA_ARI}   Y ${score.YUKO}   S ${score.SHIDO}`,
          x + 9,
          sy + half - 11,
          { width: textWidth, height: 10 },
        );
  }
  d.strokeColor('#acbacb')
    .lineWidth(0.5)
    .moveTo(x + 4, y + height / 2)
    .lineTo(x + width - 4, y + height / 2)
    .stroke();
}
