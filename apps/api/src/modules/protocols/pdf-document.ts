import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import type { ProtocolTournament, Translate } from './protocol-model.js';
export const ink = {
  navy: '#142238',
  muted: '#617087',
  gold: '#eab63d',
  goldLight: '#fff5d9',
  blue: '#245bbe',
  blueLight: '#eef4ff',
  line: '#dbe3ec',
  pale: '#f5f7fa',
};
export type TableStyle = {
  medals?: boolean;
  places?: boolean;
  strongColumn?: number;
  compact?: boolean;
};
/** Shared print design: embedded RU/KK fonts, repeated headers and explicit result hierarchy. */
export class ProtocolPdf {
  readonly doc: PDFKit.PDFDocument;
  readonly finished: Promise<Buffer>;
  private sectionTitle = '';
  private subtitle = '';
  private landscape = false;
  private readonly generated: string;
  private readonly margins = { top: 32, bottom: 44, left: 36, right: 36 };
  constructor(
    private readonly tournament: ProtocolTournament,
    readonly text: Translate,
    title: string,
    lang: 'ru' | 'kk',
  ) {
    this.generated = new Date().toLocaleString(lang === 'kk' ? 'kk-KZ' : 'ru-RU', {
      timeZone: tournament.timezone,
    });
    this.doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
      margins: this.margins,
      info: { Title: `${tournament.name} · ${title}`, Author: 'Judo Child League' },
    });
    const chunks: Buffer[] = [];
    this.finished = new Promise((resolve, reject) => {
      this.doc.on('data', (c) => chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    for (const [name, file] of [
      ['Regular', 'NotoSans-Regular.ttf'],
      ['Bold', 'NotoSans-Bold.ttf'],
    ])
      this.doc.registerFont(
        name,
        fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url)),
      );
    this.doc.font('Regular');
    this.doc.on('pageAdded', () => this.header());
  }
  safe(value: string) {
    return value.replace(/[−‑]/g, '-').replace(/→/g, '->');
  }
  get width() {
    return this.doc.page.width - 72;
  }
  section(title: string, subtitle = '', landscape = false) {
    this.sectionTitle = this.safe(title);
    this.subtitle = this.safe(subtitle);
    this.landscape = landscape;
    this.page();
    this.doc.outline.addItem(this.sectionTitle);
  }
  page() {
    // PDFKit uses addPage's options instead of inheriting document options. Omitting
    // margins silently restores its 72 pt default and splits a manually fitted row.
    this.doc.addPage({
      size: 'A4',
      layout: this.landscape ? 'landscape' : 'portrait',
      margins: this.margins,
    });
  }
  private header() {
    const d = this.doc,
      compact = this.landscape;
    d.rect(24, 22, d.page.width - 48, compact ? 50 : 64).fill(ink.navy);
    d.rect(24, compact ? 70 : 84, d.page.width - 48, 3).fill(ink.gold);
    d.image(
      fileURLToPath(new URL('../../../assets/brand/jcl-logo.jpg', import.meta.url)),
      36,
      compact ? 29 : 32,
      { width: compact ? 35 : 42, height: compact ? 35 : 42 },
    );
    d.font('Bold')
      .fontSize(8)
      .fillColor(ink.gold)
      .text('JUDO CHILD LEAGUE', 90, compact ? 27 : 31, {
        width: this.width - 68,
        characterSpacing: 1.3,
      });
    d.fontSize(compact ? 11 : 12)
      .fillColor('#ffffff')
      .text(this.safe(this.tournament.name), 90, compact ? 40 : 45, {
        width: this.width - 68,
        height: compact ? 27 : 33,
        ellipsis: true,
      });
    const [heading, ...category] = this.sectionTitle.split(' · ');
    d.font('Bold')
      .fontSize(compact ? 16 : 20)
      .fillColor(ink.navy)
      .text(compact ? this.sectionTitle : heading.toLocaleUpperCase(), 36, compact ? 85 : 100, {
        width: this.width,
      });
    if (!compact && category.length)
      d.fontSize(12).text(category.join(' · '), 36, d.y + 4, { width: this.width });
    d.font('Regular')
      .fontSize(compact ? 7.5 : 8)
      .fillColor(ink.muted)
      .text(this.safe(`${this.tournament.city} · ${this.subtitle}`), 36, d.y + 5, {
        width: this.width,
      });
    d.y += compact ? 10 : 13;
  }

  ensure(height: number) {
    if (this.doc.y + height > this.doc.page.height - 55) this.page();
  }
  line(value: string, size = 10, color: string = ink.navy) {
    const d = this.doc;
    value = this.safe(value);
    d.font(size >= 12 ? 'Bold' : 'Regular').fontSize(size);
    this.ensure(d.heightOfString(value, { width: this.width }) + 8);
    d.font(size >= 12 ? 'Bold' : 'Regular')
      .fontSize(size)
      .fillColor(color)
      .text(value, 36, d.y, { width: this.width })
      .moveDown(0.6);
  }
  notice(value: string, complete = false) {
    const d = this.doc;
    value = this.safe(value);
    d.font('Regular').fontSize(9.5);
    const h = d.heightOfString(value, { width: this.width - 28 }) + 22;
    this.ensure(h + 12);
    const y = d.y;
    d.roundedRect(36, y, this.width, h, 6).fill(complete ? '#eaf5ef' : ink.goldLight);
    d.rect(36, y, 3, h).fill(complete ? '#198161' : ink.gold);
    d.fillColor(ink.navy).text(value, 50, y + 11, { width: this.width - 28 });
    d.y = y + h + 14;
  }
  metrics(items: { label: string; value: string | number }[]) {
    this.ensure(64);
    const d = this.doc,
      y = d.y,
      w = (this.width - (items.length - 1) * 10) / items.length;
    items.forEach((item, i) => {
      const x = 36 + i * (w + 10);
      d.roundedRect(x, y, w, 52, 6).fill(ink.pale);
      d.font('Bold')
        .fontSize(18)
        .fillColor(ink.navy)
        .text(String(item.value), x + 12, y + 6, { width: w - 24 });
      d.font('Regular')
        .fontSize(8)
        .fillColor(ink.muted)
        .text(this.safe(item.label), x + 12, y + 31, { width: w - 24, height: 15, ellipsis: true });
    });
    d.y = y + 66;
  }
  podium(rows: { place: number; name: string }[]) {
    const podium = rows.filter((r) => r.place <= 3);
    if (!podium.length) return;
    this.ensure(130);
    const d = this.doc,
      y = d.y,
      w = (this.width - (podium.length - 1) * 10) / podium.length;
    podium.forEach((p, i) => {
      const x = 36 + i * (w + 10),
        color = p.place === 1 ? ink.gold : p.place === 2 ? '#a7b5c6' : '#bc7d48';
      d.roundedRect(x, y, w, 110, 6).fillAndStroke(
        p.place === 1 ? ink.goldLight : ink.pale,
        ink.line,
      );
      d.circle(x + 20, y + 20, 11).fill(color);
      d.font('Bold')
        .fontSize(12)
        .fillColor(p.place === 1 ? ink.navy : '#ffffff')
        .text(String(p.place), x + 10, y + 12, { width: 20, align: 'center' });
      d.fontSize(8)
        .fillColor(ink.muted)
        .text(this.text('МЕСТО', 'ОРЫН'), x + 37, y + 15, { width: w - 45 });
      const [name, ...club] = this.safe(p.name).split('\n');
      d.fontSize(10)
        .fillColor(ink.navy)
        .text(name, x + 12, y + 41, { width: w - 24, height: 37, ellipsis: true });
      d.font('Regular')
        .fontSize(8)
        .fillColor(ink.muted)
        .text(club.join(' '), x + 12, y + 82, { width: w - 24, height: 21, ellipsis: true });
    });
    d.y = y + 126;
  }
  table(headers: string[], rows: string[][], weights: number[], style: TableStyle = {}) {
    headers = headers.map((c) => this.safe(c));
    rows = rows.map((r) => r.map((c) => this.safe(c)));
    const d = this.doc,
      widths = weights.map((w) => this.width * w);
    const bodySize = style.compact ? 9 : 9.5;
    const padding = style.compact ? 6 : 9;
    const cellStyle = (index: number, head: boolean) => {
      const numeric = !head && style.medals && index >= 2;
      return {
        font: head || numeric || index === (style.strongColumn ?? 1) ? 'Bold' : 'Regular',
        size: numeric ? 13 : head ? 8.5 : bodySize,
        align: numeric ? ('center' as const) : ('left' as const),
      };
    };
    const rowHeight = (cells: string[], head: boolean) =>
      Math.max(
        style.compact ? 30 : 34,
        ...cells.map((cell, index) => {
          const { font, size } = cellStyle(index, head);
          d.font(font).fontSize(size);
          return d.heightOfString(cell, { width: widths[index] - 16 }) + padding * 2;
        }),
      );
    const row = (cells: string[], head = false, index = 0) => {
      const h = rowHeight(cells, head);
      if (d.y + h > d.page.height - 55) {
        this.page();
        if (!head) row(headers, true);
      }
      const y = d.y;
      let x = 36;
      d.rect(x, y, this.width, h).fill(head ? ink.navy : index % 2 === 0 ? '#ffffff' : ink.pale);
      cells.forEach((c, i) => {
        if (!head && style.medals && i >= 2 && i <= 4)
          d.rect(x, y, widths[i], h).fill(i === 2 ? '#fff6dc' : i === 3 ? '#edf1f6' : '#f7eee6');
        if (!head && i === 0 && (style.places || style.medals) && /^[123]$/.test(c)) {
          const color = c === '1' ? ink.gold : c === '2' ? '#a7b5c6' : '#bc7d48';
          d.circle(x + widths[i] / 2, y + h / 2, 11).fill(color);
          d.font('Bold')
            .fontSize(11)
            .fillColor(c === '1' ? ink.navy : '#ffffff')
            .text(c, x, y + h / 2 - 8, { width: widths[i], align: 'center' });
        } else {
          const { font, size, align } = cellStyle(i, head);
          d.font(font)
            .fontSize(size)
            .fillColor(head ? '#ffffff' : ink.navy)
            .text(c, x + 8, y + padding, {
              width: widths[i] - 16,
              height: h - padding * 2,
              align,
            });
        }
        x += widths[i];
      });
      d.strokeColor(ink.line)
        .lineWidth(0.5)
        .moveTo(36, y + h)
        .lineTo(36 + this.width, y + h)
        .stroke();
      d.y = y + h;
    };
    // Keep a table heading with at least its first row, including after another section.
    this.ensure(rowHeight(headers, true) + (rows[0] ? rowHeight(rows[0], false) : 0));
    row(headers, true);
    rows.forEach((r, i) => row(r, false, i));
    d.y += 16;
  }
  end() {
    const d = this.doc,
      range = d.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      d.switchToPage(i);
      d.strokeColor(ink.line)
        .lineWidth(0.6)
        .moveTo(36, d.page.height - 38)
        .lineTo(d.page.width - 36, d.page.height - 38)
        .stroke();
      d.font('Regular')
        .fontSize(7)
        .fillColor(ink.muted)
        .text(`${this.generated} (${this.tournament.timezone})`, 36, d.page.height - 27, {
          lineBreak: false,
        });
      const pageLabel = `${this.text('СТР.', 'БЕТ')} ${i + 1} / ${range.count}`;
      d.font('Bold')
        .fontSize(8)
        .fillColor(ink.navy)
        .text(pageLabel, d.page.width - 36 - d.widthOfString(pageLabel), d.page.height - 27, {
          lineBreak: false,
        });
    }
    d.end();
    return this.finished;
  }
}
