import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createEncryptedVerifiedBackup } from './production-backup.mjs';
import { verifyEncryptedBackup } from './verify-encrypted-backup.mjs';

// Never accept the working schema or a user-selected restore target.
const target = new URL(process.env.DATABASE_URL);
assert.match(target.searchParams.get('schema') ?? 'public', /^qa_rehearsal_[a-f0-9]{32}$/);
const db = new PrismaClient(),
  output = await mkdtemp(join(tmpdir(), 'judo-encrypted-backup-')),
  keyFile = join(output, 'synthetic.key');
try {
  const [{ schema }] = await db.$queryRaw`SELECT current_schema() AS schema`;
  assert.equal(schema, target.searchParams.get('schema'));
  await writeFile(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  const result = await createEncryptedVerifiedBackup(process.env.DATABASE_URL, {
    keyFile,
    outputRoot: output,
  });
  assert.equal(result.passed, true);
  assert.equal(result.authenticatedDecryption, true);
  assert.equal(result.verificationDatabaseRemoved, true);
  assert.equal(result.plaintextRemoved, true);
  assert.ok(result.tables.length > 0);
  assert.equal((await stat(result.encryptedPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(result.output, 'database.dump')), { code: 'ENOENT' });
  assert.equal(
    JSON.parse(await readFile(join(result.output, 'export-verified.json'), 'utf8')).passed,
    true,
  );
  // A copied export is rechecked independently, not trusted merely because it has a marker.
  const copied = join(output, 'copied.aesgcm');
  await writeFile(copied, await readFile(result.encryptedPath), { mode: 0o600, flag: 'wx' });
  const independent = await verifyEncryptedBackup(process.env.DATABASE_URL, {
    input: copied,
    keyFile,
    outputRoot: output,
  });
  assert.equal(independent.passed, true);
  assert.equal(independent.encryptedSha256, result.encryptedSha256);
  assert.equal(independent.dumpSha256, result.dumpSha256);
  assert.equal(independent.verificationDatabaseRemoved, true);
  assert.equal(independent.plaintextRemoved, true);
  for (const directory of await readdir(result.output)) {
    if (directory.startsWith('decrypt-restore-'))
      await assert.rejects(stat(join(result.output, directory, 'decrypted.dump')), {
        code: 'ENOENT',
      });
  }
  console.log(
    'PASS encrypted backup: real authenticated decrypt, snapshot restore and owned QA cleanup',
  );
} finally {
  await db.$disconnect();
  await rm(output, { recursive: true, force: true });
}
