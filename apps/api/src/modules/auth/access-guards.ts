import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Principal } from './auth.types.js';

export function workRole(role: string): 'ADMIN' | 'JUDGE' | null {
  if (role === 'SUPER_ADMIN' || role === 'ORGANIZER') return 'ADMIN';
  return role === 'OPERATOR' ? 'JUDGE' : null;
}

/** Administrative writes share the same lock order as logout and live commands. */
export async function lockAdminMutation(
  tx: Prisma.TransactionClient,
  user: Principal,
  tournamentId: string,
) {
  await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${tournamentId} ORDER BY id FOR UPDATE`;
  await assertActivePrincipal(tx, user, { tournamentId });
}

/** Call inside the mutation transaction after its Tournament/Tatami locks.
 * AuthGuard is an initial check; this check orders expiry/revocation/logout
 * against sporting and administrative commands on those same locks. */
export async function assertSessionIdentity(
  tx: Prisma.TransactionClient,
  user: Principal,
  lockSession = true,
) {
  if (lockSession)
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${user.sessionId} FOR UPDATE`;
  const session = await tx.session.findUnique({
    where: { id: user.sessionId },
    include: { user: true },
  });
  const at = new Date();
  if (
    !session ||
    session.userId !== user.id ||
    session.user.id !== user.id ||
    session.user.role !== user.role ||
    session.expiresAt <= at
  )
    throw new UnauthorizedException('AUTH_REQUIRED');
  if (session.invitationId) {
    const invitation = await tx.invitation.findUnique({ where: { id: session.invitationId } });
    if (
      !invitation ||
      invitation.revokedAt ||
      invitation.expiresAt <= at ||
      invitation.tatamiId !== session.tatamiId
    )
      throw new UnauthorizedException('AUTH_REQUIRED');
  }
  return session;
}

export async function assertActivePrincipal(
  tx: Prisma.TransactionClient,
  user: Principal,
  scope: { tournamentId: string; tatamiId?: string; lockSession?: boolean },
) {
  const session = await assertSessionIdentity(tx, user, scope.lockSession !== false);
  const tournament = await tx.tournament.findUnique({ where: { id: scope.tournamentId } });
  if (!tournament) throw new ForbiddenException('FORBIDDEN');
  if (session.user.role === 'SUPER_ADMIN') return session;
  if (session.user.role === 'ORGANIZER' && tournament.ownerId === user.id) return session;
  if (
    session.user.role === 'OPERATOR' &&
    scope.tatamiId &&
    session.tatamiId === scope.tatamiId &&
    user.tatamiId === scope.tatamiId &&
    session.invitationId &&
    (await tx.tatami.findFirst({ where: { id: scope.tatamiId, tournamentId: scope.tournamentId } }))
  )
    return session;
  throw new ForbiddenException('FORBIDDEN');
}

export type ControlGrant = { deviceId: string; controlGeneration: number };

/** Caller holds the Tournament and Tatami row locks, before Athlete locks. */
export async function assertTatamiControl(
  tx: Prisma.TransactionClient,
  user: Principal,
  tatamiId: string,
  grant: ControlGrant,
) {
  const tatami = await tx.tatami.findUnique({ where: { id: tatamiId } });
  if (!tatami) throw new ForbiddenException('FORBIDDEN');
  await assertActivePrincipal(tx, user, { tournamentId: tatami.tournamentId, tatamiId });
  if (!grant.deviceId || !Number.isSafeInteger(grant.controlGeneration))
    throw new ConflictException('CONTROL_REQUIRED');
  if (grant.controlGeneration !== tatami.controlGeneration)
    throw new ConflictException('CONTROL_GENERATION_STALE');
  if (!tatami.controllerSessionId) throw new ConflictException('CONTROL_REQUIRED');
  if (
    tatami.controllerSessionId !== user.sessionId ||
    tatami.controllerActorId !== user.id ||
    tatami.controllerDeviceId !== grant.deviceId
  )
    throw new ConflictException('CONTROL_HELD');
  return tatami;
}
