// Explicit local maintenance command. Never assigns existing tournaments automatically.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const [tournamentId, email] = process.argv.slice(2);
try {
  if (!tournamentId || !email)
    throw Error(
      'Usage: node --env-file=apps/api/.env scripts/assign-legacy-owner.mjs TOURNAMENT_ID OWNER_EMAIL',
    );
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.role !== 'ORGANIZER') throw Error('Organizer not found');
  const result = await db.tournament.updateMany({
    where: { id: tournamentId, ownerId: null },
    data: { ownerId: user.id },
  });
  if (result.count !== 1) throw Error('Tournament missing or already assigned');
  console.log('Owner assigned.');
} finally {
  await db.$disconnect();
}
