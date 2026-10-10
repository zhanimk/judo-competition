import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { pdfText, readPdfKitObjects } from '../pdf-text.mjs';

function streamObject(
  id,
  data,
  separator = '\n',
  length = String(data.length),
  filter = '/FlateDecode',
) {
  return Buffer.concat([
    Buffer.from(
      `${id} 0 obj${separator}<< /Length ${length}${filter ? ` /Filter ${filter}` : ''} >>${separator}stream${separator}`,
      'latin1',
    ),
    data,
    Buffer.from(`${separator}endstream${separator}endobj${separator}`, 'latin1'),
  ]);
}
const document = (...objects) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), ...objects, Buffer.from('%%EOF\n')]);

test('a valid compressed stream ending in CR survives LF and CRLF endstream separators intact', () => {
  let data, expected;
  for (let i = 0; i < 256; i++) {
    expected = 'binary payload ' + 'a'.repeat(i);
    data = deflateSync(Buffer.from(expected));
    if (data.at(-1) === 0x0d) break;
  }
  assert.equal(
    data.at(-1),
    0x0d,
    'fixture has the binary terminal CR that caused the real failure',
  );
  const lf = document(streamObject(1, data));
  const legacy = lf.toString('latin1').match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  assert.equal(Buffer.from(legacy[1], 'latin1').length, data.length - 1);
  assert.throws(() => inflateSync(Buffer.from(legacy[1], 'latin1')), /unexpected end|buffer/i);
  for (const separator of ['\n', '\r\n'])
    assert.equal(
      readPdfKitObjects(document(streamObject(1, data, separator))).get('1').text,
      expected,
    );
});

test('declared stream length keeps binary object/endstream markers from becoming PDF delimiters', () => {
  const raw = Buffer.from('BT\nendstream\nendobj\n999 0 obj\nnot an object\r', 'latin1');
  const objects = readPdfKitObjects(
    document(
      streamObject(1, raw, '\n', String(raw.length), ''),
      streamObject(2, deflateSync(Buffer.from('second adjacent object'))),
    ),
  );
  assert.deepEqual([...objects.keys()], ['1', '2']);
  assert.equal(objects.get('1').text, raw.toString('latin1'));
  assert.equal(objects.get('2').text, 'second adjacent object');
});

test('unsupported lengths, wrong boundaries, filters and corrupt compressed bytes fail explicitly', () => {
  const data = deflateSync(Buffer.from('valid data'));
  assert.throws(
    () => readPdfKitObjects(document(streamObject(1, data, '\n', '2 0 R'))),
    /direct \/Length/,
  );
  assert.throws(
    () => readPdfKitObjects(document(streamObject(1, data, '\n', String(data.length - 1)))),
    /length does not match/,
  );
  assert.throws(
    () =>
      readPdfKitObjects(
        document(streamObject(1, data, '\n', String(data.length), '/ASCIIHexDecode')),
      ),
    /unsupported PDF text stream filter/,
  );
  assert.throws(
    () => readPdfKitObjects(document(streamObject(1, Buffer.from('corrupt compressed bytes')))),
    /incorrect header|data|inflate/i,
  );
});

test('embedded JPEG images retain exact stream boundaries without being decoded as participant text', () => {
  const raw = Buffer.from([0xff, 0xd8, 0x0d]);
  const image = streamObject(1, raw, '\n', String(raw.length), '/DCTDecode')
    .toString('latin1')
    .replace('<< /Length', '<< /Subtype /Image /Length');
  const objects = readPdfKitObjects(document(Buffer.from(image, 'latin1')));
  assert.match(objects.get('1').body, /\/DCTDecode/);
  assert.equal(objects.get('1').text, '');
});

function identityDocument(repetitions) {
  const cmap = Buffer.from('begincmap\n<0001> <0001> [<0410>]\nendcmap');
  const content = Buffer.from(`BT /F1 10 Tf <${'0001'.repeat(repetitions)}> Tj ET`);
  return document(
    Buffer.from(
      '1 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 2 0 R >>\nendobj\n',
    ),
    streamObject(2, deflateSync(cmap)),
    Buffer.from('3 0 obj\n<< /Font << /F1 1 0 R >> >>\nendobj\n'),
    streamObject(4, deflateSync(content)),
  );
}

test('Identity-H extraction still requires positive decoded text before roster absence checks', () => {
  assert.equal(pdfText(identityDocument(101)), 'А'.repeat(101));
  assert.throws(
    () => pdfText(identityDocument(1)),
    /participant PDF text must actually be decoded/,
  );
  assert.throws(
    () => pdfText(document(streamObject(1, deflateSync(Buffer.from('BT unsupported font ET'))))),
    /participant PDF text must actually be decoded/,
  );
});
