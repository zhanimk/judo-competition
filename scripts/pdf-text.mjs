import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// Test-only reader for the direct /Length streams emitted by our PDFKit renderer.
// Binary data must never be delimited by a newline/endstream regular expression.
export function readPdfKitObjects(bytes) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const source = bytes.toString('latin1');
  const headers = /^(\d+) (\d+) obj\r?\n/gm;
  const objects = new Map();
  let match;
  while ((match = headers.exec(source))) {
    assert.equal(match[2], '0', 'unsupported PDF object generation');
    const bodyStart = headers.lastIndex;
    const marker = /\r?\n(stream|endobj)(?:\r?\n|$)/g;
    marker.lastIndex = bodyStart;
    const end = marker.exec(source);
    assert.ok(end, 'unterminated PDFKit object');
    const body = source.slice(bodyStart, end.index);
    let text = '';
    if (end[1] === 'stream') {
      const lengths = [...body.matchAll(/\/Length\s+(\d+)(?=\s*(?:\/|>>|$))/g)];
      assert.equal(lengths.length, 1, 'unsupported PDF stream length: expected one direct /Length');
      const length = Number(lengths[0][1]);
      assert.ok(Number.isSafeInteger(length), 'invalid PDF stream length');
      const start = marker.lastIndex;
      const finish = start + length;
      assert.ok(finish <= bytes.length, 'truncated PDF stream');
      const trailer = /^(?:\r?\n)endstream(?:\r?\n)endobj(?:\r?\n|$)/.exec(source.slice(finish));
      assert.ok(trailer, 'PDF stream length does not match endstream boundary');
      assert.ok(!/\/Type\s+\/(?:ObjStm|XRef)\b/.test(body), 'unsupported PDF object stream');
      // Embedded brand images (PDFKit JPEG /DCTDecode) are binary assets, not text.
      if (!/\/Subtype\s+\/Image\b/.test(body)) {
        const flate = /\/Filter\s+\/FlateDecode(?=\s*(?:\/|>>|$))/.test(body);
        assert.ok(!/\/Filter\b/.test(body) || flate, 'unsupported PDF text stream filter');
        const data = bytes.subarray(start, finish);
        // Corrupt compressed text remains a test failure; never swallow inflate errors.
        text = (flate ? inflateSync(data) : data).toString('latin1');
      }
      headers.lastIndex = finish + trailer[0].length;
    } else headers.lastIndex = marker.lastIndex;
    assert.ok(!objects.has(match[1]), 'duplicate PDF object');
    objects.set(match[1], { body, text });
  }
  assert.ok(objects.size > 0, 'unsupported PDF: no PDFKit objects found');
  return objects;
}

// Decode only the Type0/Identity-H + ToUnicode format emitted by our PDFKit renderer.
// Positive controls prevent an unsupported format from passing an absence check.
export function pdfText(bytes) {
  const objects = readPdfKitObjects(bytes);
  const maps = new Map();
  for (const [id, object] of objects) {
    if (!object.text.includes('begincmap')) continue;
    const codes = new Map();
    for (const range of object.text.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]+)\]/gi)) {
      let index = parseInt(range[1], 16);
      for (const encoded of range[3].matchAll(/<([^>]+)>/g)) {
        const hex = encoded[1].replace(/\s/g, '');
        const value = [...hex.matchAll(/.{4}/g)]
          .map((unit) => String.fromCharCode(parseInt(unit[0], 16)))
          .join('');
        codes.set(index++, value);
      }
    }
    maps.set(id, codes);
  }
  const fontObjects = new Map();
  for (const [id, object] of objects) {
    const ref = object.body.match(/\/ToUnicode\s+(\d+) 0 R/);
    if (ref) fontObjects.set(id, maps.get(ref[1]));
  }
  const fonts = new Map();
  for (const object of objects.values())
    for (const ref of object.body.matchAll(/\/(F\d+)\s+(\d+) 0 R/g))
      if (fontObjects.has(ref[2])) fonts.set(ref[1], fontObjects.get(ref[2]));
  let result = '';
  for (const object of objects.values()) {
    if (!object.text.includes('BT')) continue;
    let font;
    for (const token of object.text.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-f]+)>/gi)) {
      if (token[1]) font = fonts.get(token[1]);
      else if (font)
        result += [...token[2].matchAll(/.{4}/g)]
          .map((unit) => font.get(parseInt(unit[0], 16)) ?? '')
          .join('');
    }
  }
  assert.ok(result.length > 100, 'participant PDF text must actually be decoded');
  return result;
}
