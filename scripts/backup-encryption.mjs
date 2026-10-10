import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, open, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// JUDOBKP1 | 12-byte IV | AES-256-GCM ciphertext | 16-byte authentication tag.
// Ciphertext: uint32 metadata length | UTF-8 metadata JSON | PostgreSQL custom dump.
// Metadata (including the source snapshot/hash) is encrypted and authenticated.
const MAGIC = Buffer.from('JUDOBKP1');
const HEADER_BYTES = MAGIC.length + 12;
const TAG_BYTES = 16;
const METADATA_LIMIT = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('INVALID_BACKUP_KEY');
}

/** One private regular file containing exactly 64 hexadecimal characters and an optional newline. */
export async function readBackupKey(file) {
  if (typeof file !== 'string' || !file) throw new Error('BACKUP_KEY_FILE_REQUIRED');
  let handle;
  try {
    handle = await open(file, READ_FLAGS);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid?.() !== 0 && info.uid !== process.getuid?.()) ||
      info.size < 64 ||
      info.size > 66
    )
      throw new Error('BACKUP_KEY_FILE_NOT_PRIVATE');
    const value = await handle.readFile('utf8');
    if (!/^[a-fA-F0-9]{64}(?:\r?\n)?$/.test(value)) throw new Error('INVALID_BACKUP_KEY_FILE');
    return Buffer.from(value.trim(), 'hex');
  } catch (error) {
    if (/^BACKUP_|^INVALID_BACKUP_/.test(error.message)) throw error;
    throw new Error('BACKUP_KEY_FILE_UNAVAILABLE');
  } finally {
    await handle?.close();
  }
}

async function privateOutputDirectory(file) {
  const info = await stat(dirname(file));
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('PLAINTEXT_DIRECTORY_NOT_PRIVATE');
}

async function sha256Handle(handle) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const part of handle.createReadStream({ start: 0, autoClose: false })) {
    bytes += part.length;
    hash.update(part);
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function backupFileHash(file) {
  const handle = await open(file, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('BACKUP_NOT_REGULAR_FILE');
    return await sha256Handle(handle);
  } finally {
    await handle.close();
  }
}

// link() publishes without replacing an existing destination, unlike rename().
async function publishPrivateFile(temporary, target) {
  const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await link(temporary, target);
  await unlink(temporary);
  const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function encryptBackupFile(input, output, key, manifest) {
  assertKey(key);
  if (resolve(input) === resolve(output)) throw new Error('BACKUP_OUTPUT_EQUALS_INPUT');
  const handle = await open(input, READ_FLAGS);
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.partial`);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('BACKUP_NOT_REGULAR_FILE');
    const { sha256, bytes } = await sha256Handle(handle);
    const metadata = Buffer.from(
      JSON.stringify({ version: 1, dumpSha256: sha256, dumpBytes: bytes, manifest }),
    );
    if (metadata.length > METADATA_LIMIT) throw new Error('BACKUP_METADATA_TOO_LARGE');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(metadata.length);
    const iv = randomBytes(12),
      header = Buffer.concat([MAGIC, iv]),
      cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const chunks = async function* () {
      yield length;
      yield metadata;
      yield* handle.createReadStream({ start: 0, autoClose: false });
    };
    const destination = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    destination.write(header);
    await pipeline(Readable.from(chunks()), cipher, destination);
    const append = await open(temporary, constants.O_WRONLY | constants.O_APPEND);
    try {
      await append.write(cipher.getAuthTag());
    } finally {
      await append.close();
    }
    await publishPrivateFile(temporary, output);
    return { dumpSha256: sha256, dumpBytes: bytes };
  } finally {
    await handle.close();
    await unlink(temporary).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

/** Never exposes a final plaintext file before GCM authentication and the recorded dump hash pass. */
export async function decryptBackupFile(input, output, key) {
  assertKey(key);
  if (resolve(input) === resolve(output)) throw new Error('BACKUP_OUTPUT_EQUALS_INPUT');
  await privateOutputDirectory(output);
  const handle = await open(input, READ_FLAGS);
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.partial`);
  let metadata,
    bytes = 0;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < HEADER_BYTES + TAG_BYTES + 4)
      throw new Error('INVALID_BACKUP_ENVELOPE');
    const header = Buffer.alloc(HEADER_BYTES),
      tag = Buffer.alloc(TAG_BYTES);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length)
      throw new Error('INVALID_BACKUP_ENVELOPE');
    await handle.read(tag, 0, tag.length, info.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('INVALID_BACKUP_ENVELOPE');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    let prefix = Buffer.alloc(0),
      metadataLength;
    const hash = createHash('sha256');
    const extract = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          let pending = chunk;
          if (metadataLength === undefined) {
            const needed = 4 - prefix.length;
            prefix = Buffer.concat([prefix, pending.subarray(0, needed)]);
            pending = pending.subarray(needed);
            if (prefix.length < 4) return callback();
            metadataLength = prefix.readUInt32BE();
            prefix = Buffer.alloc(0);
            if (metadataLength < 2 || metadataLength > METADATA_LIMIT)
              throw new Error('INVALID_BACKUP_METADATA');
          }
          if (metadata === undefined) {
            const needed = metadataLength - prefix.length;
            prefix = Buffer.concat([prefix, pending.subarray(0, needed)]);
            pending = pending.subarray(needed);
            if (prefix.length < metadataLength) return callback();
            metadata = JSON.parse(prefix.toString('utf8'));
            prefix = Buffer.alloc(0);
            if (!metadata || typeof metadata !== 'object')
              throw new Error('INVALID_BACKUP_METADATA');
          }
          bytes += pending.length;
          hash.update(pending);
          callback(null, pending);
        } catch {
          callback(new Error('INVALID_BACKUP_METADATA'));
        }
      },
    });
    try {
      await pipeline(
        handle.createReadStream({
          start: HEADER_BYTES,
          end: info.size - TAG_BYTES - 1,
          autoClose: false,
        }),
        decipher,
        extract,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
    } catch {
      throw new Error('BACKUP_AUTHENTICATION_FAILED');
    }
    if (
      metadata?.version !== 1 ||
      !Number.isSafeInteger(metadata.dumpBytes) ||
      metadata.dumpBytes !== bytes ||
      !/^[a-f0-9]{64}$/.test(metadata.dumpSha256) ||
      metadata.dumpSha256 !== hash.digest('hex')
    )
      throw new Error('BACKUP_HASH_MISMATCH');
    await publishPrivateFile(temporary, output);
    return metadata;
  } finally {
    await handle.close();
    await unlink(temporary).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
