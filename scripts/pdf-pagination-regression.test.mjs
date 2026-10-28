import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolPdf } from '../apps/api/dist/modules/protocols/pdf-document.js';

const tournament = {
  name: 'ОБРАЗЕЦ QA · Әлихан',
  city: 'Алматы',
  venue: 'Вымышленные данные',
  timezone: 'Asia/Almaty',
  startDate: '2026-10-10',
  endDate: '2026-10-10',
  categories: [],
};

function observedPdf(lang, landscape = false) {
  const text = (ru, kk) => (lang === 'kk' ? kk : ru);
  const pdf = new ProtocolPdf(tournament, text, 'Pagination QA', lang);
  const calls = [],
    pages = [];
  let depth = 0,
    automaticPages = 0;
  const original = pdf.doc.text;
  pdf.doc.text = function (value, x, y, options) {
    calls.push({
      value,
      x,
      y,
      options,
      page: this.bufferedPageRange().count,
      fontSize: this._fontSize,
    });
    depth++;
    try {
      return original.call(this, value, x, y, options);
    } finally {
      depth--;
    }
  };
  pdf.doc.on('pageAdded', () => {
    if (depth) automaticPages++;
    pages.push({ ...pdf.doc.page.margins });
  });
  pdf.section(text('Сетка · QA7', 'Тор · QA7'), 'QA · 7 участников · 21 встреча', landscape);
  return { pdf, text, calls, pages, automaticPages: () => automaticPages };
}

test('RU/KK tables keep their final two participants together instead of a lone last page', async () => {
  for (const lang of ['ru', 'kk']) {
    const { pdf, calls, automaticPages } = observedPdf(lang);
    // Enough room for the heading and 15 ordinary rows, but not the sixteenth.
    pdf.doc.y = pdf.doc.page.height - 55 - 16 * 34;
    const rows = Array.from({ length: 16 }, (_, i) => [String(i + 1), `QA-${i + 1} Әлихан`]);
    pdf.table(['№', 'Спортшы'], rows, [0.15, 0.85]);
    const firstCells = rows.map(([id]) => calls.find((call) => call.value === id));
    assert.ok(firstCells.every(Boolean));
    assert.equal(firstCells[14].page, firstCells[15].page);
    assert.notEqual(firstCells[13].page, firstCells[14].page);
    assert.equal(automaticPages(), 0);
    await pdf.end();
  }
});

test('a two-participant table moves its heading with both rows at a section boundary', async () => {
  const { pdf, calls } = observedPdf('kk');
  pdf.doc.y = pdf.doc.page.height - 55 - 2 * 34;
  pdf.table(
    ['№', 'Спортшы'],
    [
      ['1', 'Әлихан'],
      ['2', 'Аслан'],
    ],
    [0.15, 0.85],
  );
  const cells = calls.filter((call) => ['Спортшы', 'Әлихан', 'Аслан'].includes(call.value));
  assert.equal(cells.length, 3);
  assert.equal(new Set(cells.map((cell) => cell.page)).size, 1);
  await pdf.end();
});

test('RU/KK multiline tables move whole rows, preserve page margins and repeat their heading', async () => {
  for (const lang of ['ru', 'kk']) {
    const { pdf, text, calls, pages, automaticPages } = observedPdf(lang);
    const headers = [
      text('Тур / схватка', 'Айналым / белдесу'),
      text('Белый', 'Ақ'),
      text('Синий', 'Көк'),
      text('Победитель', 'Жеңімпаз'),
    ];
    const rows = Array.from({ length: 42 }, (_, i) => [
      `${text('Тур', 'Айналым')} ${Math.floor(i / 3) + 1} · № ${i + 1}`,
      `QA${i} Әлихан\nКлуб${i % 3}`,
      `QA${i + 1} Әлихан\nКлуб${(i + 1) % 3}`,
      `QA${i} Әлихан\nКлуб${i % 3}`,
    ]);
    pdf.table(headers, rows, [0.14, 0.3, 0.3, 0.26], { compact: true });
    assert.equal(automaticPages(), 0, `${lang}: a table cell must never trigger PDFKit page flow`);
    assert.ok(pages.length >= 3, 'fixture crosses multiple table pages');
    for (const margins of pages)
      assert.deepEqual(margins, { top: 32, bottom: 44, left: 36, right: 36 });
    assert.equal(calls.filter((call) => call.value === headers[0]).length, pages.length);
    for (const row of rows) {
      const cells = calls.filter((call) => row.includes(call.value));
      // Names intentionally appear in other rows too; the first cell identifies this exact row.
      const anchor = calls.findIndex((call) => call.value === row[0]);
      const actual = calls.slice(anchor, anchor + row.length);
      assert.deepEqual(
        actual.map((call) => call.value),
        row,
      );
      assert.ok(
        actual.every((call) => call.page === actual[0].page),
        `${lang}: row ${row[0]} stays together`,
      );
      assert.ok(cells.length >= 4);
      assert.ok(
        actual.every((call) => call.options.height > 0),
        'table owns its cell text boxes',
      );
    }
    const output = await pdf.end();
    assert.equal(output.subarray(0, 5).toString(), '%PDF-');
  }
});

