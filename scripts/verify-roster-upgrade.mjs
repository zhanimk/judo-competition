import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertDisposableDatabase,
  createVerifiedBackup,
  quoteIdentifier,
} from './backup-database.mjs';

function digest(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.value).update('\n');
  return hash.digest('hex');
}

function projection(schema, table, columns, migrationIds) {
  const fields = columns.map((name) => {
    quoteIdentifier(name);
    return `'${name}',t.${quoteIdentifier(name)}`;
  });
  const nullFlags = columns.map((name) => `t.${quoteIdentifier(name)} IS NULL`);
  const value = `jsonb_build_object('data', jsonb_build_object(${fields.join(',')}), 'sqlNulls', ARRAY[${nullFlags.join(',')}])::text`;
  const filter = migrationIds
    ? ` WHERE t.id IN (${migrationIds.map((_, index) => '$' + (index + 1)).join(',') || 'NULL'})`
    : '';
  return `SELECT ${value} AS value FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} t${filter} ORDER BY ${value} COLLATE "C"`;
}

async function settings(tx) {
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
  await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'");
  await tx.$executeRawUnsafe('SET LOCAL extra_float_digits = 3');
  await tx.$executeRawUnsafe("SET LOCAL bytea_output = 'hex'");
}

async function deploy(url, output, label) {
  const child = spawn(process.execPath, ['scripts/deploy-migrations.mjs'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  let log = '';
  child.stdout.on('data', (part) => (log += part));
  child.stderr.on('data', (part) => (log += part));
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('close', (code) => resolve({ code }));
  });
  await writeFile(join(output, label + '.log'), log + (result.error?.stack ?? ''), {
    mode: 0o600,
  });
  if (result.code !== 0) throw new Error('ROSTER_UPGRADE_DEPLOY_FAILED');
}

