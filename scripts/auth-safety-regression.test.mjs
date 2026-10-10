import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const apiModule = (path) => import(new URL(`${apiDist}/modules/auth/${path}.js`, import.meta.url));
const { AuthAttempts } = await apiModule('auth-attempts');
const { AuthService } = await apiModule('auth.service');
const { AuthController } = await apiModule('auth.controller');
const failure = (status) => (error) => error.getStatus() === status;
const denied = () => {
  throw new UnauthorizedException('INVALID_CREDENTIALS');
};
test('32 successful venue logins and invitation redemptions spend no failure budget', async () => {
  const limiter = new AuthAttempts();
  for (const channel of ['login', 'accept'])
    for (let i = 0; i < 32; i++)
      assert.equal(await limiter.run(channel, `credential-${i}`, '192.0.2.10', async () => i), i);
});
test('credential failures follow the identity across network addresses and recover after expiry', async () => {
  let now = 1000;
  const limiter = new AuthAttempts(() => now);
  for (let i = 0; i < 10; i++)
    await assert.rejects(
      limiter.run('login', 'same-email', `192.0.2.${i}`, async () => denied()),
      failure(401),
    );
  await assert.rejects(
    limiter.run('login', 'same-email', '198.51.100.1', async () => true),
    failure(429),
  );
  assert.equal(
    await limiter.run('login', 'different-email', '198.51.100.1', async () => true),
    true,
  );
  now += 15 * 60_000;
  assert.equal(await limiter.run('login', 'same-email', '198.51.100.1', async () => true), true);
});
test('shared network failure budget cannot be reset by one valid credential', async () => {
  let now = 1000;
  const limiter = new AuthAttempts(() => now),
    ip = '192.0.2.1';
  for (let i = 0; i < 99; i++)
    await assert.rejects(
      limiter.run('login', `bad-${i}`, ip, async () => denied()),
      failure(401),
    );
  assert.equal(await limiter.run('login', 'known-valid', ip, async () => true), true);
  await assert.rejects(
    limiter.run('login', 'bad-last', ip, async () => denied()),
    failure(401),
  );
  await assert.rejects(
    limiter.run('login', 'known-valid', ip, async () => true),
    failure(429),
  );
  now += 5 * 60_000;
  assert.equal(await limiter.run('login', 'known-valid', ip, async () => true), true);
});
test('verified success clears only that credential failures; server and validation failures are not counted', async () => {
  const limiter = new AuthAttempts(),
    ip = '192.0.2.10';
  for (let i = 0; i < 9; i++)
    await assert.rejects(
      limiter.run('login', 'same', ip, async () => denied()),
      failure(401),
    );
  await limiter.run('login', 'same', ip, async () => true);
  for (let i = 0; i < 9; i++)
    await assert.rejects(
      limiter.run('login', 'same', ip, async () => denied()),
      failure(401),
    );
  for (let i = 0; i < 20; i++)
    await assert.rejects(
      limiter.run('accept', 'token', ip, async () => {
        throw new BadRequestException('INVALID_NAME');
      }),
      failure(400),
    );
  assert.equal(await limiter.run('accept', 'token', ip, async () => true), true);
});
test('64 in-flight attempts are allowed, overflow is bounded and capacity is released after errors', async () => {
  const limiter = new AuthAttempts();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const active = Array.from({ length: 64 }, (_, i) =>
    limiter.run('login', `identity-${i}`, '192.0.2.1', async () => {
      await barrier;
      return i;
    }),
  );
  await assert.rejects(
    limiter.run('login', 'overflow', '192.0.2.1', async () => true),
    failure(429),
  );
  assert.equal(
    await limiter.run('login', 'different-network', '192.0.2.2', async () => true),
    true,
  );
  release();
  await Promise.all(active);
  await assert.rejects(
    limiter.run('login', 'network-failure', '192.0.2.1', async () => {
      throw new TypeError('database unavailable');
    }),
    TypeError,
  );
  assert.equal(await limiter.run('login', 'after-release', '192.0.2.1', async () => true), true);
});
function registerHarness() {
  const actor = {
    id: randomUUID(),
    name: 'Admin',
    role: 'SUPER_ADMIN',
    sessionId: randomUUID(),
    tatamiId: null,
  };
  const state = {
    session: {
      userId: actor.id,
      user: { id: actor.id, role: actor.role },
      expiresAt: new Date('2099-01-01'),
      invitationId: null,
    },
    created: [],
    locks: [],
  };
  const service = new AuthService(
    {
      $transaction: async (callback) =>
        callback({
          $queryRaw: async (strings) => {
            state.locks.push(strings.join('?'));
            return [];
          },
          session: { findUnique: async () => state.session },
          user: {
            create: async ({ data, select }) => {
              state.created.push(data);
              return {
                ...Object.fromEntries(
                  Object.keys(select).map((key) => [key, key === 'id' ? randomUUID() : data[key]]),
                ),
              };
            },
          },
        }),
    },
    {},
  );
  const dto = {
    email: 'NEW@TEST.EXAMPLE',
    name: '  New   Admin  ',
    password: 'Synthetic QA password 2026',
  };
  return { actor, state, service, dto };
}
test('new account creation rechecks the captured live SUPER_ADMIN Session after asynchronous hashing', async () => {
  const h = registerHarness(),
    result = await h.service.register(h.dto, h.actor);
  assert.equal(result.name, 'New Admin');
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.equal(result.role, 'ORGANIZER');
  assert.equal('passwordHash' in result, false);
  assert.equal('email' in result, false);
  assert.equal(h.state.created[0].email, 'new@test.example');
  assert.match(h.state.created[0].passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(h.state.created[0].passwordHash, h.dto.password);
  assert.match(h.state.locks[0], /Session/);
});
test('logout or role downgrade while hashing prevents global registration with no account written', async () => {
  for (const invalidate of [
    (h) => {
      h.state.session = null;
    },
    (h) => {
      h.state.session.user.role = 'ORGANIZER';
    },
    (h) => {
      h.state.session.expiresAt = new Date(0);
    },
  ]) {
    const h = registerHarness(),
      pending = h.service.register(h.dto, h.actor);
    invalidate(h);
    await assert.rejects(pending, failure(401));
    assert.equal(h.state.created.length, 0);
  }
});
test('ordinary admins cannot create global accounts and invalid names never start a write', async () => {
  const h = registerHarness();
  await assert.rejects(h.service.register(h.dto, { ...h.actor, role: 'ORGANIZER' }), failure(403));
  await assert.rejects(h.service.register({ ...h.dto, name: '  ' }, h.actor), failure(400));
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.locks.length, 0);
});
test('controller uses the trusted request address and retains secure cookies without exposing credential fields', async () => {
  const addresses = [],
    headers = new Map(),
    fake = {
      loginFromAddress: async (email, password, address) => {
        addresses.push(address);
        return { id: 'user', name: 'Admin', role: 'ORGANIZER', passwordHash: 'never-return' };
      },
      session: async () => 'a'.repeat(64),
      acceptFromAddress: async (token, name, address) => {
        addresses.push(address);
        return { token: 'b'.repeat(64), tatamiId: 'mat', tournamentId: 'tournament' };
      },
    };
  const controller = new AuthController(fake, { cookieSecure: true }),
    request = { ip: '192.0.2.1', headers: { 'x-forwarded-for': 'untrusted' } },
    res = { setHeader: (key, value) => headers.set(key, value) };
  const login = await controller.login(request, { email: 'qa@test.example', password: 'QA' }, res);
  assert.deepEqual(login, { name: 'Admin', role: 'ORGANIZER', workRole: 'ADMIN' });
  assert.match(headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict.*; Secure$/);
  assert.equal(headers.get('Cache-Control'), 'no-store');
  const accept = await controller.accept(request, { token: 'secret', name: 'Judge' }, res);
  assert.deepEqual(accept, { tatamiId: 'mat', tournamentId: 'tournament' });
  assert.deepEqual(addresses, ['192.0.2.1', '192.0.2.1']);
  assert.match(headers.get('Set-Cookie'), /; Secure$/);
});
