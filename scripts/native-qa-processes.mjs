import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function readQaManifest(file) {
  const resolved = resolve(file ?? '');
  assert.ok(
    resolved.includes('/tmp/native-production-qa/qa_ui_') && resolved.endsWith('/processes.json'),
  );
  const manifest = JSON.parse(await readFile(resolved, 'utf8'));
  assert.match(manifest.schema, /^qa_ui_[a-f0-9]{32}$/);
  assert.equal(resolve(manifest.output), dirname(resolved));
  return { file: resolved, manifest };
}

// Include creation time and UID, so a recycled PID cannot silently identify a new process.
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await run('ps', [
      '-p',
      String(pid),
      '-o',
      'lstart=',
      '-o',
      'uid=',
      '-o',
      'command=',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function processParent(pid) {
  const { stdout } = await run('ps', ['-p', String(pid), '-o', 'ppid=']);
  return Number(stdout.trim());
}
