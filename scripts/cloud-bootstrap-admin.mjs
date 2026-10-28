import { PrismaClient } from '@prisma/client';

// Optional provisioning for hosts without a one-off shell. No default accounts.
// The existing provisioning script retains its transaction, lock and audit guard.
if (process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE) {
  const db = new PrismaClient();
  let empty;
  try {
    empty = (await db.user.count()) === 0;
  } finally {
    await db.$disconnect();
  }
  if (empty) await import('./bootstrap-production-admin.mjs');
  else console.log('Initial administrator provisioning skipped: user store already exists.');
}
