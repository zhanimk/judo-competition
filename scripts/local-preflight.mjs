import { createServer } from 'node:net';

export async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(
        new Error(
          `Порт ${port} уже занят. Используйте работающий сайт или остановите прежний запуск.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function waitForReady(url, { timeoutMs = 30000, stopped = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!stopped() && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* Startup may not have opened its socket yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Сервис не готов. Проверьте журнал запуска и доступность PostgreSQL.');
}
