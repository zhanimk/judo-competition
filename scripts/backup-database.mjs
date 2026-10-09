import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
    throw new Error('INVALID_DATABASE_IDENTIFIER');
  return '"' + value + '"';
}

export function postgresEnvironment(connection, base = process.env) {
  const url = new URL(connection);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_URL');
  // Ambient PGHOSTADDR/PGSERVICE/PGOPTIONS must not send the dump to a different server.
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('PG')));
  Object.assign(env, {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'judo-backup-verification',
  });
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  else if (base.PGPASSWORD) env.PGPASSWORD = base.PGPASSWORD;
  for (const [param, key] of Object.entries({
    sslmode: 'PGSSLMODE',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    sslrootcert: 'PGSSLROOTCERT',
    sslcrl: 'PGSSLCRL',
  }))
    if (url.searchParams.has(param)) env[key] = url.searchParams.get(param);
  return env;
}

export function assertDisposableDatabase(target, source) {
  if (!/^qa_restore_[a-f0-9]{32}$/.test(target) || target === source)
    throw new Error('UNSAFE_RESTORE_TARGET');
  return quoteIdentifier(target);
}

function hashStrings(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.value).update('\n');
  return hash.digest('hex');
}

export function compareManifests(source, restored) {
  return JSON.stringify(source) === JSON.stringify(restored);
}

async function run(file, args, env, output, name) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (part) => {
    stdout += part;
  });
  child.stderr.on('data', (part) => {
    stderr += part;
  });
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('close', (code) => resolve({ code }));
  });
  await writeFile(join(output, name + '.log'), stdout + stderr + (result.error?.stack ?? ''), {
    mode: 0o600,
  });
  if (result.code !== 0) throw new Error(name.toUpperCase() + '_FAILED');
  return stdout.trim();
}

async function manifest(tx, schema) {
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.$executeRawUnsafe('SET LOCAL extra_float_digits = 3');
  await tx.$executeRawUnsafe("SET LOCAL bytea_output = 'hex'");
  const sequences = await tx.$queryRaw`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relkind='S'
  `;
  // Sequences are not MVCC snapshots. The current UUID-based schema has none.
  if (sequences.length) throw new Error('SEQUENCE_VERIFICATION_NOT_SUPPORTED');
  const unsupported = await tx.$queryRaw`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relkind NOT IN ('r','i','t')
    UNION ALL
    SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=${schema}
    UNION ALL
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=${schema} AND t.typtype IN ('e','d','r','m')
    UNION ALL
    SELECT g.tgname AS name FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT g.tgisinternal
    UNION ALL
    SELECT c.collname AS name FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
    WHERE n.nspname=${schema}
  `;
  // Fail closed if future migrations add objects outside this verifier's current scope.
  if (unsupported.length) throw new Error('SCHEMA_OBJECT_VERIFICATION_NOT_SUPPORTED');
  const tables = await tx.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=${schema} AND table_type='BASE TABLE' ORDER BY table_name COLLATE "C"
  `;
  if (!tables.length) throw new Error('EMPTY_APPLICATION_SCHEMA');
  const data = [];
  for (const { table_name: name } of tables) {
    const fields = await tx.$queryRaw`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=${schema} AND table_name=${name} ORDER BY ordinal_position
    `;
    const nullFlags = fields.map(({ column_name: field }) => `t.${quoteIdentifier(field)} IS NULL`);
    // JSON conversion alone conflates SQL NULL and a JSON/JSONB literal null.
    const representation = `jsonb_build_object('data', to_jsonb(t), 'sqlNulls', ARRAY[${nullFlags.join(', ')}])::text`;
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${representation} AS value FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)} t ORDER BY ${representation} COLLATE "C"`,
    );
    // Hash PostgreSQL's exact text, preserving microseconds, arrays and large numbers.
    data.push({ name, rows: rows.length, sha256: hashStrings(rows) });
  }
  const columns = await tx.$queryRaw`
    SELECT to_jsonb(t)::text AS value FROM (
      SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,
             udt_schema,udt_name,character_maximum_length,character_octet_length,
             numeric_precision,numeric_precision_radix,numeric_scale,datetime_precision,
             interval_type,interval_precision,collation_schema,collation_name,
             domain_schema,domain_name,is_identity,identity_generation,
             identity_start,identity_increment,identity_maximum,identity_minimum,identity_cycle,
             is_generated,generation_expression
      FROM information_schema.columns WHERE table_schema=${schema}
      ORDER BY table_name COLLATE "C",ordinal_position
    ) t
  `;
  const constraints = await tx.$queryRaw`
    SELECT to_jsonb(t)::text AS value FROM (
      SELECT c.relname AS table_name,k.conname,k.contype,k.convalidated,
             pg_get_constraintdef(k.oid,false) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema}
      ORDER BY c.relname COLLATE "C",k.conname COLLATE "C"
    ) t
  `;
  const indexes = await tx.$queryRaw`
    SELECT to_jsonb(t)::text AS value FROM (
      SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=${schema}
      ORDER BY tablename COLLATE "C",indexname COLLATE "C"
    ) t
  `;
  return {
    schema,
    tables: data,
    structure: {
      columns: hashStrings(columns),
      constraints: hashStrings(constraints),
      indexes: hashStrings(indexes),
    },
  };
}

async function writePrivateJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

