import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireCompetitionCategories } from '../apps/api/dist/modules/tournaments/active-categories.js';
import { scheduleCategories } from '../apps/api/dist/modules/tournaments/scheduling.js';
import { protocolScope } from '../apps/api/dist/modules/protocols/protocol-scope.js';
import { ProtocolsService } from '../apps/api/dist/modules/protocols/protocols.service.js';

const category = (id, count, status = null) => ({
  id,
  name: id,
  _count: { entries: count },
  draw: status ? { status, contests: [] } : null,
});
const conflict = (code) => (error) => error.getStatus() === 409 && error.message === code;

test('empty and archived-only configurations remain immutable and do not require draws', () => {
  const rows = [
    category('empty', 0),
    category('archived', 0, 'STALE'),
    category('active', 2, 'CONFIRMED'),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(requireCompetitionCategories(rows), [rows[2]]);
  assert.deepEqual(rows, before);
});

test('a tournament without active categories cannot start or be scheduled', () => {
  for (const rows of [[], [category('empty', 0)], [category('archived', 0, 'STALE')]])
    assert.throws(() => requireCompetitionCategories(rows), conflict('NO_ACTIVE_CATEGORIES'));
});

test('single admissions name every category requiring an opponent before draw checks', () => {
  const rows = [
    category('first', 1),
    category('needs-draw', 2),
    category('second', 1),
    category('empty', 0),
  ];
  assert.throws(
    () => requireCompetitionCategories(rows),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), {
        message: 'CATEGORY_NEEDS_OPPONENT',
        categories: [
          { id: 'first', name: 'first' },
          { id: 'second', name: 'second' },
        ],
      });
      return true;
    },
  );
});

test('every populated category still requires a current confirmed draw', () => {
  for (const status of [null, 'PREVIEW', 'STALE'])
    assert.throws(
      () => requireCompetitionCategories([category('active', 2, status)]),
      conflict('ALL_DRAWS_REQUIRED'),
    );
});

test('scheduling locks tatamis before checking the live administrator and mutates only active categories', async () => {
  const user = {
    id: 'owner',
    sessionId: 'session',
    role: 'ORGANIZER',
    name: 'Owner',
    tatamiId: null,
  };
  const rows = [
    category('empty', 0),
    category('archived', 0, 'STALE'),
    category('active', 2, 'CONFIRMED'),
  ];
  const queries = [],
    writes = [];
  const tx = {
    $queryRaw: async (strings) => {
      queries.push(strings.join(''));
      return [];
    },
    session: {
      findUnique: async () => ({
        id: user.sessionId,
        userId: user.id,
        user: { id: user.id, role: user.role },
        expiresAt: new Date('2099-01-01'),
      }),
    },
    tournament: {
      findUnique: async () => ({ id: 'tournament', ownerId: user.id }),
      findUniqueOrThrow: async () => ({
        id: 'tournament',
        categories: rows,
        tatamis: [{ id: 'mat' }],
      }),
    },
    contest: { aggregate: async () => ({ _max: { queueOrder: null } }) },
    category: { update: async ({ where }) => writes.push(where.id) },
    drawCommand: { findFirst: async () => null },
    protocolCommand: { findFirst: async () => null },
    liveOutbox: { create: async () => ({ id: 1n }) },
    auditEvent: { create: async () => {} },
  };
  const plan = await scheduleCategories(tx, 'tournament', user);
  assert.deepEqual(plan.assignments, [{ categoryId: 'active', tatamiId: 'mat' }]);
  assert.deepEqual(writes, ['active']);
  assert.ok(queries[0].includes('FROM "Tatami"'));
  assert.ok(queries[1].includes('FROM "Session"'));
  writes.length = 0;
  tx.session.findUnique = async () => null;
  await assert.rejects(
    scheduleCategories(tx, 'tournament', user),
    (error) => error.getStatus() === 401,
  );
  assert.deepEqual(writes, []);
});

test('draw PDF scope ignores empty stale snapshots but still blocks stale populated draws', () => {
  const empty = { entries: [], draw: { status: 'STALE' } };
  const active = { entries: [{ id: 'entry' }], draw: { status: 'CONFIRMED' } };
  assert.deepEqual(protocolScope([empty, active], 'DRAW'), [active]);
  assert.throws(() => protocolScope([empty], 'DRAW'), conflict('NO_ACTIVE_CATEGORIES'));
  assert.throws(
    () => protocolScope([{ ...active, draw: { status: 'STALE' } }], 'DRAW'),
    conflict('DRAW_ENTRIES_CHANGED'),
  );
  const all = [empty, active];
  assert.equal(protocolScope(all, 'PARTICIPANTS'), all);
});

test('PDF validates every selected category ID before filtering an empty category', async () => {
  const db = {
    $transaction: (callback) =>
      callback({
        tournament: {
          findUniqueOrThrow: async () => ({
            categories: [{ id: 'empty', entries: [], draw: { status: 'STALE' } }],
          }),
        },
      }),
  };
  const service = new ProtocolsService(db, { owner: async () => {} });
  await assert.rejects(
    service.create('tournament', undefined, 'ru', {}, 'DRAW', ['empty', 'foreign']),
    (error) => error.getStatus() === 404 && error.message === 'CATEGORY_NOT_FOUND',
  );
  await assert.rejects(
    service.create('tournament', 'empty', 'ru', {}, 'DRAW'),
    conflict('NO_ACTIVE_CATEGORIES'),
  );
});
