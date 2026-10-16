import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { connectLive, liveSocket } from './test-live.mjs';
import { processIdentity } from './native-qa-processes.mjs';

// Synthetic local production-mode UI rehearsal. Never seed or reuse the working schema.
const root = dirname(dirname(fileURLToPath(import.meta.url))),
  schema = 'qa_ui_' + randomUUID().replaceAll('-', ''),
  output = join(root, 'tmp', 'native-production-qa', schema),
  source = new URL(process.env.DATABASE_URL),
  connection = new URL(source),
  redisExecutable = process.env.QA_REDIS_SERVER;
assert.match(schema, /^qa_ui_[a-f0-9]{32}$/);
assert.ok(redisExecutable && resolve(redisExecutable).startsWith('/private/tmp/judo-redis-qa.'));
connection.searchParams.set('schema', schema);
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
process.title = `judo-${schema}-coordinator`;
const apiPort = 4319,
  webPort = 4318,
  webOrigin = `http://127.0.0.1:${webPort}`,
  base = `http://127.0.0.1:${apiPort}/api/v1`,
  admin = new PrismaClient({ datasources: { db: { url: source.href } } }),
  db = new PrismaClient({ datasources: { db: { url: connection.href } } });
const services = {},
  sockets = [],
  logHandles = [],
  manifest = {
    schema,
    output,
    coordinatorPid: process.pid,
    webOrigin,
    base,
    createdAt: new Date().toISOString(),
  };
