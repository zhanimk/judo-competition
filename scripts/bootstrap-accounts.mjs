import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';
const db = new PrismaClient();
try {
  for (const [email, name, role] of [
    ['admin@judo.local', 'Главный администратор', 'SUPER_ADMIN'],
    ['organizer@judo.local', 'Организатор', 'ORGANIZER'],
  ]) {
    if (await db.user.findUnique({ where: { email } })) {
      console.log(email + ': already exists; credentials unchanged');
      continue;
    }
    const password = randomBytes(18).toString('base64url'),
      salt = randomBytes(16).toString('hex');
    await db.user.create({
      data: {
        email,
        name,
        role,
        passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
      },
    });
    console.log(JSON.stringify({ email, password, role }));
  }
} finally {
  await db.$disconnect();
}
