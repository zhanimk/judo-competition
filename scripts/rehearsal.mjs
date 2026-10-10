import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { persistenceScenario } from './persistence-scenario.mjs';

// Each run has a new schema and its own API. It never stops the working tournament server.
const schema = `qa_rehearsal_${randomUUID().replaceAll('-', '')}`;
const output = `tmp/rehearsal/${schema}`;
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), schema, passed: false, suites: [], output };
const connection = new URL(process.env.DATABASE_URL);
connection.searchParams.set('schema', schema);
const admin = new PrismaClient();
const db = new PrismaClient({ datasources: { db: { url: connection.href } } });
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}/api/v1`;
const env = {
  ...process.env,
  DATABASE_URL: connection.href,
  PORT: String(port),
  TEST_API_URL: base,
};
let server,
  serverExit,
  log,
  created = false;
async function run(name, file, args, cwd = process.cwd()) {
  const started = Date.now();
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputText = '';
  child.stdout.on('data', (part) => {
    outputText += part;
  });
  child.stderr.on('data', (part) => {
    outputText += part;
  });
  const [code] = await once(child, 'exit');
  await writeFile(`${output}/${name}.log`, outputText);
  report.suites.push({ name, passed: code === 0, durationMs: Date.now() - started });
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms)`);
  if (code !== 0) console.error(outputText.slice(-5000));
  assert.equal(code, 0, `${name} failed; see ${output}/${name}.log`);
}
async function stop(crash = false) {
  if (!server) return;
  const processToStop = server;
  server = undefined;
  processToStop.kill(crash ? 'SIGKILL' : 'SIGTERM');
  await serverExit;
}
async function start() {
  server = spawn(process.execPath, ['dist/main.js'], {
    cwd: `${process.cwd()}/apps/api`,
    env,
    stdio: ['ignore', log.fd, log.fd],
  });
  serverExit = once(server, 'exit');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Test API exited; see api.log');
    try {
      if ((await fetch(`${base}/public/tournaments`, { signal: AbortSignal.timeout(1000) })).ok)
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Test API did not become ready');
}
try {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  await run('migrations', process.execPath, ['scripts/deploy-migrations.mjs']);
  await run('migrations-repeat', process.execPath, ['scripts/deploy-migrations.mjs']);
  log = await open(`${output}/api.log`, 'a');
  await start();
  for (const suite of [
    'integration',
    'auth-integration',
    'roster-integration',
    'roster-corrections-integration',
    'draw-integration',
    'scheduling-integration',
    'public-integration',
    'control-integration',
    'formats-integration',
    'rematches-integration',
    'live-integration',
    'roster-name-integration',
    'clock-correction-integration',
    'tatami-access-integration',
    'access-session-race-integration',
    'draw-session-race-integration',
    'athlete-identity-integration',
    'protocol-integration',
  ]) {
    if (suite === 'live-integration' || suite === 'protocol-integration') {
      // Independent suites create many valid synthetic logins. Give live/PDF
      // checks a fresh process/IP budget without changing production throttles.
      await stop();
      await start();
      report.suiteBoundaryRestarts = (report.suiteBoundaryRestarts ?? 0) + 1;
    }
    await run(suite, process.execPath, [`scripts/${suite}.mjs`]);
  }
  report.persistence = await persistenceScenario({
    db,
    base,
    output,
    restart: async ({ crash, beforeStart }) => {
      await stop(crash);
      if (beforeStart) await beforeStart();
      await start();
    },
  });
  report.suites.push({ name: 'actual-process-restart-and-persistence', passed: true });
  report.passed = true;
  console.log('PASS actual-process-restart-and-persistence: two crashes and one normal restart');
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await stop();
  await log?.close();
  await db.$disconnect();
  if (created) {
    // The random identifier is generated here, never supplied by a user or environment variable.
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    report.cleanedUp = true;
  }
  await admin.$disconnect();
  report.finishedAt = new Date().toISOString();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await mkdir('docs/reports', { recursive: true });
  await writeFile('docs/reports/latest-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${output}/report.json`);
}
