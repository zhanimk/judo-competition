import assert from 'node:assert/strict';
import test from 'node:test';
import { activeEntryCount, startReadiness } from '../src/features/tournaments/start-readiness.ts';
import type { Category } from '../src/features/tournaments/types.ts';

const category = (id: string, count: number, status?: string): Category => ({
  id,
  name: id,
  gender: 'MALE',
  format: 'REPECHAGE',
  birthYearFrom: 2012,
  birthYearTo: 2013,
  maxWeightGrams: 50000,
  durationSeconds: 180,
  _count: { entries: count },
  draw: status ? { status, publishedAt: null, _count: { contests: 1 } } : null,
});

test('confirmed active categories can start beside unused templates', () => {
  const result = startReadiness([category('empty', 0), category('ready', 4, 'CONFIRMED')]);
  assert.equal(result.ready, true);
  assert.deepEqual(
    result.empty.map((c) => c.id),
    ['empty'],
  );
  assert.deepEqual(
    result.active.map((c) => c.id),
    ['ready'],
  );
});

test('no entries never starts an empty tournament or invents medalists', () => {
  assert.equal(startReadiness([]).ready, false);
  assert.equal(startReadiness([category('empty', 0, 'CONFIRMED')]).ready, false);
});

test('a sole entrant still requires an explicit opponent, even with a saved draw', () => {
  const result = startReadiness([category('sole', 1, 'CONFIRMED')]);
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.single.map((c) => c.id),
    ['sole'],
  );
});

test('changed or preliminary draws block populated categories', () => {
  const result = startReadiness([category('stale', 3, 'STALE'), category('preview', 2, 'PREVIEW')]);
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.unconfirmed.map((c) => c.id),
    ['stale', 'preview'],
  );
});

test('archived entrants do not keep an unused category active', () => {
  const empty = category('archive', 1);
  empty.entries = [
    { id: 'old', firstName: 'QA', lastName: 'QA', club: 'QA', archivedAt: '2026-10-10' },
  ];
  assert.equal(activeEntryCount(empty), 0);
  assert.deepEqual(
    startReadiness([empty]).empty.map((c) => c.id),
    ['archive'],
  );
});
