import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, 'apps/web');
const standalone = join(web, '.next/standalone/apps/web');
try {
  await access(join(standalone, 'server.js'));
  await mkdir(join(standalone, '.next'), { recursive: true });
  await cp(join(web, '.next/static'), join(standalone, '.next/static'), { recursive: true });
  await cp(join(web, 'public'), join(standalone, 'public'), { recursive: true });
} catch {
  console.error('Нет полной сборки сайта. Выполните npm run build из корня проекта.');
  process.exit(1);
}
process.env.PORT = process.env.JUDO_WEB_PORT ?? '4318';
process.env.HOSTNAME = process.env.JUDO_WEB_HOST ?? '127.0.0.1';
process.env.NODE_ENV = 'production';
await import(pathToFileURL(join(standalone, 'server.js')).href);
