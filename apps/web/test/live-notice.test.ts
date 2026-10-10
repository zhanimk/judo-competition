import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validLiveNotice } from '../src/shared/live/subscribe.ts';

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
test('LIVE metadata validation preserves bigint cursors and all invalidation scopes', () => {
  for (const kind of [
    'state',
    'result',
    'queue',
    'roster',
    'protocol',
    'access',
    'connected',
    'resync',
  ])
    assert.equal(validLiveNotice({ kind, tournamentId: id, cursor: '9007199254740993' }, id), true);
  assert.equal(validLiveNotice({ kind: 'resync', tournamentId: id, cursor: '0' }, id), true);
});
test('foreign streams, malformed cursor packets and unknown events cannot invalidate a view', () => {
  for (const value of [
    null,
    [],
    {},
    { kind: 'secret', tournamentId: id },
    { kind: 'state', tournamentId: 'foreign' },
    { kind: 'state', tournamentId: id, tatamiId: 'invalid' },
    ...[5, '-1', '00', '1.5', '9223372036854775808'].map((cursor) => ({
      kind: 'result',
      tournamentId: id,
      cursor,
    })),
  ])
    assert.equal(validLiveNotice(value, id), false);
});
