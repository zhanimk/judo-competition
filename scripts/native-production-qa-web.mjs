import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity, processParent, readQaManifest } from './native-qa-processes.mjs';

const action = process.argv[2];
assert.ok(['stop', 'start'].includes(action));
const { file, manifest } = await readQaManifest(process.argv[3]),
  root = dirname(dirname(fileURLToPath(import.meta.url))),
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function save() {
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}
const current = await processIdentity(manifest.webPid);
if (action === 'stop') {
  if (current) {
    if (!manifest.webProcessIdentity) {
      // Compatibility with the first live fixture: prove its original coordinator is the parent.
      assert.equal(await processParent(manifest.webPid), manifest.coordinatorPid);
      assert.ok(
        (await processIdentity(manifest.coordinatorPid))?.includes(
          `judo-${manifest.schema}-coordinator`,
        ),
      );
      manifest.webProcessIdentity = current;
    }
    assert.equal(current, manifest.webProcessIdentity, 'QA_WEB_PID_IDENTITY_CHANGED');
    process.kill(manifest.webPid, 'SIGTERM');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (await processIdentity(manifest.webPid))) await pause(100);
    if (await processIdentity(manifest.webPid)) {
      // Long-lived upgraded sockets can keep Next's graceful shutdown open.
      // Recheck the complete identity immediately before killing this QA web only.
      assert.equal(
        await processIdentity(manifest.webPid),
        manifest.webProcessIdentity,
        'QA_WEB_PID_IDENTITY_CHANGED',
      );
      process.kill(manifest.webPid, 'SIGKILL');
      const forcedDeadline = Date.now() + 5000;
      while (Date.now() < forcedDeadline && (await processIdentity(manifest.webPid)))
        await pause(100);
    }
    assert.equal(await processIdentity(manifest.webPid), null, 'QA_WEB_STOP_TIMEOUT');
  }
  manifest.webStoppedAt = new Date().toISOString();
  await save();
  console.log('PASS only synthetic QA web stopped; API/Redis/schema remain running');
} else {
  assert.equal(current, null, 'QA_WEB_ALREADY_RUNNING');
  process.title = `judo-${manifest.schema}-web-coordinator`;
  const log = await open(join(manifest.output, 'web.log'), 'a', 0o600);
  const child = spawn(
    process.execPath,
    [
      `--title=judo-${manifest.schema}-web`,
      join(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4318',
    ],
    {
      cwd: join(root, 'apps/web'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        API_INTERNAL_URL: 'http://127.0.0.1:4319',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  const completion = once(child, 'exit');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill('SIGTERM'));
  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        if ((await fetch(manifest.webOrigin + '/login')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await pause(100);
    }
    assert.equal(ready, true, 'QA_WEB_START_TIMEOUT');
    manifest.webPid = child.pid;
    manifest.webCoordinatorPid = process.pid;
    manifest.webProcessIdentity = await processIdentity(child.pid);
    manifest.webRestartedAt = new Date().toISOString();
    await save();
    console.log(`READY synthetic QA rebuilt web: ${manifest.webOrigin}; processes ${file}`);
    const [code] = await completion;
    process.exitCode = code ?? 0;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await log.close();
  }
}
