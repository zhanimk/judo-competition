import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportCategories,
  exportEntryCount,
  exportSelection,
} from '../src/features/draws/protocol-scope.ts';

const categories = [
  { id: 'empty', name: 'Empty', _count: { entries: 0 } },
  {
    id: 'archived',
    name: 'Archived',
    _count: { entries: 2 },
    entries: [{ archivedAt: '2026-10-10' }],
  },
  { id: 'active', name: 'Active', entries: [{ archivedAt: null }] },
];
test('draw exports omit empty and archived-only configurations without changing the source', () => {
  const before = structuredClone(categories);
  assert.deepEqual(
    exportCategories(categories, 'DRAW').map((category) => category.id),
    ['active'],
  );
  assert.deepEqual(categories, before);
  assert.equal(exportEntryCount(categories[1]), 0);
});
test('participant exports keep empty category choices and explicit selection', () => {
  assert.equal(exportCategories(categories, 'PARTICIPANTS'), categories);
  assert.deepEqual(exportSelection(categories, 'PARTICIPANTS', ['empty', 'archived']), [
    'empty',
    'archived',
  ]);
});
test('draw selection never submits a disabled empty, archived or absent category', () => {
  const selected = ['empty', 'archived', 'active', 'missing'];
  assert.deepEqual(exportSelection(categories, 'DRAW', selected), ['active']);
  assert.deepEqual(selected, ['empty', 'archived', 'active', 'missing']);
});
test('team standings use only participating categories for both all and selected scopes', () => {
  assert.deepEqual(
    exportCategories(categories, 'TEAMS').map((category) => category.id),
    ['active'],
  );
  assert.deepEqual(exportSelection(categories, 'TEAMS', ['empty', 'archived', 'active']), [
    'active',
  ]);
});
