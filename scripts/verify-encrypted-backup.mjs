import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertDisposableDatabase,
  compareManifests,
  databaseManifest,
  postgresEnvironment,
  quoteIdentifier,
} from './backup-database.mjs';
import { backupFileHash, decryptBackupFile, readBackupKey } from './backup-encryption.mjs';

async function run(file, args, env, output, name) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (part) => {
    if (stdout.length < 65536) stdout += part;
  });
  child.stderr.on('data', (part) => {
    if (stderr.length < 65536) stderr += part;
  });
  const result = await new Promise((resolve) => {
    child.once('error', () => resolve({ code: 1 }));
    child.once('close', (code) => resolve({ code }));
  });
  await writeFile(join(output, name + '.log'), stdout + stderr, { mode: 0o600, flag: 'wx' });
  if (result.code !== 0) throw new Error(name.toUpperCase() + '_FAILED');
  return stdout;
}

/** Decrypt an exported envelope and prove its saved snapshot in a newly created QA database. */
export async function verifyEncryptedBackup(
  sourceUrl,
  { input, keyFile, outputRoot = 'tmp/encrypted-backup-verification' },
) {
  const connection = new URL(sourceUrl),
    sourceName = decodeURIComponent(connection.pathname.slice(1)),
    targetName = 'qa_restore_' + randomUUID().replaceAll('-', ''),
    targetIdentifier = assertDisposableDatabase(targetName, sourceName);
  const output = join(outputRoot, 'decrypt-restore-' + randomUUID());
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const decrypted = join(output, 'decrypted.dump');
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = '/postgres';
  maintenanceUrl.searchParams.set('schema', 'public');
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl.href } } });
  let restored,
    created = false,
    key;
  const report = {
    passed: false,
    encryptedPath: input,
    output,
    verificationDatabase: targetName,
    verificationDatabaseRemoved: false,
    plaintextRemoved: false,
    startedAt: new Date().toISOString(),
  };
  try {
    key = await readBackupKey(keyFile);
    const metadata = await decryptBackupFile(input, decrypted, key);
    const original = metadata.manifest;
    if (!original || !Array.isArray(original.tables) || !original.tables.length)
      throw new Error('BACKUP_SOURCE_MANIFEST_REQUIRED');
    const schema = original.schema;
    quoteIdentifier(schema);
    report.dumpSha256 = metadata.dumpSha256;
    report.dumpBytes = metadata.dumpBytes;
    report.encryptedSha256 = (await backupFileHash(input)).sha256;
    const env = postgresEnvironment(sourceUrl),
      version = await run('pg_restore', ['--version'], env, output, 'pg-restore-version');
    const [{ server }] =
      await admin.$queryRaw`SELECT current_setting('server_version_num') AS server`;
    if (Number(version.match(/PostgreSQL\) (\d+)/)?.[1]) !== Math.floor(Number(server) / 10000))
      throw new Error('INCOMPATIBLE_POSTGRES_TOOLS');
    await admin.$executeRawUnsafe(`CREATE DATABASE ${targetIdentifier} TEMPLATE template0`);
    created = true;
    const restoredUrl = new URL(sourceUrl);
    restoredUrl.pathname = '/' + targetName;
    restoredUrl.searchParams.set('schema', schema);
    restored = new PrismaClient({ datasources: { db: { url: restoredUrl.href } } });
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
        decrypted,
      ],
      { ...env, PGDATABASE: targetName },
      output,
      'pg-restore',
    );
    const recovered = await restored.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return databaseManifest(tx, schema);
      },
      { isolationLevel: 'RepeatableRead', timeout: 60000 },
    );
    if (!compareManifests(original, recovered)) throw new Error('RESTORED_DATA_MISMATCH');
    report.tables = original.tables.map(({ name, rows }) => ({ name, rows, matched: true }));
    report.schemaStructureMatched = true;
    report.passed = true;
  } catch (error) {
    report.error = /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'ENCRYPTED_BACKUP_VERIFICATION_FAILED';
  } finally {
    key?.fill(0);
    try {
      await restored?.$disconnect();
    } catch {
      report.passed = false;
      report.error = 'RESTORE_CONNECTION_CLEANUP_FAILED';
    }
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
      try {
        await admin.$disconnect();
      } catch {
        report.passed = false;
        report.error = 'RESTORE_CONNECTION_CLEANUP_FAILED';
      }
    }
    try {
      await unlink(decrypted).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      report.plaintextRemoved = true;
    } catch {
      report.passed = false;
      report.error = 'PLAINTEXT_CLEANUP_FAILED';
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.BACKUP_ENCRYPTED_FILE || !process.env.BACKUP_ENCRYPTION_KEY_FILE) {
    console.error('BACKUP_ENCRYPTED_FILE_AND_PRIVATE_KEY_FILE_REQUIRED');
    process.exitCode = 1;
  } else {
    try {
      const report = await verifyEncryptedBackup(process.env.DATABASE_URL, {
        input: process.env.BACKUP_ENCRYPTED_FILE,
        keyFile: process.env.BACKUP_ENCRYPTION_KEY_FILE,
        outputRoot: process.env.BACKUP_OUTPUT_ROOT,
      });
      console.log(report.passed ? 'PASS authenticated encrypted backup restore' : report.error);
      if (!report.passed) process.exitCode = 1;
    } catch {
      console.error('ENCRYPTED_BACKUP_VERIFICATION_FAILED');
      process.exitCode = 1;
    }
  }
}
