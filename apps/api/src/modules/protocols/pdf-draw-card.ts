import { ProtocolPdf, ink } from './pdf-document.js';
import { scoreboardScores, type MatchState } from '@judo/engine/match';
import type { BoutCard } from './pdf-bout-card.js';

/** Website-style white/blue competitors, match header and explicit result footer. */
export function paintDrawCard(
  pdf: ProtocolPdf,
  bout: BoutCard,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const d = pdf.doc;
  const header = 15,
    footer = 17,
    half = (height - header - footer) / 2;
  const record = bout.record;
  const winnerSide =
    record?.status === 'CONFIRMED' && record.winnerEntryId
      ? record.winnerEntryId === record.whiteEntryId
        ? 0
        : 1
      : null;
  d.roundedRect(x, y, width, height, 5).fillAndStroke('#ffffff', '#bdcbe0');
  d.roundedRect(x + 1, y + 1, width - 2, header, 4).fill(ink.pale);
  d.font('Bold')
    .fontSize(7)
    .fillColor(ink.muted)
    .text(pdf.safe(bout.label), x + 6, y + 3, { width: width - 12, height: 10, ellipsis: true });
  for (const [i, label] of [bout.white, bout.blue].entries()) {
    const sy = y + header + i * half;
    const [name, ...club] = pdf.safe(label).split('\n');
    const state =
      record?.status === 'CONFIRMED' && record.state
        ? (record.state as unknown as MatchState)
        : null;
    const score = state ? scoreboardScores(state, i === 0 ? 'WHITE' : 'BLUE') : null;
    d.rect(x + 1, sy, width - 2, half).fill(i ? '#f5f8ff' : '#ffffff');
    d.roundedRect(x + 5, sy + 5, 11, 15, 2).fillAndStroke(i ? ink.blue : '#ffffff', '#b1c0d5');
    d.font('Bold')
      .fontSize(7)
      .fillColor(i ? '#ffffff' : ink.muted)
      .text(pdf.text(i ? 'С' : 'Б', i ? 'К' : 'А'), x + 5, sy + 8, {
        width: 11,
        height: 10,
        align: 'center',
      });
    const tw = width - 28,
      nameHeight = half - 22;
    let size = 9;
    d.font('Bold').fontSize(size);
    while (size > 6.5 && d.heightOfString(name, { width: tw }) > nameHeight)
      d.fontSize((size -= 0.5));
    d.fillColor(ink.navy).text(name, x + 21, sy + 3, { width: tw, height: nameHeight });
    d.font('Regular')
      .fontSize(6.5)
      .fillColor(ink.muted)
      .text(
        label === 'BYE' ? pdf.text('Без соперника', 'Қарсылассыз') : club.join(' '),
        x + 21,
        sy + half - 21,
        { width: tw, height: 10 },
      );
    if (score)
      d.font('Bold')
        .fontSize(6.5)
        .fillColor(ink.navy)
        .text(
          `I ${score.IPPON}   W ${score.WAZA_ARI}   Y ${score.YUKO}   S ${score.SHIDO}`,
          x + 21,
          sy + half - 10,
          { width: tw, height: 9 },
        );
    d.strokeColor('#d6e0ee')
      .lineWidth(0.5)
      .moveTo(x + 1, sy + half)
      .lineTo(x + width - 1, sy + half)
      .stroke();
  }
  const result =
    winnerSide !== null
      ? pdf.text('Победитель', 'Жеңімпаз') +
        ': ' +
        [bout.white, bout.blue][winnerSide].split('\n')[0]
      : bout.label === 'BYE'
        ? pdf.text('Проход без схватки', 'Белдесусіз өту')
        : record?.status === 'CONFIRMED'
          ? pdf.text('Без победителя', 'Жеңімпаз жоқ')
          : pdf.text('Ожидает', 'Күтілуде');
  d.rect(x + 1, y + height - footer, width - 2, footer - 1).fill(
    winnerSide !== null ? '#edf6ef' : '#ffffff',
  );
  d.font('Bold')
    .fontSize(5.5)
    .fillColor(winnerSide !== null ? '#356343' : ink.muted)
    .text(pdf.safe(result), x + 5, y + height - footer + 1, {
      width: width - 10,
      height: 15,
      ellipsis: true,
    });
}
