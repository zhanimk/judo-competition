import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { processIdentity } from './native-qa-processes.mjs';

const file = resolve(process.argv[2] ?? '');
assert.ok(file.includes('/tmp/native-production-qa/qa_ui_') && file.endsWith('/processes.json'));
const manifest = JSON.parse(await readFile(file, 'utf8'));
assert.match(manifest.schema, /^qa_ui_[a-f0-9]{32}$/);
const queryProcess = promisify(execFile),
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function owned(pid, redis = false) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const { stdout } = await queryProcess('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes('judo-' + manifest.schema + '-');
  } catch {
    return false;
  }
}
if (await owned(manifest.coordinatorPid)) {
  process.kill(manifest.coordinatorPid, 'SIGTERM');
  const end = Date.now() + 20000;
  while (Date.now() < end && (await owned(manifest.coordinatorPid))) await pause(100);
}
for (const name of ['web', 'api', 'redis']) {
  const pid = manifest[name + 'Pid'];
  if (
    (await owned(pid, name === 'redis')) ||
    (name === 'web' &&
      manifest.webProcessIdentity &&
      (await processIdentity(pid)) === manifest.webProcessIdentity)
  )
    process.kill(pid, 'SIGTERM');
}
if (await owned(manifest.webCoordinatorPid)) process.kill(manifest.webCoordinatorPid, 'SIGTERM');
await pause(300);
const db = new PrismaClient();
try {
  // Only the random schema is removed; no DROP DATABASE, user or working-table cleanup.
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${manifest.schema}" CASCADE`);
  console.log('PASS synthetic native QA cleanup');
} finally {
  await db.$disconnect();
}
