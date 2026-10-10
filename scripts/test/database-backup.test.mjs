import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  postgresEnvironment,
  assertDisposableDatabase,
  quoteIdentifier,
  compareManifests,
} from '../backup-database.mjs';

test('backup connection strips Prisma options and stale routing without exposing its password in args', () => {
  const env = postgresEnvironment(
    'postgresql://judge:p%40ss%3Aword@127.0.0.1:5432/judo?schema=public&connection_limit=5&sslmode=require',
    {
      PATH: '/usr/bin',
      PGHOSTADDR: 'malicious-host',
      PGSERVICE: 'other-db',
      PGOPTIONS: '-c search_path=wrong',
      PGDATABASE: 'wrong',
    },
  );
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGDATABASE, 'judo');
  assert.equal(env.PGUSER, 'judge');
  assert.equal(env.PGPASSWORD, 'p@ss:word');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGHOSTADDR, undefined);
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGOPTIONS, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('restore guard permits only generated QA names and never the source database', () => {
  const generated = 'qa_restore_' + 'a'.repeat(32);
  assert.equal(assertDisposableDatabase(generated, 'judo'), '"' + generated + '"');
  for (const target of [
    'judo',
    'postgres',
    'qa_restore_working',
    generated + '; DROP DATABASE judo',
  ])
    assert.throws(() => assertDisposableDatabase(target, 'judo'), /UNSAFE_RESTORE_TARGET/);
  assert.throws(() => assertDisposableDatabase(generated, generated), /UNSAFE_RESTORE_TARGET/);
  assert.throws(
    () => quoteIdentifier('public"; DROP TABLE "Contest'),
    /INVALID_DATABASE_IDENTIFIER/,
  );
});

test('verification fails on a missing table, changed saved timer or changed unique index even with equal counts', () => {
  const source = {
    schema: 'public',
    tables: [{ name: 'Contest', rows: 2, sha256: 'saved-running-clock' }],
    structure: { indexes: 'one-active-per-tatami' },
  };
  assert.equal(compareManifests(source, structuredClone(source)), true);
  assert.equal(compareManifests(source, { ...source, tables: [] }), false);
  assert.equal(
    compareManifests(source, {
      ...source,
      tables: [{ name: 'Contest', rows: 2, sha256: 'changed-clock' }],
    }),
    false,
  );
  assert.equal(
    compareManifests(source, { ...source, structure: { indexes: 'missing-unique-index' } }),
    false,
  );
});

test('live sequence gaps are safe but restore must never reuse an outbox ID', () => {
  const sequence = {
    name: 'LiveOutbox_id_seq',
    increment: '1',
    maximum: '9223372036854775807',
    ownerTable: 'LiveOutbox',
    ownerColumn: 'id',
    maximumReferencedValue: '9007199254740995',
    lastValue: '9007199254740995',
    isCalled: true,
  };
  const source = { schema: 'public', tables: [], sequences: [sequence], structure: {} };
  const copy = (changes) => ({ ...source, sequences: [{ ...sequence, ...changes }] });
  assert.equal(compareManifests(source, copy({ lastValue: '9007199254742000' })), true);
  assert.equal(
    compareManifests(source, copy({ lastValue: '9007199254740995', isCalled: false })),
    false,
  );
  assert.equal(compareManifests(source, copy({ lastValue: '9007199254740994' })), false);
  assert.equal(compareManifests(source, copy({ increment: '2' })), false);
  assert.equal(compareManifests(source, { ...source, sequences: [] }), false);
});
