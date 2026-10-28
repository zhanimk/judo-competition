import { scoreboardScores, type MatchState, type Side } from '@judo/engine/match';
import { bracketNodes, type Slot } from '@judo/engine/draw';
import { categoryResults, slotName, type ProtocolCategory } from './protocol-model.js';
import { ProtocolPdf, ink } from './pdf-document.js';
import { paintDrawCard } from './pdf-draw-card.js';
import { paintDrawPlaces } from './pdf-draw-places.js';
import { scoreLegend } from './pdf-bout-card.js';
/** Paginate by three rounds/eight source slots, never shrink an entire 128-person bracket onto A4. */
export function renderDraw(pdf: ProtocolPdf, c: ProtocolCategory, subtitle: string) {
  const text = pdf.text,
    data = categoryResults(c);
  const title = `${text('Сетка', 'Тор')} · ${c.name}`;
  if (!data) {
    pdf.section(title, subtitle);
    pdf.line(text('Жеребьёвка ещё не проведена', 'Жеребе әлі өткізілмеген'));
    return;
  }
  const { draw, winners } = data,
    rawName = slotName(c, text),
    name = (slot: Slot | null) => {
      if (
        slot &&
        'winnerOf' in slot &&
        !winners[slot.winnerOf] &&
        !draw.voidMatches?.includes(slot.winnerOf)
      )
        return text('Победитель схватки ', 'Белдесу жеңімпазы ') + number(slot.winnerOf);
      if (
        slot &&
        'loserOf' in slot &&
        !winners[slot.loserOf] &&
        !draw.voidMatches?.includes(slot.loserOf)
      )
        return text('Проигравший схватки ', 'Белдесуде жеңілген ') + number(slot.loserOf);
      return pdf.safe(rawName(slot));
    };
  const number = (id: string) => `№ ${draw.matches.findIndex((m) => m.id === id) + 1}`;
  const resultLabel = (id: string) => {
    const row = c.draw?.contests.find((m) => m.key === id);
    const labels: Record<string, [string, string]> = {
      IPPON: ['Иппон', 'Иппон'],
      COMBINATION: ['Два Waza-ari', 'Екі Waza-ari'],
      TIME: ['По оценкам', 'Бағалар бойынша'],
      ACCUMULATED_SHIDO: ['Три Shido', 'Үш Shido'],
      WALKOVER: ['Проход без борьбы', 'Күрессіз өту'],
      WITHDRAWAL: ['Соперник удалён', 'Қарсылас шығарылды'],
      NO_CONTEST: ['Оба участника удалены', 'Екі қатысушы да шығарылды'],
      GOLDEN_SCORE: ['Golden Score', 'Golden Score'],
    };
    return row?.status === 'CONFIRMED'
      ? labels[row.resultReason ?? '']
        ? text(...labels[row.resultReason!])
        : text('Завершена', 'Аяқталған')
      : text('Ожидает', 'Күтілуде');
  };
  const scores = (id: string, side: Side) => {
    const record = c.draw?.contests.find((m) => m.key === id);
    if (record?.status !== 'CONFIRMED' || !record.state) return '';
    const value = scoreboardScores(record.state as unknown as MatchState, side);
    return `\nI ${value.IPPON} · W ${value.WAZA_ARI} · Y ${value.YUKO} · S ${value.SHIDO}`;
  };
  const pairTable = (matches: typeof draw.matches) =>
    pdf.table(
      [
        text('Тур / схватка', 'Айналым / белдесу'),
        text('Белый', 'Ақ'),
        text('Синий', 'Көк'),
        text('Победитель', 'Жеңімпаз'),
      ],
      matches.map((m) => [
        `${text('Тур', 'Айналым')} ${m.round} · ${number(m.id)}`,
        name(m.white) + scores(m.id, 'WHITE'),
        name(m.blue) + scores(m.id, 'BLUE'),
        winners[m.id]
          ? name({ entryId: winners[m.id] }) + `\n${resultLabel(m.id)}`
          : draw.voidMatches?.includes(m.id)
            ? text('Нет участника', 'Қатысушы жоқ')
            : text('Ожидает', 'Күтілуде'),
      ]),
      [0.14, 0.3, 0.3, 0.26],
      { compact: true },
    );
  // Medal overview comes first: final above two distinct repechage -> bronze paths.
  if (draw.matches.some((m) => m.stage === 'BRONZE')) {
    pdf.section(
      title,
      `${subtitle} · ${text('Финал и встречи за 3-е место', 'Финал және 3-орын үшін белдесулер')}`,
      false,
    );
    const d = pdf.doc,
      top = d.y + 24;
    const chartWidth = pdf.width;
    const cardW = (chartWidth - 36) / 2,
      rightX = 36 + cardW + 36;
    const final = draw.matches.filter((m) => !m.stage || m.stage === 'MAIN').at(-1)!;
    const paint = (bout: typeof final, label: string, x: number, y: number, width: number) =>
      paintDrawCard(
        pdf,
        {
          label: `${label} · ${number(bout.id)} · ${resultLabel(bout.id)}`,
          white: name(bout.white),
          blue: name(bout.blue),
          record: c.draw?.contests.find((m) => m.key === bout.id),
        },
        x,
        y,
        width,
        116,
      );
    paint(final, text('ФИНАЛ · за 1-е место', 'ФИНАЛ · 1-орын үшін'), 36, top, chartWidth);
    for (const [i, bronze] of draw.matches.filter((m) => m.stage === 'BRONZE').entries()) {
      const source = bronze.white;
      const rep =
        'winnerOf' in source
          ? draw.matches.find((m) => m.id === source.winnerOf && m.stage === 'REPECHAGE')
          : undefined;
      const y = top + 160 + i * 158;
      if (rep) {
        d.strokeColor('#8999ae')
          .lineWidth(1)
          .moveTo(36 + cardW, y + 58)
          .lineTo(rightX, y + 58)
          .stroke();
        d.moveTo(rightX - 5, y + 55)
          .lineTo(rightX, y + 58)
          .lineTo(rightX - 5, y + 61)
          .stroke();
        paint(rep, text('УТЕШЕНИЕ', 'ЖҰБАНЫШ') + ' ' + (i + 1), 36, y, cardW);
        paint(bronze, text('ЗА 3-е МЕСТО', '3-ОРЫН ҮШІН') + ' · ' + (i + 1), rightX, y, cardW);
      } else {
        paint(bronze, text('ЗА 3-е МЕСТО', '3-ОРЫН ҮШІН') + ' · ' + (i + 1), 36, y, chartWidth);
      }
    }
    d.y = top + 450;
    scoreLegend(pdf);
  }
  if (draw.algorithm === 'custom-round-robin-v1' || draw.pools) {
    for (const pool of draw.pools ?? [
      { id: '', entries: draw.positions.flatMap((e) => (e ? [e.id] : [])) },
    ]) {
      pdf.section(
        title,
        `${subtitle} · ${pool.id ? text('Группа ', 'Топ ') + pool.id : text('Каждый с каждым', 'Әрқайсысы әрқайсысымен')}`,
      );
      pdf.line(
        c.entries.length === 2
          ? text('Два участника: одна финальная схватка.', 'Екі қатысушы: бір финалдық белдесу.')
          : text(
              'Каждая пара встречается один раз. Одноклубники также встречаются.',
              'Әр жұп бір рет кездеседі. Клубтастар да кездеседі.',
            ),
      );
      pairTable(draw.matches.filter((m) => (pool.id ? m.pool === pool.id : true)));
      scoreLegend(pdf);
      pdf.ensure(400);
      paintDrawPlaces(pdf, c, 36, pdf.doc.y, pdf.width);
    }
  }
  if (draw.algorithm !== 'custom-round-robin-v1') {
    const nodes = bracketNodes(draw),
      maxRound = Math.max(...nodes.map((n) => n.round));
    const pages: { startRound: number; endRound: number; startLeaf: number; leafCount: number }[] =
      [];
    for (let r = 1; r <= maxRound; r += 3) {
      const endRound = Math.min(r + 2, maxRound),
        leafCount = 2 ** endRound;
      for (let leaf = 0; leaf < 2 ** maxRound; leaf += leafCount)
        pages.push({ startRound: r, endRound, startLeaf: leaf, leafCount });
    }
    const sheetFor = (id: string) =>
      pages.findIndex((p) =>
        nodes.some(
          (n) =>
            n.matchId === id &&
            n.round >= p.startRound &&
            n.round <= p.endRound &&
            n.leafStart >= p.startLeaf &&
            n.leafStart < p.startLeaf + p.leafCount,
        ),
      ) + 1;
    for (const [pageIndex, v] of pages.entries()) {
      pdf.section(
        title,
        `${subtitle} · ${text('Лист сетки', 'Тор парағы')} ${pageIndex + 1}/${pages.length}`,
        false,
      );
      const d = pdf.doc,
        top = d.y + 20,
        gap = 18,
        chartWidth = pdf.width,
        columns = v.endRound - v.startRound + 1,
        cardW = (chartWidth - gap * (columns - 1)) / columns,
        pitch = Math.min(150, (d.page.height - 82 - top) / (v.leafCount / 2 ** v.startRound)),
        cardH = Math.min(132, pitch - 18);
      const cards = nodes
        .filter(
          (n) =>
            n.round >= v.startRound &&
            n.round <= v.endRound &&
            n.leafStart >= v.startLeaf &&
            n.leafStart < v.startLeaf + v.leafCount,
        )
        .map((n) => ({
          ...n,
          x: 36 + (n.round - v.startRound) * (cardW + gap),
          y:
            top +
            (n.index - v.startLeaf / 2 ** n.round + 0.5) * 2 ** (n.round - v.startRound) * pitch -
            cardH / 2,
        }));
      for (let r = v.startRound; r <= v.endRound; r++) {
        const x = 36 + (r - v.startRound) * (cardW + gap);
        const label =
          r === maxRound
            ? text('ФИНАЛ', 'ФИНАЛ')
            : r === maxRound - 1
              ? text('ПОЛУФИНАЛ', 'ЖАРТЫЛАЙ ФИНАЛ')
              : r === maxRound - 2
                ? text('ЧЕТВЕРТЬФИНАЛ', 'ШИРЕК ФИНАЛ')
                : `1/${2 ** (maxRound - r)} ${text('ФИНАЛА', 'ФИНАЛ')}`;
        d.roundedRect(x, top - 25, cardW, 16, 3).fill(r === maxRound ? ink.gold : ink.pale);
        d.font('Bold')
          .fontSize(8)
          .fillColor(ink.navy)
          .text(label, x, top - 22, { width: cardW, align: 'center' });
      }
      for (const card of cards) {
        const parent = cards.find(
          (n) => n.id === `r${card.round + 1}-m${Math.floor(card.index / 2) + 1}`,
        );
        if (parent)
          d.strokeColor('#8999ae')
            .lineWidth(1)
            .moveTo(card.x + cardW, card.y + cardH / 2)
            .lineTo(card.x + cardW + gap / 2, card.y + cardH / 2)
            .lineTo(card.x + cardW + gap / 2, parent.y + cardH / 2)
            .lineTo(parent.x, parent.y + cardH / 2)
            .stroke();
      }
      for (const card of cards) {
        paintDrawCard(
          pdf,
          {
            label: card.matchId ? `${number(card.matchId)} · ${resultLabel(card.matchId)}` : 'BYE',
            white: name(card.white),
            blue: name(card.blue),
            record: c.draw?.contests.find((m) => m.key === card.matchId),
          },
          card.x,
          card.y,
          cardW,
          cardH,
        );
      }

      const last = cards.filter((n) => n.round === v.endRound);
      const links = last.flatMap((n) => {
        const parent = nodes.find(
          (p) => p.id === `r${n.round + 1}-m${Math.floor(n.index / 2) + 1}`,
        );
        return parent?.matchId
          ? [
              `${n.matchId ? number(n.matchId) : 'BYE'} → ${number(parent.matchId)} (${text('лист', 'парақ')} ${sheetFor(parent.matchId)})`,
            ]
          : [];
      });
      d.fontSize(8)
        .fillColor('#526176')
        .text(
          links.length
            ? pdf.safe(links.join(' · ') + ' · I: IPPON · W: WAZA-ARI · Y: YUKO · S: SHIDO')
            : text(
                'I: IPPON · W: WAZA-ARI · Y: YUKO · S: SHIDO. Золотая строка: победитель. BYE: без схватки.',
                'I: IPPON · W: WAZA-ARI · Y: YUKO · S: SHIDO. Алтын жол: жеңімпаз. BYE: белдесусіз.',
              ),
          36,
          d.page.height - 62,
          { width: pdf.width, height: 20 },
        );
      if (pageIndex === pages.length - 1) {
        const placesY = Math.max(...cards.map((card) => card.y + cardH)) + 22;
        if (placesY + 400 > d.page.height - 55)
          pdf.section(title, `${subtitle} · ${text('Итоговые места', 'Қорытынды орындар')}`);
        else d.y = placesY;
        paintDrawPlaces(pdf, c, 36, d.y, pdf.width);
      }
    }
  }
}
