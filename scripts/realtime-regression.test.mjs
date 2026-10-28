import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
const dist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const { LiveService, liveCursor } = await import(
  new URL(`${dist}/modules/matches/live.service.js`, import.meta.url)
);
const { RuntimeConfig } = await import(
  new URL(`${dist}/infrastructure/runtime-config.js`, import.meta.url)
);
const { HealthController } = await import(
  new URL(`${dist}/infrastructure/health.controller.js`, import.meta.url)
);
const { AuthController } = await import(
  new URL(`${dist}/modules/auth/auth.controller.js`, import.meta.url)
);
const id = randomUUID(),
  mat = randomUUID(),
  other = randomUUID();
const notice = (cursor, tournamentId = id) => ({
  id: BigInt(cursor),
  tournamentId,
  kind: 'result',
  tatamiId: null,
  attempts: 0,
  nextAttemptAt: new Date(0),
});

function environment(values, task) {
  const keys = [
    'NODE_ENV',
    'API_HOST',
    'PORT',
    'ALLOWED_ORIGINS',
    'COOKIE_SECURE',
    'TRUST_PROXY',
    'REDIS_URL',
    'API_REPLICAS',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return task();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
function harness(events = []) {
  const emitted = [],
    updates = [];
  const db = {
    liveOutbox: {
      findMany: async ({ where, take }) =>
        events
          .filter(
            (e) =>
              (!where.tournamentId || e.tournamentId === where.tournamentId) &&
              (!where.id || (e.id > where.id.gt && e.id <= where.id.lte)),
          )
          .slice(0, take),
      findFirst: async ({ where }) =>
        events.filter((e) => e.tournamentId === where.tournamentId).at(-1),
      update: async (v) => {
        updates.push(v);
        return v;
      },
    },
  };
  const redis = { ready: true, broadcast: async (send) => send() };
  const live = new LiveService(db, {}, {}, redis);
  live.server = {
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  };
  live.allowed = async () => true;
  return { live, redis, db, emitted, updates };
}
function replayClient() {
  const events = [],
    order = [];
  const socket = {
    connected: true,
    emit: (_, v) => {
      events.push(v);
      order.push(v.kind);
    },
    join: () => order.push('joined'),
    disconnect: () => {
      socket.connected = false;
      order.push('disconnected');
    },
  };
  const client = {
    tournamentId: id,
    req: { headers: {} },
    syncing: true,
    queued: [],
    backpressure: 0,
  };
  return { socket, client, events, order };
}

test('LIVE cursors preserve bigint precision and reject ambiguous or out-of-range input', () => {
  assert.equal(liveCursor(undefined), undefined);
  assert.equal(liveCursor('9007199254740993'), 9007199254740993n);
  assert.equal(liveCursor('9223372036854775807'), 9223372036854775807n);
  for (const value of [null, 4, '-1', '00', '1.0', ' 1', '9223372036854775808'])
    assert.throws(() => liveCursor(value), /INVALID_LIVE_CURSOR/);
});

test('production runtime requires explicit origins and Redis and rejects an insecure HTTPS cookie policy', () => {
  environment({ NODE_ENV: 'production' }, () =>
    assert.throws(() => new RuntimeConfig(), /ALLOWED_ORIGINS_REQUIRED/),
  );
  environment({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://judo.example.kz' }, () =>
    assert.throws(() => new RuntimeConfig(), /REDIS_URL_REQUIRED/),
  );
  environment({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://192.0.2.1' }, () =>
    assert.throws(() => new RuntimeConfig(), /SECURE_COOKIE_REQUIRES_HTTPS_ORIGINS/),
  );
});

test('one origin policy covers HTTPS/LAN, explicit trusted proxies and the single API clock owner', () => {
  environment(
    {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://judo.example.kz',
      REDIS_URL: 'redis://redis.internal:6379',
      TRUST_PROXY: '1',
    },
    () => {
      const config = new RuntimeConfig();
      assert.equal(config.cookieSecure, true);
      assert.equal(config.host, '0.0.0.0');
      assert.equal(config.trustProxy, 1);
      assert.equal(config.allowedOrigin('https://judo.example.kz'), true);
      assert.equal(config.allowedOrigin('https://judo.example.kz.attacker.invalid'), false);
      assert.equal(config.allowedOrigin(undefined), false);
      assert.equal(config.allowedOrigin(undefined, true), true);
    },
  );
  environment(
    {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'http://192.0.2.1',
      COOKIE_SECURE: 'false',
      REDIS_URL: 'redis://redis.internal:6379',
      TRUST_PROXY: '10.0.0.0/8',
    },
    () => {
      assert.equal(new RuntimeConfig().cookieSecure, false);
      assert.deepEqual(new RuntimeConfig().trustProxy, ['10.0.0.0/8']);
    },
  );
  environment({ API_REPLICAS: '2' }, () =>
    assert.throws(() => new RuntimeConfig(), /MULTIPLE_API_CLOCK_OWNERS/),
  );
  for (const origin of [
    '*',
    'https://judo.example.kz/path',
    'https://u:p@judo.example.kz',
    'https://judo.example.kz/',
  ])
    environment({ ALLOWED_ORIGINS: origin }, () =>
      assert.throws(() => new RuntimeConfig(), /INVALID_ALLOWED_ORIGINS/),
    );
});

test('readiness fails closed on database, Redis or a draining LIVE dispatcher', async () => {
  const redis = { ready: true, configured: true, ping: async () => 'PONG' },
    live = { ready: true };
  const health = new HealthController({ $queryRaw: async () => [{ '?column?': 1 }] }, redis, live);
  assert.deepEqual(await health.readiness(), { status: 'ok', database: 'ok', realtime: 'redis' });
  redis.ready = false;
  await assert.rejects(
    health.readiness(),
    (e) => e.status === 503 && !JSON.stringify(e.getResponse()).includes('redis.internal'),
  );
  redis.ready = true;
  live.ready = false;
  await assert.rejects(health.readiness(), (e) => e.status === 503);
  await assert.rejects(
    new HealthController(
      {
        $queryRaw: async () => {
          throw new Error('private-connection-credential');
        },
      },
      redis,
      live,
    ).readiness(),
    (e) =>
      e.status === 503 &&
      !JSON.stringify(e.getResponse()).includes('private-connection-credential'),
  );
  assert.deepEqual(health.liveness(), { status: 'ok' });
});

test('login and logout share the configured Secure HttpOnly SameSite session-cookie attributes', async () => {
  const headers = new Map();
  const controller = new AuthController(
    {
      limit() {},
      loginFromAddress: async () => ({ id, name: 'Admin', role: 'ORGANIZER' }),
      session: async () => 'synthetic',
      logout: async () => {},
    },
    { cookieSecure: true },
  );
  const res = { setHeader: (key, value) => headers.set(key, value) };
  await controller.login(
    { ip: '192.0.2.1' },
    { email: 'synthetic@example.invalid', password: 'synthetic' },
    res,
  );
  assert.match(
    headers.get('Set-Cookie'),
    /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800; Secure$/,
  );
  await controller.logout({ id }, res);
  assert.match(headers.get('Set-Cookie'), /Max-Age=0; Secure$/);
  assert.equal(headers.get('Cache-Control'), 'no-store');
});

test('public streams work without a session; unpublished tournaments require a fresh correctly scoped principal', async () => {
  let published = false,
    principal = null,
    ownedMat = false,
    authCalls = 0;
  const live = new LiveService(
    {
      tournament: {
        findUnique: async () => ({ ownerId: id, publishedAt: published ? new Date() : null }),
      },
      tatami: { findFirst: async () => (ownedMat ? { id: mat } : null) },
    },
    {
      authenticate: async () => {
        authCalls++;
        return principal;
      },
    },
    {},
    {},
  );
  const req = { headers: { cookie: 'synthetic' } };
  assert.equal(await live.allowed(id, req), false);
  principal = { id, role: 'ORGANIZER' };
  assert.equal(await live.allowed(id, req), true);
  principal = { id: other, role: 'ORGANIZER' };
  assert.equal(await live.allowed(id, req), false);
  principal = { id: other, role: 'OPERATOR', tatamiId: mat };
  ownedMat = false;
  assert.equal(await live.allowed(id, req), false);
  ownedMat = true;
  assert.equal(await live.allowed(id, req), true);
  principal = null;
  published = true;
  const before = authCalls;
  assert.equal(await live.allowed(id, req), true);
  assert.equal(authCalls, before);
});

test('replay sends retained published and unpublished notices in cursor order, then joins and flushes the registered gap', async () => {
  const h = harness([notice('9007199254740993'), notice('9007199254740994')]);
  const c = replayClient();
  c.client.queued.push({ kind: 'roster', tournamentId: id, cursor: '9007199254740995' });
  await h.live.replay(c.socket, c.client, 9007199254740992n);
  assert.deepEqual(
    c.events.map((e) => e.cursor),
    ['9007199254740993', '9007199254740994', '9007199254740994', '9007199254740995'],
  );
  assert.deepEqual(c.order, ['result', 'result', 'connected', 'joined', 'roster']);
  assert.equal(c.client.syncing, false);
  for (const e of c.events)
    assert.ok(
      Object.keys(e).every((key) => ['tournamentId', 'tatamiId', 'kind', 'cursor'].includes(key)),
    );
});

test('initial snapshot boundary and future/large replay cursors produce an explicit HTTP resync', async () => {
  const h = harness(Array.from({ length: 101 }, (_, i) => notice(i + 1)));
  for (const cursor of [0n, 500n]) {
    const c = replayClient();
    await h.live.replay(c.socket, c.client, cursor);
    assert.deepEqual(c.events, [{ kind: 'resync', tournamentId: id, cursor: '101' }]);
  }
  const c = replayClient();
  await h.live.replay(c.socket, c.client, undefined);
  assert.deepEqual(c.events, [{ kind: 'connected', tournamentId: id, cursor: '101' }]);
});

test('revocation during replay lookup sends no retained events or join', async () => {
  const h = harness([notice(1)]),
    c = replayClient();
  let checks = 0;
  h.live.allowed = async () => ++checks === 1;
  await h.live.replay(c.socket, c.client, 0n);
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.order, ['disconnected']);
});

test('outbox waits for actual publication before mark and retries the same immutable cursor after a failed mark', async () => {
  const h = harness([notice(1)]);
  let fail = true;
  h.db.liveOutbox.update = async (v) => {
    h.updates.push(v);
    if (v.data.publishedAt && fail) {
      fail = false;
      throw new Error('synthetic interrupted mark');
    }
  };
  await h.live.dispatch();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.updates.at(-1).data.lastError, 'DELIVERY_UNAVAILABLE');
  await h.live.dispatch();
  assert.equal(h.emitted.length, 2);
  assert.equal(h.emitted[0].payload.cursor, h.emitted[1].payload.cursor);
  assert.ok(h.updates.at(-1).data.publishedAt instanceof Date);
});

test('failed or deferred delivery blocks later cursors of that tournament while another stream can proceed', async () => {
  const events = [notice(1), notice(2), notice(3, other)];
  events[0].nextAttemptAt = new Date(Date.now() + 10000);
  const h = harness(events);
  await h.live.dispatch();
  assert.deepEqual(
    h.emitted.map((e) => e.payload.cursor),
    ['3'],
  );
  events[0].nextAttemptAt = new Date(0);
  let calls = 0;
  h.redis.broadcast = async (send) => {
    if (++calls === 1) throw new Error('synthetic publish failure');
    send();
  };
  await h.live.dispatch();
  assert.deepEqual(
    h.emitted.map((e) => e.payload.cursor),
    ['3', '3'],
  );
  assert.equal(
    h.updates.some((v) => v.where.id === 2n),
    false,
  );
});

test('Redis disconnection leaves the durable outbox unmarked for later retry', async () => {
  const h = harness([notice(1)]);
  h.redis.ready = false;
  await h.live.dispatch();
  assert.deepEqual(h.emitted, []);
  assert.deepEqual(h.updates, []);
});

test('polling preserves private LIVE cookie authorization and origin checks', async () => {
  const { createServer } = await import('node:http');
  const { io } = await import('socket.io-client');
  const http = createServer();
  const origin = 'https://web.example.test';
  const owner = randomUUID();
  const db = {
    tournament: { findUnique: async () => ({ ownerId: owner, publishedAt: null }) },
    liveOutbox: { findFirst: async () => null, findMany: async () => [] },
  };
  const auth = {
    authenticate: async (cookie) =>
      cookie === 'judo_session=fixture' ? { id: owner, role: 'ORGANIZER' } : null,
  };
  const config = {
    origins: [origin],
    allowedOrigin: (value) => value === origin,
  };
  const live = new LiveService(db, auth, config, { ready: true });
  const sockets = [];
  try {
    live.attach(http);
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    function client(cookie, requestOrigin = origin) {
      const socket = io(`http://127.0.0.1:${http.address().port}`, {
        path: '/api/v1/live',
        addTrailingSlash: false,
        transports: ['polling'],
        auth: { tournamentId: id },
        extraHeaders: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) },
        autoConnect: false,
        reconnection: false,
        timeout: 1500,
      });
      sockets.push(socket);
      return socket;
    }
    const authorized = client('judo_session=fixture');
    const boundary = new Promise((resolve, reject) => {
      authorized.once('notice', resolve);
      authorized.once('connect_error', reject);
    });
    authorized.connect();
    assert.deepEqual(await boundary, { kind: 'connected', tournamentId: id, cursor: '0' });
    for (const socket of [client(), client('judo_session=fixture', 'https://foreign.test')]) {
      await new Promise((resolve, reject) => {
        socket.once('connect_error', resolve);
        socket.once('connect', () => reject(new Error('Unauthorized polling accepted')));
        socket.connect();
      });
    }
  } finally {
    for (const socket of sockets) socket.disconnect();
    await live.onModuleDestroy();
    if (http.listening) await new Promise((resolve) => http.close(resolve));
  }
});

test('Redis diagnostics expose fixed failure categories without connection secrets', async () => {
  const { redisFailureCode } = await import(
    new URL(`${dist}/infrastructure/redis.service.js`, import.meta.url)
  );
  assert.equal(redisFailureCode({ code: 'ENOTFOUND', message: 'secret-host' }), 'ENOTFOUND');
  assert.equal(redisFailureCode({ message: 'NOAUTH secret-password' }), 'AUTH_REQUIRED');
  assert.equal(redisFailureCode({ message: 'WRONGPASS secret-password' }), 'AUTH_REJECTED');
  assert.equal(redisFailureCode({ message: 'Command timed out: secret-host' }), 'UNKNOWN');
  assert.equal(redisFailureCode({ message: 'connect timeout: secret-host' }), 'TIMEOUT');
  for (const error of [null, 'secret', { code: 'secret-code', message: 'secret-url' }])
    assert.equal(redisFailureCode(error), 'UNKNOWN');
});