const smallDrawMatrix = process.env.QA_SMALL_DRAW_MATRIX === '1';
let created = false,
  closing = false,
  redis;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test, name, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await pause(50);
  }
  throw new Error('QA_TIMEOUT_' + name);
}
async function reserve(port = 0) {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const selected = server.address().port;
  await new Promise((r) => server.close(r));
  return selected;
}
async function save() {
  await writeFile(join(output, 'processes.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
}
async function start(name, executable, args, env, cwd = root) {
  const log = await open(join(output, name + '.log'), 'a', 0o600);
  logHandles.push(log);
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  child.completion = once(child, 'exit');
  services[name] = child;
  manifest[name + 'Pid'] = child.pid;
  await save();
  return child;
}
async function stop(name) {
  const child = services[name];
  if (!child) return;
  delete services[name];
  if (child.exitCode === null) child.kill('SIGTERM');
  await child.completion;
}
async function run(name, args, env) {
  const child = await start(name, process.execPath, args, env);
  const [code] = await child.completion;
  delete services[name];
  assert.equal(code, 0, name + ' failed; inspect its private log');
}
async function cleanup() {
  if (closing) return;
  closing = true;
  for (const socket of sockets) socket.disconnect();
  redis?.disconnect();
  for (const name of ['web', 'api', 'redis']) await stop(name);
  await db.$disconnect();
  if (created) {
    assert.match(schema, /^qa_ui_[a-f0-9]{32}$/);
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    created = false;
  }
  await admin.$disconnect();
  manifest.cleanedUp = true;
  await save();
  await Promise.all(logHandles.map((handle) => handle.close()));
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => void cleanup().then(() => process.exit(0)));
try {
  await reserve(apiPort);
  await reserve(webPort);
  const routes = JSON.parse(
    await readFile(join(root, 'apps/web/.next/routes-manifest.json'), 'utf8'),
  );
  assert.equal(
    routes.rewrites.afterFiles[0].destination,
    `http://127.0.0.1:${apiPort}/api/v1/:path*`,
  );
  const redisPort = await reserve(),
    redisPassword = randomBytes(32).toString('hex'),
    redisUrl = `redis://:${redisPassword}@127.0.0.1:${redisPort}/0`,
    redisConfig = join(output, 'redis.conf');
  await writeFile(
    redisConfig,
    `bind 127.0.0.1\nport ${redisPort}\nprotected-mode yes\nrequirepass ${redisPassword}\nsave ""\nappendonly no\ndir "${output}"\nproc-title-template "judo-${schema}-redis"\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const env = {
    ...process.env,
    DATABASE_URL: connection.href,
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    PORT: String(apiPort),
    ALLOWED_ORIGINS: webOrigin,
    COOKIE_SECURE: 'false', // Explicit synthetic loopback HTTP acceptance, never an internet default.
    TRUST_PROXY: 'false',
    API_REPLICAS: '1',
    REDIS_URL: redisUrl,
  };
  await start('redis', redisExecutable, [redisConfig], process.env);
  redis = new Redis(redisUrl, {
    lazyConnect: true,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => {});
  void redis.connect().catch(() => {});
  await waitFor(async () => {
    try {
      return redis.status === 'ready' && (await redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }, 'REDIS_READY');
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  await run('migrations', ['scripts/deploy-migrations.mjs'], env);
  assert.equal((await db.$queryRaw`SELECT current_schema() AS schema`)[0].schema, schema);
  const password = randomBytes(24).toString('base64url'),
    email = `native-${randomUUID()}@example.invalid`,
    passwordFile = join(output, 'bootstrap.password');
  await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
  await run('bootstrap', ['scripts/bootstrap-production-admin.mjs'], {
    ...env,
    BOOTSTRAP_ADMIN_EMAIL: email,
    BOOTSTRAP_ADMIN_NAME: 'Сынақ әкімшісі · Тестовый администратор',
    BOOTSTRAP_ADMIN_PASSWORD_FILE: passwordFile,
    BOOTSTRAP_ADMIN_REASON: 'Synthetic isolated native production UI rehearsal',
  });
  await start(
    'api',
    process.execPath,
    [`--title=judo-${schema}-api`, 'apps/api/dist/main.js'],
    env,
  );
  await waitFor(async () => {
    try {
      return (await fetch(base + '/health/ready')).ok;
    } catch {
      return false;
    }
  }, 'API_READY');
  assert.deepEqual(await (await fetch(base + '/health/ready')).json(), {
    status: 'ok',
    database: 'ok',
    realtime: 'redis',
  });
  let cookie = '';
  async function call(path, data) {
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Judo-Client': 'web',
        Cookie: cookie,
        Origin: webOrigin,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    assert.equal(
      response.status,
      data === undefined ? 200 : 201,
      `QA API ${path} rejected ${body.message ?? response.status}`,
    );
    return { body, response };
  }
  const loggedIn = await call('/auth/login', { email, password });
  cookie = loggedIn.response.headers.get('set-cookie').split(';')[0];
  assert.match(loggedIn.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok(!loggedIn.response.headers.get('set-cookie').includes('; Secure'));
  const tournament = (
    await call('/tournaments', {
      id: randomUUID(),
      name: 'СЫНАҚ · Native production QA',
      city: 'Алматы',
      venue: 'Synthetic local QA arena',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      tatamiCount: 2,
    })
  ).body;
  const getTournament = async () => (await call(`/tournaments/${tournament.id}`)).body;
  const categories = [];
  for (const [index, count] of (smallDrawMatrix
    ? [2, 3, 4, 5, 6, 7, 8, 8, 8]
    : [4, 3, 2]
  ).entries()) {
    const current = await getTournament();
    categories.push(
      (
        await call(`/tournaments/${tournament.id}/categories`, {
          id: randomUUID(),
          expectedRevision: current.administrationRevision,
          name: smallDrawMatrix
            ? `QA ${String(index + 1).padStart(2, '0')} · ${count} участников · ${index === 7 ? 'ROUND_ROBIN' : index === 8 ? 'MIXED' : 'REPECHAGE'}`
            : ['U12 · −30 кг', 'U14 · −42 кг', 'U16 · +73 кг'][index],
          format: index === 7 ? 'ROUND_ROBIN' : index === 8 ? 'MIXED' : 'REPECHAGE',
          gender: 'MALE',
          birthYearFrom: smallDrawMatrix ? 2012 : [2015, 2013, 2011][index],
          birthYearTo: smallDrawMatrix ? 2013 : [2016, 2014, 2012][index],
          maxWeightGrams: smallDrawMatrix
            ? 20000 + index * 5000
            : index === 2
              ? null
              : [30000, 42000][index],
          ...(!smallDrawMatrix && index === 2 ? { minWeightGrams: 73000 } : {}),
          durationSeconds: [120, 180, 240][index % 3],
        })
      ).body,
    );
    categories[index].syntheticCount = count;
  }
  const clubs = [];
  for (const name of ['Сынақ клубы A', 'Сынақ клубы B']) {
    const current = await getTournament();
    clubs.push(
      (
        await call(`/tournaments/${tournament.id}/clubs`, {
          id: randomUUID(),
          expectedRevision: current.rosterRevision,
          name,
        })
      ).body.club,
    );
  }
  for (const [index, club] of clubs.entries()) {
    const entries = categories.flatMap((category, categoryIndex) =>
      Array.from({ length: category.syntheticCount }, (_, i) => ({
        i,
        firstName: ['Айдын', 'Данияр', 'Нұржан', 'Әли', 'Әлихан', 'Бекзат', 'Ерасыл', 'Арман'][i],
        lastName: `ТЕСТ-${categoryIndex + 1}-${i + 1}`,
        birthYear: category.birthYearFrom,
        gender: 'MALE',
        categoryId: category.id,
      }))
        .filter((entry) => entry.i % 2 === index)
        .map(({ i: _, ...entry }) => entry),
    );
    const current = await getTournament();
    await call(`/tournaments/${tournament.id}/roster`, {
      id: randomUUID(),
      expectedRevision: current.rosterRevision,
      clubId: club.id,
      entries,
    });
  }
  for (const category of categories) {
    const preview = (
      await call(`/categories/${category.id}/draw/preview`, {
        id: randomUUID(),
        expectedVersion: 0,
      })
    ).body;
    await call(`/categories/${category.id}/draw/confirm`, {
      id: randomUUID(),
      version: preview.version,
    });
    await call(`/categories/${category.id}/draw/publication`, {
      id: randomUUID(),
      published: true,
      expectedRevision: 0,
    });
  }
  for (const action of ['publish', 'start']) {
    const current = await getTournament();
    await call(`/tournaments/${tournament.id}/${action}`, {
      id: randomUUID(),
      expectedRevision: current.administrationRevision,
    });
  }
  await waitFor(
    async () =>
      !(await db.liveOutbox.count({ where: { tournamentId: tournament.id, publishedAt: null } })),
    'INITIAL_OUTBOX',
  );
  const socket = liveSocket(base, tournament.id, { origin: webOrigin });
  sockets.push(socket);
  const notices = [];
  socket.on('notice', (notice) => notices.push(notice));
  await connectLive(socket);
  await waitFor(() => notices.some((notice) => notice.kind === 'connected'), 'SOCKET_BOUNDARY');
  const current = await getTournament(),
    entry = current.categories[0].entries[0],
    correction = {
      id: randomUUID(),
      expectedRevision: current.rosterRevision,
      firstName: entry.firstName,
      lastName: entry.lastName + '-QA',
      reason: 'Synthetic Redis outage durable outbox rehearsal',
    };
  await stop('redis');
  await waitFor(
    async () => (await fetch(base + '/health/ready')).status === 503,
    'REDIS_DOWN_READY',
  );
  const response = (
    await call(`/tournaments/${tournament.id}/roster/entries/${entry.id}/name`, correction)
  ).body;
  assert.deepEqual(
    (await call(`/tournaments/${tournament.id}/roster/entries/${entry.id}/name`, correction)).body,
    response,
  );
  const pending = await db.liveOutbox.findFirstOrThrow({
    where: { tournamentId: tournament.id, publishedAt: null },
    orderBy: { id: 'desc' },
  });
  assert.equal(pending.kind, 'roster');
  await start('redis', redisExecutable, [redisConfig], process.env);
  await waitFor(async () => (await fetch(base + '/health/ready')).ok, 'REDIS_RECOVER_READY');
  await waitFor(
    async () =>
      (await db.liveOutbox.findUniqueOrThrow({ where: { id: pending.id } })).publishedAt !== null,
    'DURABLE_REDIS_RECOVERY',
  );
  await waitFor(
    () => notices.some((notice) => notice.cursor === pending.id.toString()),
    'SOCKET_CURSOR_RECOVERY',
  );
  const after = await getTournament();
  const artifact = (
    await call(`/tournaments/${tournament.id}/protocols`, {
      id: randomUUID(),
      expectedRevision: after.protocolRevision,
      reason: 'Synthetic native QA published PDF',
      kind: 'DRAW',
      lang: 'ru',
    })
  ).body;
  const latest = await getTournament();
  await call(`/tournaments/${tournament.id}/protocols/${artifact.artifact.id}/command`, {
    id: randomUUID(),
    expectedRevision: latest.protocolRevision,
    reason: 'Synthetic native QA public PDF',
    type: 'PUBLISH',
    sha256: artifact.artifact.sha256,
  });
  const credentials = {
    synthetic: true,
    email,
    password,
    tournamentId: tournament.id,
    smallDrawMatrix,
    loginUrl: webOrigin + '/login',
    tournamentUrl: webOrigin + `/tournaments/${tournament.id}`,
    publicUrl: webOrigin + `/public/tournaments/${tournament.id}`,
  };
  await writeFile(join(output, 'credentials.json'), JSON.stringify(credentials, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await start(
    'web',
    process.execPath,
    [
      `--title=judo-${schema}-web`,
      join(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      ...process.env,
      NODE_ENV: 'production',
      API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    join(root, 'apps/web'),
  );
  await waitFor(async () => {
    try {
      return (await fetch(webOrigin + '/login')).ok;
    } catch {
      return false;
    }
  }, 'WEB_READY');
  manifest.webProcessIdentity = await processIdentity(manifest.webPid);
  assert.equal((await (await fetch(webOrigin + '/api/v1/health/ready')).json()).realtime, 'redis');
  const proxiedSocket = liveSocket(webOrigin + '/api/v1', tournament.id, { origin: webOrigin });
  sockets.push(proxiedSocket);
  const proxiedNotices = [];
  proxiedSocket.on('notice', (notice) => proxiedNotices.push(notice));
  await connectLive(proxiedSocket);
  await waitFor(
    () => proxiedNotices.some((notice) => notice.kind === 'connected'),
    'WEB_SOCKET_UPGRADE',
  );
  const publicPdf = await fetch(
    webOrigin + `/api/v1/public/tournaments/${tournament.id}/protocols/${artifact.artifact.id}.pdf`,
  );
  assert.equal(publicPdf.status, 200);
  assert.equal(
    Buffer.from(await publicPdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    '%PDF',
  );
  Object.assign(manifest, {
    tournamentId: tournament.id,
    credentialsArtifact: join(output, 'credentials.json'),
    checks: {
      realRedis: true,
      productionApi: true,
      builtWeb: true,
      builtWebHttpRewrite: true,
      builtWebSocketUpgrade: true,
      redisReadinessOutage: true,
      durableCommitDuringOutage: true,
      exactReceiptDuringOutage: true,
      socketIoRedisRecovery: true,
      publishedDrawPdf: true,
      publicPdfDownload: true,
    },
  });
  await save();
  console.log(`READY synthetic native production QA: ${join(output, 'processes.json')}`);
  await new Promise(() => {});
} catch (error) {
  await writeFile(join(output, 'failure.log'), error.stack ?? String(error), { mode: 0o600 });
  console.error(`NATIVE_PRODUCTION_QA_FAILED: inspect private logs in ${output}`);
  await cleanup();
  process.exitCode = 1;
}
