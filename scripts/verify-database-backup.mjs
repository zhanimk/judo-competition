import { mkdir, writeFile } from 'node:fs/promises';
import { createVerifiedBackup } from './backup-database.mjs';

const report = await createVerifiedBackup(process.env.DATABASE_URL);
await mkdir('docs/reports', { recursive: true });
await writeFile(
  'docs/reports/latest-backup-verification.json',
  JSON.stringify(report, null, 2) + '\n',
);
if (report.passed) {
  console.log(
    `PASS: ${report.tables.length} tables and schema match the exported snapshot; disposable database removed.`,
  );
  console.log(`Backup: ${report.dumpPath}`);
} else {
  process.exitCode = 1;
  console.error(
    `FAIL: database backup verification did not complete. Private details: ${report.output}/failure.log`,
  );
}
