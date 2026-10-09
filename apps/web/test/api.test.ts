import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, request } from '../src/features/tournaments/api.ts';

test('non-JSON failures retain HTTP status for access checks and safe command retries', async (t) => {
  for (const status of [401, 403, 409, 500, 503]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('<html>upstream unavailable</html>', { status }),
    );
    await assert.rejects(
      request('/test', { id: 'same-command' }),
      (error: unknown) => error instanceof ApiError && error.status === status,
    );
    t.mock.restoreAll();
  }
});

test('structured validation messages and empty error bodies do not crash error handling', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: ['name is required', 'invalid category'] }, { status: 400 }),
  );
  await assert.rejects(
    request('/test'),
    (error: unknown) =>
      error instanceof ApiError && error.message === 'name is required · invalid category',
  );
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json(null, { status: 502 }));
  await assert.rejects(
    request('/test'),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

test('an explicit false or null body still sends a mutation with the CSRF client header', async (t) => {
  const seen: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    seen.push(init);
    return Response.json({ ok: true });
  });
  await request('/test', false);
  await request('/test', null);
  await request('/test');
  assert.deepEqual(
    seen.map((v) => v.method),
    ['POST', 'POST', 'GET'],
  );
  assert.deepEqual(
    seen.map((v) => v.body),
    ['false', 'null', undefined],
  );
  assert.equal((seen[0].headers as Record<string, string>)['X-Judo-Client'], 'web');
});