test('a table heading near the footer moves with the first row instead of being orphaned', async () => {
  const { pdf, calls, automaticPages } = observedPdf('ru');
  pdf.line('Предыдущая часть отчёта');
  pdf.doc.y = pdf.doc.page.height - 120;
  pdf.table(['Участник', 'Клуб'], [['QA Әлихан\nСерікұлы', 'Алматы Judo\nКоманда QA']], [0.5, 0.5]);
  const head = calls.find((call) => call.value === 'Участник');
  const body = calls.find((call) => call.value.startsWith('QA Әлихан'));
  assert.equal(head.page, 2);
  assert.equal(body.page, head.page);
  assert.equal(automaticPages(), 0);
  await pdf.end();
});

test('landscape medal cells are measured using their printed numeric font', async () => {
  const { pdf, calls, automaticPages, pages } = observedPdf('kk', true);
  pdf.table(
    ['Орын', 'Команда', 'Алтын', 'Күміс', 'Қола', 'Барлығы'],
    Array.from({ length: 25 }, (_, i) => [
      String(i + 1),
      `QA ${i} · Қарағанды командасы`,
      '12345678901234567890',
      '0',
      '0',
      '12345678901234567890',
    ]),
    [0.09, 0.39, 0.13, 0.13, 0.13, 0.13],
    { medals: true },
  );
  assert.equal(automaticPages(), 0);
  assert.ok(pages.length > 1);
  const digits = calls.filter((call) => call.value === '12345678901234567890');
  assert.equal(digits.length, 50);
  assert.ok(digits.every((call) => call.fontSize === 13 && call.options.height >= 2 * 13));
  await pdf.end();
});

test('portrait draw pages retain every main, repechage and bronze bout, scores and complete names', async () => {
  const { renderDraw } = await import('../apps/api/dist/modules/protocols/render-draw.js');
  const { portraitCategory, portraitTournament } = await import('./fixtures/portrait-protocol.mjs');
  for (const lang of ['ru', 'kk']) {
    for (const count of [6, 7, 16, 128]) {
      for (const finished of [false, true]) {
        const category = portraitCategory(count, finished);
        const text = (ru, kk) => (lang === 'kk' ? kk : ru);
        const pdf = new ProtocolPdf(portraitTournament([category]), text, 'DRAW', lang);
        const pages = [],
          calls = [],
          violations = [];
        pdf.doc.on('pageAdded', () =>
          pages.push({ width: pdf.doc.page.width, height: pdf.doc.page.height }),
        );
        const original = pdf.doc.text;
        pdf.doc.text = function (value, x, y, options) {
          calls.push(String(value));
          const height = options?.width
            ? this.heightOfString(String(value), { width: options.width })
            : 0;
          if (
            String(value).includes('ТестовыйСпортсмен') ||
            String(value).startsWith('Тестовый клуб')
          ) {
            if (
              height > options.height + 0.1 ||
              x < 36 ||
              x + options.width > this.page.width - 35 ||
              y + height > this.page.height - 55
            )
              violations.push({ value, x, y, height, options });
          }
          return original.call(this, value, x, y, options);
        };
        renderDraw(pdf, category, 'QA');
        await pdf.end();
        assert.ok(
          pages.every((p) => p.width < p.height),
          `${count}/${lang}: portrait only`,
        );
        assert.deepEqual(violations, [], `${count}/${lang}: no clipped names or clubs`);
        assert.ok(pages.length > 1);
        for (const [i] of category.draw.snapshot.matches.entries())
          assert.ok(
            calls.some((label) => label.includes(`№ ${i + 1} ·`)),
            `missing bout ${i + 1}/${count}`,
          );
        if (finished) {
          assert.ok(
            calls.filter((label) => /^I \d+\s+W \d+\s+Y \d+\s+S \d+$/.test(label)).length >=
              category.draw.snapshot.matches.length * 2,
          );
          for (const entry of category.entries)
            assert.ok(calls.some((label) => label === `${entry.lastName} ${entry.firstName}`));
        }
      }
    }
  }
});
