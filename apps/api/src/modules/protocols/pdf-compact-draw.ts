import { bracketNodes, type Slot } from '@judo/engine/draw';
import { scoreboardScores, type MatchState } from '@judo/engine/match';
import { categoryResults, type ProtocolCategory } from './protocol-model.js';
import { drawPlaces } from './pdf-draw-places.js';
import { ProtocolPdf, ink } from './pdf-document.js';

type CompactWindow = {
  start: number;
  end: number;
  leaf: number;
  target: number;
  preview?: boolean;
};

/** Fit a complete category before drawing; long names fall back to the paginated layout. */
export function compactDraw(
  pdf: ProtocolPdf,
  c: ProtocolCategory,
  title: string,
  subtitle: string,
  name: (slot: Slot | null) => string,
  resultLabel: (id: string) => string,
  window?: CompactWindow,
) {
  const data = categoryResults(c);
  if (!data) return false;
  const { draw } = data;
  const allNodes = bracketNodes(draw);
  const maxRound = Math.max(...allNodes.map((n) => n.round));
  const start = window?.start ?? 1,
    end = window?.end ?? maxRound,
    leaf = window?.leaf ?? 0;
  const nodes = allNodes.filter(
    (n) =>
      n.round >= start && n.round <= end && n.leafStart >= leaf && n.leafStart < leaf + 2 ** end,
  );
  const rounds = end - start + 1;
  const finalPage = end === maxRound;
  if (!nodes.length || rounds > 4 || draw.pools) return false;
  const d = pdf.doc,
    gap = 10,
    width = (523.28 - gap * (rounds - 1)) / rounds;
  const extra = finalPage
    ? draw.matches.filter((m) => m.stage === 'BRONZE' || m.stage === 'REPECHAGE')
    : [];
  const all = [...nodes.map((n) => ({ white: n.white, blue: n.blue })), ...extra];
  const measureWidth = extra.some((m) => m.stage === 'REPECHAGE')
    ? Math.min(width, (523.28 - 36) / 4)
    : width;
  let half = 28;
  for (const pair of all)
    for (const slot of [pair.white, pair.blue]) {
      const [person, ...club] = pdf.safe(name(slot)).split('\n');
      d.font('Bold').fontSize(6.5);
      const nh = d.heightOfString(person, { width: measureWidth - 12 });
      d.font('Regular').fontSize(6);
      const ch = club.length ? d.heightOfString(club.join(' '), { width: measureWidth - 12 }) : 0;
      half = Math.max(half, nh + ch + 10);
    }
  const height = 11 + half * 2,
    pitch = height + 3;
  // Reserve room under the tree for both repechage paths; places use the final column.
  d.font('Bold').fontSize(13);
  const titleHeight = d.heightOfString(pdf.safe(title), { width: 523.28 });
  d.font('Regular').fontSize(7);
  const subtitleHeight = d.heightOfString(pdf.safe(subtitle), { width: 523.28 });
  const top = Math.max(96, 49 + titleHeight + 5 + subtitleHeight + 12),
    treeHeight = pitch * 2 ** (rounds - 1);
  const extraHeight = extra.length ? height + 22 : 0;
  if (top + treeHeight > 785 || extra.length > 4) return false;
  const extraPage = top + treeHeight + extraHeight > 785;
  const podium = drawPlaces(c);
  const sidebarY = top + treeHeight / 2 + height / 2 + 18;
  const sidebarTextFits = podium.rows.every((p) => {
    d.font('Bold').fontSize(7);
    const nh = d.heightOfString(
      `${p.place}. ${p.entry ? p.entry.lastName + ' ' + p.entry.firstName : '—'}`,
      { width: width - 10 },
    );
    d.font('Regular').fontSize(6);
    return nh <= 20 && d.heightOfString(p.entry?.club ?? '', { width: width - 10 }) <= 9;
  });
  const sidebarFits =
    sidebarTextFits && sidebarY + 28 + podium.rows.length * 34 <= top + treeHeight && width >= 110;
  if (finalPage && !sidebarFits && !extraPage) {
    let rowsHeight = 30;
    for (const row of podium.rows) {
      d.font('Bold').fontSize(9);
      const nh = d.heightOfString(
        row.entry ? row.entry.lastName + ' ' + row.entry.firstName : '—',
        { width: 523.28 * 0.5 - 16 },
      );
      d.font('Regular').fontSize(9);
      const ch = d.heightOfString(row.entry?.club ?? '', { width: 523.28 * 0.4 - 16 });
      rowsHeight += Math.max(30, nh + 12, ch + 12);
    }
    if (top + treeHeight + 16 + (extra.length ? height + 12 : 0) + rowsHeight > 785) return false;
  }
  if (window?.preview) return true;
  pdf.section(title, subtitle, false, true);
  const number = (id: string) => `№ ${draw.matches.findIndex((m) => m.id === id) + 1}`;
  const paint = (
    id: string | null,
    white: Slot | null,
    blue: Slot | null,
    x: number,
    y: number,
    w: number,
  ) => {
    const row = c.draw?.contests.find((r) => r.key === id);
    d.roundedRect(x, y, w, height, 3).fillAndStroke('#fff', ink.line);
    d.rect(x + 1, y + 1, w - 2, 10).fill(ink.pale);
    d.font('Bold')
      .fontSize(6)
      .fillColor(ink.muted)
      .text(id ? `${number(id)} · ${resultLabel(id)}` : 'BYE', x + 4, y + 1, {
        width: w - 8,
        height: 9,
      });
    for (const [i, slot] of [white, blue].entries()) {
      const sy = y + 11 + i * half;
      const label = pdf.safe(name(slot));
      const [person, ...club] = label.split('\n');
      const won =
        row?.status === 'CONFIRMED' &&
        !!row.winnerEntryId &&
        row.winnerEntryId === (i ? row.blueEntryId : row.whiteEntryId);
      d.rect(x + 1, sy, w - 2, half - 1).fill(won ? '#edf6ef' : i ? ink.blueLight : '#fff');
      d.rect(x + 1, sy, 2, half - 1).fill(i ? ink.blue : '#aab8cb');
      d.font('Bold').fontSize(6.5).fillColor(ink.navy);
      const nh = d.heightOfString(person, { width: w - 12 });
      d.text(person, x + 6, sy + 1, { width: w - 12, height: nh + 0.1 });
      d.font('Regular').fontSize(6).fillColor(ink.muted);
      const ch = club.length ? d.heightOfString(club.join(' '), { width: w - 12 }) : 0;
      if (ch) d.text(club.join(' '), x + 6, sy + nh + 1, { width: w - 12, height: ch + 0.1 });
      if (row?.status === 'CONFIRMED' && row.state) {
        const score = scoreboardScores(row.state as unknown as MatchState, i ? 'BLUE' : 'WHITE');
        d.font('Regular')
          .fontSize(5.5)
          .fillColor(ink.navy)
          .text(
            `I ${score.IPPON}   W ${score.WAZA_ARI}   Y ${score.YUKO}   S ${score.SHIDO}`,
            x + 6,
            sy + half - 8,
            { width: w - 12, height: 8 },
          );
      }
    }
  };
  const cards = nodes.map((n) => ({
    ...n,
    x: 36 + (n.round - start) * (width + gap),
    y: top + (n.index - leaf / 2 ** n.round + 0.5) * 2 ** (n.round - start) * pitch - height / 2,
  }));
  for (let r = start; r <= end; r++) {
    d.font('Bold')
      .fontSize(7)
      .fillColor(ink.navy)
      .text(
        r === maxRound
          ? pdf.text('ФИНАЛ', 'ФИНАЛ')
          : `1/${2 ** (maxRound - r)} ${pdf.text('финала', 'финал')}`,
        36 + (r - start) * (width + gap),
        top - 14,
        { width, height: 11, align: 'center' },
      );
  }
  for (const card of cards) {
    const parent = cards.find(
      (p) => p.id === `r${card.round + 1}-m${Math.floor(card.index / 2) + 1}`,
    );
    if (parent)
      d.strokeColor('#8999ae')
        .lineWidth(0.7)
        .moveTo(card.x + width, card.y + height / 2)
        .lineTo(card.x + width + gap / 2, card.y + height / 2)
        .lineTo(card.x + width + gap / 2, parent.y + height / 2)
        .lineTo(parent.x, parent.y + height / 2)
        .stroke();
  }
  for (const card of cards) paint(card.matchId, card.white, card.blue, card.x, card.y, width);
  if (!finalPage) {
    const links = nodes
      .filter((n) => n.round === end)
      .flatMap((n) => {
        const parent = allNodes.find(
          (p) => p.id === `r${n.round + 1}-m${Math.floor(n.index / 2) + 1}`,
        );
        return parent?.matchId
          ? [`${n.matchId ? number(n.matchId) : 'BYE'} → ${number(parent.matchId)}`]
          : [];
      });
    d.font('Regular')
      .fontSize(7)
      .fillColor(ink.muted)
      .text(
        pdf.safe(
          links.join(' · ') +
            ' · ' +
            pdf.text('Продолжение: лист ', 'Жалғасы: парақ ') +
            window!.target,
        ),
        36,
        790,
        { width: pdf.width, height: 10 },
      );
    return true;
  }
  const bronzes = extra.filter((m) => m.stage === 'BRONZE');
  if (extraPage)
    pdf.section(
      title,
      subtitle + ' · ' + pdf.text('Утешение и места', 'Жұбаныш және орындар'),
      false,
      true,
    );
  const ey = extraPage ? Math.max(top + 12, d.y + 12) : top + treeHeight + 16;
  for (const [i, bronze] of bronzes.entries()) {
    const source = bronze.white;
    const rep =
      'winnerOf' in source
        ? extra.find((m) => m.id === source.winnerOf && m.stage === 'REPECHAGE')
        : undefined;
    const groupWidth = (pdf.width - 16) / 2,
      gx = 36 + i * (groupWidth + 16),
      w = rep ? (groupWidth - 10) / 2 : groupWidth;
    d.font('Bold')
      .fontSize(7)
      .fillColor(ink.navy)
      .text(pdf.text('Утешение / бронза', 'Жұбаныш / қола'), gx, ey - 12, {
        width: groupWidth,
        height: 10,
      });
    if (rep) {
      d.strokeColor('#8999ae')
        .moveTo(gx + w, ey + height / 2)
        .lineTo(gx + w + 10, ey + height / 2)
        .stroke();
      paint(rep.id, rep.white, rep.blue, gx, ey, w);
    }
    paint(bronze.id, bronze.white, bronze.blue, gx + (rep ? w + 10 : 0), ey, rep ? w : groupWidth);
  }
  const places = drawPlaces(c);
  const final = cards.find((n) => n.round === maxRound)!;
  const py = final.y + height + 18,
    ph = 28 + places.rows.length * 34;
  if (!extraPage && sidebarFits) {
    d.roundedRect(final.x, py, width, ph, 3).fillAndStroke('#fff', ink.line);
    d.font('Bold')
      .fontSize(7)
      .fillColor(ink.navy)
      .text(pdf.text('Итоговые места', 'Қорытынды орындар'), final.x + 5, py + 5, {
        width: width - 10,
        height: 18,
      });
    for (const [i, p] of places.rows.entries()) {
      d.font('Bold')
        .fontSize(7)
        .text(
          `${p.place}. ${p.entry ? p.entry.lastName + ' ' + p.entry.firstName : '—'}`,
          final.x + 5,
          py + 25 + i * 34,
          { width: width - 10, height: 20 },
        );
      d.font('Regular')
        .fontSize(6)
        .fillColor(ink.muted)
        .text(p.entry?.club ?? '', final.x + 5, py + 45 + i * 34, { width: width - 10, height: 9 });
      d.fillColor(ink.navy);
    }
  } else {
    // Short trees leave a wide strip below; no repeated podium cards.
    const py2 = ey + (extra.length ? height + 12 : 0);
    d.y = py2;
    pdf.table(
      [pdf.text('Место', 'Орын'), pdf.text('Участник', 'Қатысушы'), pdf.text('Клуб', 'Клуб')],
      places.rows.map((p) => [
        String(p.place),
        p.entry ? `${p.entry.lastName} ${p.entry.firstName}` : '—',
        p.entry?.club ?? '',
      ]),
      [0.1, 0.5, 0.4],
      { compact: true },
    );
  }
  d.font('Regular')
    .fontSize(6)
    .fillColor(ink.muted)
    .text(
      pdf.text(
        'Зелёная строка — победитель. I: Ippon · W: Waza-ari · Y: Yuko · S: Shido.',
        'Жасыл жол — жеңімпаз. I: Ippon · W: Waza-ari · Y: Yuko · S: Shido.',
      ),
      36,
      790,
      { width: pdf.width, height: 10 },
    );
  return true;
}

