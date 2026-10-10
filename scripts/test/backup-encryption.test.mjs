import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupFileHash,
  decryptBackupFile,
  encryptBackupFile,
  readBackupKey,
} from '../backup-encryption.mjs';

async function fixture(t, data = randomBytes(4000000)) {
  const dir = await mkdtemp(join(tmpdir(), 'judo-encryption-test-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.dump'),
    encrypted = join(dir, 'archive.aesgcm'),
    decrypted = join(dir, 'restored.dump'),
    key = randomBytes(32);
  await writeFile(input, data, { mode: 0o600 });
  return { dir, input, encrypted, decrypted, key, data };
}

test('stream envelope authenticates a multi-megabyte dump and encrypted metadata before publishing 0600 plaintext', async (t) => {
  const f = await fixture(t);
  const manifest = { schema: 'public', tables: [{ name: 'Contest', rows: 3, sha256: 'snapshot' }] };
  const encrypted = await encryptBackupFile(f.input, f.encrypted, f.key, manifest);
  const metadata = await decryptBackupFile(f.encrypted, f.decrypted, f.key);
  assert.deepEqual(metadata.manifest, manifest);
  assert.equal(metadata.dumpSha256, encrypted.dumpSha256);
  assert.equal(metadata.dumpBytes, f.data.length);
  assert.deepEqual(await readFile(f.decrypted), f.data);
  assert.deepEqual(await backupFileHash(f.decrypted), {
    sha256: metadata.dumpSha256,
    bytes: metadata.dumpBytes,
  });
  assert.equal((await stat(f.encrypted)).mode & 0o777, 0o600);
  assert.equal((await stat(f.decrypted)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(f.encrypted)).includes(Buffer.from('snapshot')));
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.partial')));
});

test('metadata split across stream chunks and an empty dump remain deterministic', async (t) => {
  const f = await fixture(t, Buffer.alloc(0));
  const manifest = { schema: 'public', large: 'x'.repeat(200000) };
  await encryptBackupFile(f.input, f.encrypted, f.key, manifest);
  assert.deepEqual((await decryptBackupFile(f.encrypted, f.decrypted, f.key)).manifest, manifest);
  assert.equal((await readFile(f.decrypted)).length, 0);
});

test('each encryption uses a fresh IV while retaining the exact source hash', async (t) => {
  const f = await fixture(t, Buffer.from('private tournament snapshot'));
  const first = await encryptBackupFile(f.input, f.encrypted, f.key, {});
  const other = join(f.dir, 'other.aesgcm');
  const second = await encryptBackupFile(f.input, other, f.key, {});
  assert.deepEqual(first, second);
  assert.notDeepEqual(await readFile(f.encrypted), await readFile(other));
});

for (const mutation of ['wrong-key', 'header', 'ciphertext', 'tag', 'truncated']) {
  test(`rejected ${mutation} exposes no final plaintext and removes partial plaintext`, async (t) => {
    const f = await fixture(t, Buffer.from('confirmed scores and pending receipts'));
    await encryptBackupFile(f.input, f.encrypted, f.key, { schema: 'public' });
    const bytes = await readFile(f.encrypted);
    let key = f.key;
    if (mutation === 'wrong-key') key = randomBytes(32);
    else if (mutation === 'header') bytes[10] ^= 1;
    else if (mutation === 'ciphertext') bytes[Math.floor(bytes.length / 2)] ^= 1;
    else if (mutation === 'tag') bytes[bytes.length - 1] ^= 1;
    if (mutation === 'truncated') await writeFile(f.encrypted, bytes.subarray(0, 30));
    else await writeFile(f.encrypted, bytes);
    await assert.rejects(decryptBackupFile(f.encrypted, f.decrypted, key));
    await assert.rejects(stat(f.decrypted), { code: 'ENOENT' });
    assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.partial')));
  });
}

test('authenticated but inconsistent dump hash or byte count is rejected', async (t) => {
  const f = await fixture(t, Buffer.from('dump'));
  // An authenticated envelope alone must not bypass snapshot/hash validation.
  const header = Buffer.concat([Buffer.from('JUDOBKP1'), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', f.key, header.subarray(8));
  cipher.setAAD(header);
  const metadata = Buffer.from(
    JSON.stringify({ version: 1, dumpSha256: '0'.repeat(64), dumpBytes: 4, manifest: {} }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(metadata.length);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([length, metadata, f.data])),
    cipher.final(),
  ]);
  await writeFile(f.encrypted, Buffer.concat([header, ciphertext, cipher.getAuthTag()]), {
    mode: 0o600,
  });
  await assert.rejects(decryptBackupFile(f.encrypted, f.decrypted, f.key), /BACKUP_HASH_MISMATCH/);
  await assert.rejects(stat(f.decrypted), { code: 'ENOENT' });
});

test('encryption and decryption never overwrite an existing destination', async (t) => {
  const f = await fixture(t, Buffer.from('original'));
  await encryptBackupFile(f.input, f.encrypted, f.key, {});
  const existing = await readFile(f.encrypted);
  await assert.rejects(encryptBackupFile(f.input, f.encrypted, f.key, {}), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.encrypted), existing);
  await writeFile(f.decrypted, 'keep-me', { mode: 0o600 });
  await assert.rejects(decryptBackupFile(f.encrypted, f.decrypted, f.key), { code: 'EEXIST' });
  assert.equal(await readFile(f.decrypted, 'utf8'), 'keep-me');
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.partial')));
});

test('input paths cannot be overwritten and plaintext requires a private parent directory', async (t) => {
  const f = await fixture(t, Buffer.from('original'));
  await assert.rejects(encryptBackupFile(f.input, f.input, f.key, {}), /OUTPUT_EQUALS_INPUT/);
  await encryptBackupFile(f.input, f.encrypted, f.key, {});
  await assert.rejects(decryptBackupFile(f.encrypted, f.encrypted, f.key), /OUTPUT_EQUALS_INPUT/);
  await chmod(f.dir, 0o755);
  await assert.rejects(decryptBackupFile(f.encrypted, f.decrypted, f.key), /DIRECTORY_NOT_PRIVATE/);
  assert.equal(await readFile(f.input, 'utf8'), 'original');
});

test('key loader permits fixed 64-hex private files but rejects missing, public, symlink and malformed keys', async (t) => {
  const f = await fixture(t, Buffer.alloc(0));
  const file = join(f.dir, 'backup.key');
  await writeFile(file, f.key.toString('hex') + '\n', { mode: 0o600 });
  assert.deepEqual(await readBackupKey(file), f.key);
  await chmod(file, 0o644);
  await assert.rejects(readBackupKey(file), /NOT_PRIVATE/);
  await chmod(file, 0o600);
  const pointer = join(f.dir, 'symlink.key');
  await symlink(file, pointer);
  await assert.rejects(readBackupKey(pointer), /UNAVAILABLE/);
  await writeFile(file, 'x'.repeat(64));
  await assert.rejects(readBackupKey(file), /INVALID_BACKUP_KEY_FILE/);
  await assert.rejects(readBackupKey(''), /FILE_REQUIRED/);
});

test('raw keys and oversized metadata fail before an archive is published', async (t) => {
  const f = await fixture(t, Buffer.alloc(0));
  await assert.rejects(encryptBackupFile(f.input, f.encrypted, 'secret', {}), /INVALID_BACKUP_KEY/);
  await assert.rejects(
    encryptBackupFile(f.input, f.encrypted, f.key, { tooBig: 'x'.repeat(1100000) }),
    /METADATA_TOO_LARGE/,
  );
  await assert.rejects(stat(f.encrypted), { code: 'ENOENT' });
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.partial')));
});
