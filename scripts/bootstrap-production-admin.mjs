import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
const passwordFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
const reason = process.env.BOOTSTRAP_ADMIN_REASON?.trim();
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  email.length > 254 ||
  !name ||
  name.length > 80 ||
  !passwordFile ||
  !reason ||
  reason.length < 3 ||
  reason.length > 500
)
  throw new Error('BOOTSTRAP_ADMIN_CONFIGURATION_REQUIRED');
const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
if (password.length < 12 || password.length > 200)
  throw new Error('BOOTSTRAP_ADMIN_PASSWORD_LENGTH');
const salt = randomBytes(16).toString('hex');
const passwordHash = salt + ':' + scryptSync(password, salt, 64).toString('hex');
const db = new PrismaClient();
try {
  const admin = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('judo:bootstrap-admin'))`;
    if (await tx.user.count()) throw new Error('BOOTSTRAP_ONLY_EMPTY_USER_STORE');
    const created = await tx.user.create({
      data: { email, name, role: 'SUPER_ADMIN', passwordHash },
      select: { id: true, role: true },
    });
    // There is no tournament before first provisioning. AuditEvent deliberately
    // has a string scope without a Tournament FK; SYSTEM records global setup.
    await tx.auditEvent.create({
      data: {
        actorId: 'SYSTEM',
        tournamentId: 'SYSTEM',
        entityId: created.id,
        action: 'INITIAL_ADMIN_CREATED',
        payload: { reason, role: created.role, channel: 'DEPLOYMENT_CLI' },
      },
    });
    return created;
  });
  console.log(`Created initial ${admin.role}: ${admin.id}. Credentials are not printed.`);
} catch {
  console.error('BOOTSTRAP_ADMIN_FAILED: the user store must be empty and the database ready.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