const sourceUrl = process.env.DATABASE_URL;
const sourceName = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
const report = await createVerifiedBackup(sourceUrl, {
  outputRoot: 'tmp/roster-upgrade',
  async validateRestored(url, output) {
    const connection = new URL(url);
    assertDisposableDatabase(decodeURIComponent(connection.pathname.slice(1)), sourceName);
    const schema = connection.searchParams.get('schema') ?? 'public';
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
      const [{ present }] = await db.$queryRaw`
        SELECT count(*)::int AS present FROM information_schema.columns
        WHERE table_schema=${schema} AND table_name='Entry' AND column_name='clubId'
      `;
      let unicodeFixtureEntries = 0;
      if (!present) {
        // Synthetic legacy data is inserted only into the already verified disposable clone.
        const tournamentId = randomUUID(),
          categoryId = randomUUID();
        await db.$executeRawUnsafe(
          `INSERT INTO ${quoteIdentifier(schema)}."Tournament"
           (id,name,city,venue,"startDate","endDate","tatamiCount")
           VALUES ($1,'Temporary Unicode upgrade fixture','QA','QA','2026-10-10','2026-10-10',1)`,
          tournamentId,
        );
        await db.$executeRawUnsafe(
          `INSERT INTO ${quoteIdentifier(schema)}."Category"
           (id,"tournamentId",name,gender,"birthYearFrom","birthYearTo","maxWeightGrams","durationSeconds")
           VALUES ($1,$2,'QA legacy category','MALE',2012,2013,30000,180)`,
          categoryId,
          tournamentId,
        );
        for (const club of [
          ' \uFEFFАлға\u00A0  Барыс\u2003 ',
          'алға\tбарыс',
          ' ＡＬＧＡ \u2028Астана ',
          'Alga Астана',
          'Жеңіс',
          'ЖАС ҚЫРАН',
          'жас қыран',
          'ΟΣ Club',
          'ος club',
          'İSTANBUL',
          'i\u0307stanbul',
        ]) {
          await db.$executeRawUnsafe(
            `INSERT INTO ${quoteIdentifier(schema)}."Entry"
             (id,"categoryId","firstName","lastName","birthYear",club)
             VALUES ($1,$2,'Әлихан',$3,2012,$4)`,
            randomUUID(),
            categoryId,
            'QA ' + unicodeFixtureEntries,
            club,
          );
          unicodeFixtureEntries++;
        }
      }
      const baseline = await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await settings(tx);
          const tables = await tx.$queryRaw`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema=${schema} AND table_type='BASE TABLE'
            ORDER BY table_name COLLATE "C"
          `;
          const snapshots = [];
          for (const { table_name: table } of tables) {
            const fields = await tx.$queryRaw`
              SELECT column_name FROM information_schema.columns
              WHERE table_schema=${schema} AND table_name=${table} ORDER BY ordinal_position
            `;
            const columns = fields.map((field) => field.column_name);
            const rows = await tx.$queryRawUnsafe(projection(schema, table, columns));
            snapshots.push({
              table,
              columns,
              count: rows.length,
              sha256: digest(rows),
              migrationIds:
                table === '_prisma_migrations'
                  ? rows.map((row) => JSON.parse(row.value).data.id)
                  : undefined,
            });
          }
          return snapshots;
        },
        { isolationLevel: 'RepeatableRead', timeout: 60000 },
      );
      await deploy(url, output, 'upgrade-migrations');
      await deploy(url, output, 'upgrade-migrations-repeat');
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await settings(tx);
          for (const { table, columns, count, sha256, migrationIds } of baseline) {
            const rows = await tx.$queryRawUnsafe(
              projection(schema, table, columns, migrationIds),
              ...(migrationIds ?? []),
            );
            assert.equal(rows.length, count, table + ': old row count changed');
            assert.equal(digest(rows), sha256, table + ': old values changed');
          }
          const [{ invalid }] = await tx.$queryRawUnsafe(`
            SELECT count(*)::int AS invalid FROM ${quoteIdentifier(schema)}."Entry" e
            JOIN ${quoteIdentifier(schema)}."Category" c ON c.id=e."categoryId"
            LEFT JOIN ${quoteIdentifier(schema)}."Club" k ON k.id=e."clubId"
            WHERE k.id IS NULL OR k."tournamentId" <> c."tournamentId"
          `);
          assert.equal(invalid, 0, 'legacy club links missing or outside tournament');
          const links = await tx.$queryRawUnsafe(`
            SELECT e.club,k."normalizedName",e.gender,c.gender AS "categoryGender"
            FROM ${quoteIdentifier(schema)}."Entry" e
            JOIN ${quoteIdentifier(schema)}."Category" c ON c.id=e."categoryId"
            JOIN ${quoteIdentifier(schema)}."Club" k ON k.id=e."clubId"
          `);
          for (const link of links) {
            const normalized = link.club
              .normalize('NFKC')
              .trim()
              .replace(/\s+/g, ' ')
              .toLocaleLowerCase('ru');
            assert.equal(link.normalizedName, normalized, 'legacy club normalization differs');
            assert.ok(
              link.gender === null || link.gender === link.categoryGender,
              'legacy gender must be inferred or match its category',
            );
          }
          const identities = await tx.$queryRawUnsafe(`
            SELECT e.id,e."athleteId",a."ownerId",t."ownerId" AS "tournamentOwnerId"
            FROM ${quoteIdentifier(schema)}."Entry" e
            JOIN ${quoteIdentifier(schema)}."Category" c ON c.id=e."categoryId"
            JOIN ${quoteIdentifier(schema)}."Tournament" t ON t.id=c."tournamentId"
            LEFT JOIN ${quoteIdentifier(schema)}."Athlete" a ON a.id=e."athleteId"
          `);
          const hadIdentities = baseline
            .find((table) => table.table === 'Entry')
            ?.columns.includes('athleteId');
          for (const identity of identities) {
            assert.ok(identity.athleteId, 'registration requires a durable athlete identity');
            assert.equal(
              identity.ownerId,
              identity.tournamentOwnerId,
              'identity owner scope differs',
            );
            if (!hadIdentities)
              assert.equal(
                identity.athleteId,
                identity.id,
                'historical identities must remain separate',
              );
          }
          if (!hadIdentities)
            assert.equal(
              new Set(identities.map((entry) => entry.athleteId)).size,
              identities.length,
              'historical names must never be merged',
            );
          const [{ is_nullable: identityNullable }] = await tx.$queryRaw`
            SELECT is_nullable FROM information_schema.columns
            WHERE table_schema=${schema} AND table_name='Entry' AND column_name='athleteId'
          `;
          assert.equal(identityNullable, 'NO', 'identity must be required in PostgreSQL');
          const hadAccessControl = baseline
            .find((table) => table.table === 'Tatami')
            ?.columns.includes('controlGeneration');
          if (!hadAccessControl) {
            const mats = await tx.tatami.findMany();
            for (const mat of mats) {
              assert.equal(mat.accessRevision, 0, 'initial access revision');
              assert.equal(mat.controlGeneration, 0, 'initial control generation');
              assert.equal(mat.controllerSessionId, null, 'must not invent a controller');
              assert.equal(mat.controllerDeviceId, null, 'must not invent a control device');
              assert.equal(mat.controllerActorId, null, 'must not invent a control actor');
            }
            assert.equal(await tx.accessCommand.count(), 0, 'must not invent access receipts');
          }
        },
        { isolationLevel: 'RepeatableRead', timeout: 60000 },
      );
      return {
        passed: true,
        oldTablesPreserved: baseline.length,
        oldColumnValuesPreserved: true,
        oldEntryAndDrawIdsPreserved: true,
        legacyClubLinksVerified: true,
        clubNormalizationVerified: true,
        legacyGenderCompatible: true,
        unicodeFixtureEntries,
        migrationsAppliedTwice: true,
        athleteIdentityLinksVerified: true,
        athleteOwnerScopeVerified: true,
        athleteIdentityRequired: true,
        historicalAthletesNotMerged: true,
        accessControlDefaultsVerified: true,
        historicalAccessAndAccountsPreserved: true,
      };
    } finally {
      await db.$disconnect();
    }
  },
});
await mkdir('docs/reports', { recursive: true });
await writeFile('docs/reports/latest-roster-upgrade.json', JSON.stringify(report, null, 2) + '\n');
if (report.passed) {
  console.log('PASS: roster upgrade preserves every old column and row; QA database removed.');
  console.log(`Report: ${report.output}/report.json`);
} else {
  process.exitCode = 1;
  console.error(`FAIL: roster upgrade rehearsal. Private details: ${report.output}/failure.log`);
}
