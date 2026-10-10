import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceCategoryLoads } from '../src/draw/index.ts';
test('category balancing counts every bout and never splits or moves a pinned category', () => {
  const categories = [
    { id: 'a', matches: 7 },
    { id: 'b', matches: 7 },
    { id: 'c', matches: 3 },
    { id: 'd', matches: 3 },
  ];
  const plan = balanceCategoryLoads(categories, ['one', 'two']);
  assert.deepEqual(
    plan.loads.map((m) => m.matches),
    [10, 10],
  );
  assert.equal(plan.assignments.length, 4);
  assert.equal(new Set(plan.assignments.map((a) => a.categoryId)).size, 4);
  assert.deepEqual(
    balanceCategoryLoads([...categories].reverse(), ['one', 'two']).loads,
    plan.loads,
  );
  const fixed = balanceCategoryLoads(
    [{ id: 'fixed', matches: 30, tatamiId: 'one' }, ...categories],
    ['one', 'two'],
  );
  assert.equal(fixed.assignments.find((a) => a.categoryId === 'fixed')!.tatamiId, 'one');
  assert.deepEqual(
    fixed.loads.map((m) => m.matches),
    [30, 20],
  );
  assert.equal(
    balanceCategoryLoads([{ id: 'done', matches: 0, tatamiId: 'two' }], ['one', 'two'])
      .assignments[0].tatamiId,
    'two',
  );
  assert.equal(balanceCategoryLoads(categories, ['one']).loads[0].matches, 20);
  assert.deepEqual(
    categories.map((c) => c.matches),
    [7, 7, 3, 3],
  );
});
test('invalid category loads and foreign fixed tatamis are rejected', () => {
  assert.throws(() => balanceCategoryLoads([], []));
  assert.throws(() =>
    balanceCategoryLoads([{ id: 'a', matches: 2, tatamiId: 'foreign' }], ['one']),
  );
  assert.throws(() => balanceCategoryLoads([{ id: 'a', matches: -1 }], ['one']));
  assert.throws(() =>
    balanceCategoryLoads(
      [
        { id: 'a', matches: 2 },
        { id: 'a', matches: 2 },
      ],
      ['one'],
    ),
  );
});

test('tatami order is by round, youngest age group, lightest weight; queue position cannot bypass a round', async () => {
  const { compareScheduledBouts } = await import('../src/draw/index.ts');
  const base = {
    birthYearFrom: 2014,
    birthYearTo: 2015,
    maxWeightGrams: 30000,
    round: 1,
    categoryId: 'a',
    queueOrder: 1,
    key: 'r1-m1',
  };
  const rows = [
    { ...base, categoryId: 'older', birthYearFrom: 2012, birthYearTo: 2013, maxWeightGrams: 20000 },
    { ...base, categoryId: 'heavy', maxWeightGrams: 40000 },
    { ...base, categoryId: 'open', maxWeightGrams: null },
    { ...base, categoryId: 'young', birthYearFrom: 2016, birthYearTo: 2017, maxWeightGrams: 50000 },
    { ...base, categoryId: 'round2', round: 2, queueOrder: 0 },
    { ...base, categoryId: 'light' },
  ];
  assert.deepEqual(
    rows.sort(compareScheduledBouts).map((r) => r.categoryId),
    ['young', 'light', 'heavy', 'open', 'older', 'round2'],
  );
});

test('different open weight lower bounds sort by weight before category identifiers', async () => {
  const { compareScheduledBouts } = await import('../src/draw/index.ts');
  const base = {
    round: 1,
    birthYearFrom: 2014,
    birthYearTo: 2015,
    maxWeightGrams: null,
    queueOrder: 1,
    key: 'r1-m1',
  };
  const rows = [
    { ...base, categoryId: 'a-heavy', minWeightGrams: 70000 },
    { ...base, categoryId: 'z-light', minWeightGrams: 30000 },
    { ...base, categoryId: 'bounded', maxWeightGrams: 90000, minWeightGrams: null },
  ];
  assert.deepEqual(
    rows.sort(compareScheduledBouts).map((row) => row.categoryId),
    ['bounded', 'z-light', 'a-heavy'],
  );
});
