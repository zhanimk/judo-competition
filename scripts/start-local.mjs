import { access, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProcess } from './process-group.mjs';
import { assertPortAvailable, waitForReady } from './local-preflight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const processes = [],
  handles = [];
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  // Stop the web first; let the API finish persisting clocks and commands.
  for (const child of [...processes].reverse()) await child.stop();
  for (const handle of handles) await handle.close();
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.on(signal, () => void stop(code));
async function start(name, args, cwd) {
  const log = await open(join(root, 'tmp/local-run', name + '.log'), 'a', 0o600);
  handles.push(log);
  const managed = startProcess(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', log.fd, log.fd],
    stopGraceMs: 30000,
  });
  processes.push(managed);
  void managed.done.then((result) => {
    if (!stopping) {
      console.error(`${name}: процесс завершился. Журнал: tmp/local-run/${name}.log`);
      void stop(result.code || 1);
    }
  });
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Требуется Node.js 24 или новее.');
  for (const file of [
    'apps/api/.env',
    'apps/api/dist/main.js',
    'apps/web/.next/standalone/apps/web/server.js',
  ]) {
    try {
      await access(join(root, file));
    } catch {
      throw new Error(`Не найден ${file}. Подготовьте .env и выполните npm run build.`);
    }
  }
  await assertPortAvailable(4318);
  await assertPortAvailable(4319);
  await mkdir(join(root, 'tmp/local-run'), { recursive: true, mode: 0o700 });
  const migrationLog = await open(join(root, 'tmp/local-run/migrations.log'), 'a', 0o600);
  handles.push(migrationLog);
  const status = startProcess(
    process.execPath,
    [
      join(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'status',
      '--schema',
      join(root, 'apps/api/prisma/schema.prisma'),
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ['ignore', migrationLog.fd, migrationLog.fd],
    },
  );
  processes.push(status);
  const checked = await status.done;
  processes.splice(processes.indexOf(status), 1);
  if (stopping) throw new Error('Запуск остановлен.');
  if (checked.code !== 0)
    throw new Error(
      'База не готова или есть неприменённые миграции. Сначала резервная копия, затем npm run db:migrate. Журнал: tmp/local-run/migrations.log',
    );
  await start('api', ['--env-file=.env', 'dist/main.js'], join(root, 'apps/api'));
  await waitForReady('http://127.0.0.1:4319/api/v1/health/ready', { stopped: () => stopping });
  await start('web', [join(root, 'scripts/start-web.mjs')], root);
  await waitForReady('http://127.0.0.1:4318/', { stopped: () => stopping });
  console.log(
    'Турнир запущен: http://127.0.0.1:4318\nДля зрителей: http://127.0.0.1:4318/public\nЭто локальный запуск на этом ноутбуке. Для зала используйте инструкцию HTTPS/LAN.\nОстановка: Ctrl+C в этом окне. Данные сохраняются в PostgreSQL.',
  );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
