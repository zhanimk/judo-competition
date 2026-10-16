import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(
  new URL('../../apps/web/public/judo-offline-sw.js', import.meta.url),
  'utf8',
);
function fixture({
  cached = null,
  fetcher = async () => new Response('network'),
  failPut = false,
} = {}) {
  const handlers = {},
    timers = [],
    fetches = [],
    puts = [];
  runInNewContext(source, {
    URL,
    Response,
    AbortController,
    self: {
      location: { origin: 'https://qa.invalid' },
      addEventListener: (type, handler) => {
        handlers[type] = handler;
      },
    },
    caches: {
      open: async () => ({
        match: async () => cached,
        put: async (key) => {
          if (failPut) throw new Error('quota exceeded');
          puts.push(key);
        },
      }),
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
    fetch: async (request, options) => {
      fetches.push(request.url);
      return fetcher(request, options);
    },
  });
  return {
    fetches,
    puts,
    timers,
    dispatch(path, mode = 'navigate', method = 'GET') {
      let response;
      handlers.fetch({
        request: { url: 'https://qa.invalid' + path, mode, method },
        respondWith: (value) => {
          response = value;
        },
      });
      return response;
    },
  };
}
test('a prepared navigation falls back after a bounded timeout when a connection hangs rather than failing immediately', async () => {
  const f = fixture({
    cached: new Response('prepared operator'),
    fetcher: (_request, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('network timeout'))),
      ),
  });
  const pending = f.dispatch('/operator/qa');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 3000);
  f.timers[0].callback();
  assert.equal(await (await pending).text(), 'prepared operator');
});
test('cached build resources boot immediately without waiting for an unreachable server', async () => {
  const f = fixture({
    cached: new Response('saved build chunk'),
    fetcher: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.equal(
    await (await f.dispatch('/_next/static/chunk.js', 'cors')).text(),
    'saved build chunk',
  );
  assert.equal(f.fetches.length, 0);
  assert.equal(f.timers.length, 0);
});
test('online responses remain usable when offline cache writes fail; no false cache success is recorded', async () => {
  const f = fixture({ failPut: true });
  assert.equal(await (await f.dispatch('/operator/qa')).text(), 'network');
  assert.equal(f.puts.length, 0);
});
test('the worker never caches or replaces API, commands, login, foreign URLs or arbitrary pages', () => {
  const f = fixture();
  for (const [path, method] of [
    ['/api/v1/tatamis/qa/live', 'GET'],
    ['/api/v1/tatamis/qa/live/id/command', 'POST'],
    ['/login', 'GET'],
    ['/tournaments', 'GET'],
  ])
    assert.equal(f.dispatch(path, 'navigate', method), undefined);
  assert.equal(f.fetches.length, 0);
});
test('an unprepared operator cannot be fabricated from a failed network request', async () => {
  const f = fixture({
    fetcher: async () => {
      throw new Error('offline');
    },
  });
  const response = await f.dispatch('/operator/unprepared');
  assert.equal(response.type, 'error');
});
