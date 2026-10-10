import { createVerifiedBackup } from './backup-database.mjs';
import { encryptBackupFile, readBackupKey } from './backup-encryption.mjs';
import { verifyEncryptedBackup } from './verify-encrypted-backup.mjs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Export marker is written only after authenticated decryption and a second real disposable restore. */
export async function createEncryptedVerifiedBackup(
  connection,
  { keyFile, outputRoot = '/backups' },
) {
  const key = await readBackupKey(keyFile);
  let original;
  try {
    original = await createVerifiedBackup(connection, { outputRoot });
    if (!original.passed) throw new Error('BACKUP_VERIFICATION_FAILED');
    const manifest = JSON.parse(
      await readFile(join(original.output, 'source-manifest.json'), 'utf8'),
    );
    const encryptedPath = join(original.output, 'database.dump.aesgcm');
    const encryption = await encryptBackupFile(original.dumpPath, encryptedPath, key, manifest);
    if (
      encryption.dumpSha256 !== original.dumpSha256 ||
      encryption.dumpBytes !== original.dumpBytes
    )
      throw new Error('BACKUP_CHANGED_DURING_ENCRYPTION');
    const restored = await verifyEncryptedBackup(connection, {
      input: encryptedPath,
      keyFile,
      outputRoot: original.output,
    });
    if (!restored.passed || restored.dumpSha256 !== original.dumpSha256)
      throw new Error(restored.error ?? 'ENCRYPTED_BACKUP_VERIFICATION_FAILED');
    await unlink(original.dumpPath);
    const report = {
      version: 1,
      passed: true,
      algorithm: 'AES-256-GCM',
      encryptedFile: basename(encryptedPath),
      encryptedSha256: restored.encryptedSha256,
      dumpSha256: original.dumpSha256,
      dumpBytes: original.dumpBytes,
      tables: restored.tables,
      schemaStructureMatched: true,
      authenticatedDecryption: true,
      verificationDatabaseRemoved: restored.verificationDatabaseRemoved,
      plaintextRemoved: restored.plaintextRemoved,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(
      join(original.output, 'export-verified.json'),
      JSON.stringify(report, null, 2) + '\n',
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    return { ...report, output: original.output, encryptedPath };
  } finally {
    key.fill(0);
    if (original?.dumpPath)
      await unlink(original.dumpPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await createEncryptedVerifiedBackup(process.env.DATABASE_URL, {
      keyFile: process.env.BACKUP_ENCRYPTION_KEY_FILE,
      outputRoot: process.env.BACKUP_OUTPUT_ROOT ?? '/backups',
    });
    console.log(
      `PASS encrypted verified backup: ${report.tables.length} tables; ${report.encryptedPath}`,
    );
  } catch {
    console.error('BACKUP_EXPORT_FAILED: inspect the private verification reports.');
    process.exitCode = 1;
  }
}
