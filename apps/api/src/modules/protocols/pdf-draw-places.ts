import { bronzeMedalCount } from '@judo/engine/draw';
import { categoryResults, type ProtocolCategory } from './protocol-model.js';
import { ProtocolPdf, ink } from './pdf-document.js';

/** Final category medals only. Pending draws never expose provisional podium names. */
export function drawPlaces(c: ProtocolCategory) {
  const data = categoryResults(c);
  const places = data?.places;
  const expected = [
    1,
    2,
    ...Array.from({ length: data ? bronzeMedalCount(data.draw) : 0 }, () => 3),
  ];
  const rows = places
    ? places.filter((p) => p.place <= 3)
    : expected.map((place) => ({ place, entryId: null }));
  return {
    complete: !!places,
    rows: rows.map((p) => ({
      place: p.place,
      entry: p.entryId ? c.entries.find((e) => e.id === p.entryId) : undefined,
    })),
  };
}
export const PLACES_SIDEBAR_WIDTH = 190;
export const PLACES_SIDEBAR_GAP = 18;

/** Sidebar for graphical brackets; horizontal cards below round-robin/pool tables. */
export function paintDrawPlaces(
  pdf: ProtocolPdf,
  c: ProtocolCategory,
  x: number,
  y: number,
  width: number,
  horizontal = false,
) {
  const d = pdf.doc,
    data = drawPlaces(c),
    gap = 8;
  const rowHeight = 70;
  const height = 51 + (horizontal ? rowHeight : data.rows.length * (rowHeight + gap) - gap) + 25;
  const savedY = d.y;
  d.roundedRect(x, y, width, height, 6).fillAndStroke('#ffffff', ink.line);
  d.roundedRect(x, y, width, 26, 6).fill(ink.navy);
  d.rect(x, y + 21, width, 5).fill(ink.navy);
  d.font('Bold')
    .fontSize(10)
    .fillColor('#ffffff')
    .text(pdf.text('ИТОГОВЫЕ МЕСТА', 'ҚОРЫТЫНДЫ ОРЫНДАР'), x + 10, y + 6, {
      width: width - 20,
      height: 15,
    });
  d.font('Regular')
    .fontSize(8)
    .fillColor(ink.muted)
    .text(pdf.text('Итог категории', 'Санат қорытындысы'), x + 10, y + 32, {
      width: width - 20,
      height: 12,
    });
  const cardWidth = horizontal
    ? (width - 20 - gap * (data.rows.length - 1)) / Math.max(1, data.rows.length)
    : width - 20;
  if (data.complete && data.rows.length === 0)
    d.font('Regular')
      .fontSize(9)
      .fillColor(ink.muted)
      .text(
        pdf.text('Нет участников для присуждения мест', 'Орын берілетін қатысушылар жоқ'),
        x + 10,
        y + 51,
        { width: width - 20 },
      );
  for (const [i, row] of data.rows.entries()) {
    const rx = x + 10 + (horizontal ? i * (cardWidth + gap) : 0);
    const ry = y + 51 + (horizontal ? 0 : i * (rowHeight + gap));
    const medal = row.place === 1 ? ink.gold : row.place === 2 ? '#9aaabd' : '#b77743';
    d.roundedRect(rx, ry, cardWidth, rowHeight, 4).fill(row.place === 1 ? ink.goldLight : ink.pale);
    d.circle(rx + 17, ry + 17, 11).fill(medal);
    d.font('Bold')
      .fontSize(12)
      .fillColor(row.place === 1 ? ink.navy : '#ffffff')
      .text(String(row.place), rx + 6, ry + 9, { width: 22, align: 'center', height: 18 });
    const name = row.entry
      ? `${row.entry.lastName} ${row.entry.firstName}`
      : pdf.text('Ещё не определено', 'Әлі анықталмаған');
    const nx = rx + 34;
    const ny = ry + 5;
    const nw = cardWidth - 41;
    let size = 10;
    d.font('Bold').fontSize(size);
    while (size > 8 && d.heightOfString(pdf.safe(name), { width: nw }) > 32) {
      size -= 0.5;
      d.fontSize(size);
    }
    d.fillColor(ink.navy).text(pdf.safe(name), nx, ny, { width: nw, height: 32, ellipsis: true });
    d.font('Regular')
      .fontSize(8)
      .fillColor(ink.muted)
      .text(pdf.safe(row.entry?.club ?? ''), nx, ny + 35, {
        width: nw,
        height: 24,
        ellipsis: true,
      });
  }
  d.font('Regular')
    .fontSize(7.5)
    .fillColor(ink.muted)
    .text(
      data.complete
        ? pdf.text('Результаты подтверждены', 'Нәтижелер расталған')
        : pdf.text('После завершения категории', 'Санат аяқталғаннан кейін'),
      x + 10,
      y + height - 18,
      { width: width - 20, height: 12 },
    );
  d.y = horizontal ? y + height + 12 : savedY;
}
