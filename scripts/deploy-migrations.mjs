import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'apps/api/prisma');
const staging = await mkdtemp(join(tmpdir(), 'judo-migrations-'));
async function deploy(schema) {
  const child = spawn(
    process.execPath,
    [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema],
    { stdio: 'inherit', env: process.env },
  );
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Migration deployment failed (${code})`);
}
try {
  // 007/008 historically sort before the timestamped base migrations. Keep their
  // names/checksums intact for installed databases and install prerequisites first.
  await cp(join(source, 'schema.prisma'), join(staging, 'schema.prisma'));
  await mkdir(join(staging, 'migrations'));
  await cp(
    join(source, 'migrations/migration_lock.toml'),
    join(staging, 'migrations/migration_lock.toml'),
  );
  for (const name of [
    '202610080001_initial_preparation',
    '202610080002_tatamis',
    '202610080003_access',
    '202610080004_draws',
    '202610080005_publication',
    '202610080006_live_matches',
  ])
    await cp(join(source, 'migrations', name), join(staging, 'migrations', name), {
      recursive: true,
    });
  await deploy(join(staging, 'schema.prisma'));
  await deploy(join(source, 'schema.prisma'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
