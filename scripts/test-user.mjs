import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
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
  delete rules.tieRanking;
  delete rules.tieMany;
  await db.tournament.update({ where: { id: tournamentId }, data: { rulesSnapshot: rules } });
}

/** Raw synthetic registrations still need real, separate identities. Never merge by names. */
export async function createTestEntries(db, entries) {
  return db.$transaction(async (tx) => {
    const categories = await tx.category.findMany({
      where: { id: { in: [...new Set(entries.map((entry) => entry.categoryId))] } },
      select: { id: true, tournament: { select: { ownerId: true } } },
    });
    const owners = new Map(
      categories.map((category) => [category.id, category.tournament.ownerId]),
    );
    const identities = [];
    const data = entries.map((entry) => {
      if (!owners.has(entry.categoryId)) throw new Error('TEST_ENTRY_CATEGORY_MISSING');
      if (entry.athleteId) return entry;
      const athleteId = randomUUID();
      identities.push({ id: athleteId, ownerId: owners.get(entry.categoryId) });
      return { ...entry, athleteId };
    });
    if (identities.length) await tx.athlete.createMany({ data: identities });
    return tx.entry.createMany({ data });
  });
}

/** Explicit historical v3 auto-circle fixtures, never the new tournament default. */
export async function useLegacyV3Rules(db, tournamentId) {
  const t = await db.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  const rules = { ...t.rulesSnapshot, version: 'custom-2026-v3' };
  delete rules.tieRanking;
  delete rules.tieMany;
  await db.tournament.update({ where: { id: tournamentId }, data: { rulesSnapshot: rules } });
}
