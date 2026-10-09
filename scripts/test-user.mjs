import { randomBytes, scryptSync } from 'node:crypto';
export async function createTestUser(db, role = 'ORGANIZER') {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const user = await db.user.create({
    data: {
      email: crypto.randomUUID() + '@test.example',
      name: 'Integration',
      role,
      passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
    },
  });
  return { ...user, password };
}

/** Historical fixtures retain v2 rules; new-policy coverage uses the normal tournament API. */
export async function useLegacyRules(db, tournamentId) {
  const t = await db.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  const rules = { ...t.rulesSnapshot, version: 'custom-2026-v2' };
  delete rules.drawPolicy;
  await db.tournament.update({ where: { id: tournamentId }, data: { rulesSnapshot: rules } });
}