/** Four rounds per sheet when measured names fit; preserve the original graph and match numbers. */
export function compactDrawPages(
  pdf: ProtocolPdf,
  c: ProtocolCategory,
  title: string,
  subtitle: string,
  name: (slot: Slot | null) => string,
  result: (id: string) => string,
) {
  const data = categoryResults(c);
  if (!data || data.draw.pools) return false;
  const rounds = Math.max(...bracketNodes(data.draw).map((n) => n.round));
  if (rounds <= 4) return compactDraw(pdf, c, title, subtitle, name, result);
  const views: CompactWindow[] = [];
  for (let start = 1; start <= rounds; start += 4) {
    const end = Math.min(start + 3, rounds);
    for (let leaf = 0; leaf < 2 ** rounds; leaf += 2 ** end)
      views.push({ start, end, leaf, target: 0 });
  }
  for (const view of views) view.target = views.length;
  if (
    !views.every((v, i) =>
      compactDraw(
        pdf,
        c,
        title,
        subtitle + ' · ' + pdf.text('Лист ', 'Парақ ') + (i + 1) + '/' + views.length,
        name,
        result,
        { ...v, preview: true },
      ),
    )
  )
    return false;
  for (const [i, v] of views.entries())
    compactDraw(
      pdf,
      c,
      title,
      subtitle + ' · ' + pdf.text('Лист ', 'Парақ ') + (i + 1) + '/' + views.length,
      name,
      result,
      v,
    );
  return true;
}
