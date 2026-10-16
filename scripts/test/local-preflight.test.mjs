import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { assertPortAvailable, waitForReady } from '../local-preflight.mjs';

test('local launcher refuses an occupied port without stopping the existing service', async () => {
  const server = createServer((_, res) => res.end('still running'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    await assert.rejects(assertPortAvailable(port), /уже занят/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'still running');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertPortAvailable(port);
});

test('local launcher waits for readiness and rejects failed or cancelled startup', async () => {
  let calls = 0;
  const server = createServer((_, res) => {
    res.statusCode = ++calls < 3 ? 503 : 200;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitForReady(url, { timeoutMs: 2000 });
    assert.equal(calls, 3);
    await assert.rejects(waitForReady(url, { stopped: () => true }), /не готов/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(waitForReady(url, { timeoutMs: 150 }), /не готов/);
});