/** Read the working database, restore only into a newly generated disposable database. */
export async function createVerifiedBackup(sourceUrl, { outputRoot = 'tmp/backups' } = {}) {
  const connection = new URL(sourceUrl);
  const schema = connection.searchParams.get('schema') ?? 'public';
  quoteIdentifier(schema);
  const sourceName = decodeURIComponent(connection.pathname.slice(1));
  const targetName = 'qa_restore_' + randomUUID().replaceAll('-', '');
  const targetIdentifier = assertDisposableDatabase(targetName, sourceName);
  const output = join(
    outputRoot,
    'verified-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const dumpPath = join(output, 'database.dump');
  // Reserve a private file before pg_dump opens it.
  await writeFile(dumpPath, '', { mode: 0o600, flag: 'wx' });
  const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = '/postgres';
  maintenanceUrl.searchParams.set('schema', 'public');
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl.href } } });
  const restoredUrl = new URL(sourceUrl);
  restoredUrl.pathname = '/' + targetName;
  const restored = new PrismaClient({ datasources: { db: { url: restoredUrl.href } } });
  const env = postgresEnvironment(sourceUrl);
  const report = {
    startedAt: new Date().toISOString(),
    passed: false,
    output,
    dumpPath,
    schema,
    verificationDatabase: targetName,
    verificationDatabaseRemoved: false,
  };
  let created = false;
  try {
    const versions = await Promise.all([
      run('pg_dump', ['--version'], env, output, 'pg-dump-version'),
      run('pg_restore', ['--version'], env, output, 'pg-restore-version'),
    ]);
    const [{ version }] =
      await source.$queryRaw`SELECT current_setting('server_version_num') AS version`;
    const serverMajor = Math.floor(Number(version) / 10000);
    const dumpMajor = Number(versions[0].match(/PostgreSQL\) (\d+)/)?.[1]);
    const restoreMajor = Number(versions[1].match(/PostgreSQL\) (\d+)/)?.[1]);
    if (!dumpMajor || dumpMajor !== serverMajor || restoreMajor !== dumpMajor)
      throw new Error('INCOMPATIBLE_POSTGRES_TOOLS');
    report.versions = { server: version, dump: versions[0], restore: versions[1] };
    let original;
    await source.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const [{ snapshot }] = await tx.$queryRaw`SELECT pg_export_snapshot() AS snapshot`;
        original = await manifest(tx, schema);
        await run(
          'pg_dump',
          ['--format=custom', '--schema=' + schema, '--snapshot=' + snapshot, '--file=' + dumpPath],
          env,
          output,
          'pg-dump',
        );
      },
      { isolationLevel: 'RepeatableRead', timeout: 150000 },
    );
    await chmod(dumpPath, 0o600);
    report.dumpBytes = (await stat(dumpPath)).size;
    report.dumpSha256 = createHash('sha256')
      .update(await readFile(dumpPath))
      .digest('hex');
    await writePrivateJson(join(output, 'source-manifest.json'), original);
    const toc = await run('pg_restore', ['--list', dumpPath], env, output, 'archive-list');
    if (!toc.split('\n').some((line) => line.includes(' SCHEMA - ' + schema + ' ')))
      throw new Error('ARCHIVE_SCHEMA_MISSING');
    await admin.$executeRawUnsafe(`CREATE DATABASE ${targetIdentifier} TEMPLATE template0`);
    created = true;
    const [{ name }] = await restored.$queryRaw`SELECT current_database() AS name`;
    if (name !== targetName || name === sourceName) throw new Error('UNSAFE_RESTORE_TARGET');
    if (schema === 'public') {
      const [{ count }] = await restored.$queryRaw`
        SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
      `;
      if (count !== 0) throw new Error('RESTORE_TARGET_NOT_EMPTY');
      await restored.$executeRawUnsafe('DROP SCHEMA public RESTRICT');
    }
    await run(
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--dbname=' + targetName,
        dumpPath,
      ],
      { ...env, PGDATABASE: targetName },
      output,
      'pg-restore',
    );
    const recovered = await restored.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return manifest(tx, schema);
      },
      { isolationLevel: 'RepeatableRead', timeout: 60000 },
    );
    await writePrivateJson(join(output, 'restored-manifest.json'), recovered);
    if (!compareManifests(original, recovered)) throw new Error('RESTORED_DATA_MISMATCH');
    report.tables = original.tables.map(({ name, rows }) => ({ name, rows, matched: true }));
    report.schemaStructureMatched = true;
    report.passed = true;
  } catch (error) {
    // Database diagnostics may contain connection details; only codes enter the public report.
    report.error = /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'BACKUP_VERIFICATION_FAILED';
    await writeFile(join(output, 'failure.log'), error.stack ?? String(error), { mode: 0o600 });
  } finally {
    await source.$disconnect();
    await restored.$disconnect();
    try {
      if (created) {
        assertDisposableDatabase(targetName, sourceName);
        await admin.$executeRawUnsafe(`DROP DATABASE ${targetIdentifier}`);
        report.verificationDatabaseRemoved = true;
      }
    } catch {
      report.passed = false;
      report.error = 'VERIFICATION_DATABASE_CLEANUP_FAILED';
    } finally {
      await admin.$disconnect();
    }
    report.finishedAt = new Date().toISOString();
    await writePrivateJson(join(output, 'report.json'), report);
  }
  return report;
}
