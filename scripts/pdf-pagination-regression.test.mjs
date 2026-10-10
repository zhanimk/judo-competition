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
