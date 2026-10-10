import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type Invitation, type Tatami } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyCommand, type MatchState } from '@judo/engine/match';
import { DatabaseService } from '../../database/database.service.js';
import { assertActivePrincipal, workRole } from './access-guards.js';
import type { Principal } from './auth.types.js';
import type { ControlAccessDto, RevokeInvitationDto } from './access.dto.js';
import type { InviteDto } from './auth.dto.js';
import { assertUnusedCommandIds } from '../matches/command-ids.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export type ControlStatus = {
  generation: number;
  held: boolean;
  owned: boolean;
  holderName: string | null;
  holderValid: boolean;
  acquiredAt: string | null;
};

/** Pauses at the last persisted clock value. No uncertain delta or hold score is
 * invented. The persisted hold remains available for explicit adjudication. */
export async function pauseControlledContests(
  tx: Prisma.TransactionClient,
  tatamiId: string,
  context: { actorId: string; tournamentId: string; action: string; reason: string },
) {
  const rows = await tx.contest.findMany({
    where: { tatamiId, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
  });
  for (const row of rows) {
    const before = row.state as unknown as MatchState | null;
    if (!before || before.status !== 'RUNNING') continue;
    const state = applyCommand(before, {
      id: randomUUID(),
      expectedVersion: before.version,
      type: 'RECOVER',
    });
    state.receipts = {};
    const updated = await tx.contest.update({
      where: { id: row.id },
      data: {
        state: json(state),
        revision: { increment: 1 },
        clockAnchorMs: null,
        clockEpoch: null,
      },
    });
    const payload = json({
      action: context.action,
      reason: context.reason,
      revision: updated.revision,
      clockUncertain: true,
      before,
      state,
    });
    await tx.matchEvent.create({
      data: {
        id: randomUUID(),
        contestId: row.id,
        actorId: context.actorId,
        type: 'CONTROL_ACCESS_PAUSED',
        payload,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: context.actorId,
        tournamentId: context.tournamentId,
        action: 'MATCH_ACCESS_PAUSED',
        entityId: row.id,
        payload,
      },
    });
  }
}

@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}

  async status(
    db: Prisma.TransactionClient,
    tatami: Tatami,
    user: Principal,
    deviceId?: string,
  ): Promise<ControlStatus> {
    const held = !!tatami.controllerSessionId;
    let holderValid = false;
    if (held && tatami.controllerActorId && tatami.controllerDeviceId) {
      const holder = await db.session.findUnique({
        where: { id: tatami.controllerSessionId! },
        include: { user: true },
      });
      if (holder) {
        try {
          await assertActivePrincipal(
            db,
            {
              id: holder.userId,
              name: holder.user.name,
              role: holder.user.role,
              tatamiId: holder.tatamiId,
              sessionId: holder.id,
            },
            { tournamentId: tatami.tournamentId, tatamiId: tatami.id, lockSession: false },
          );
          holderValid = holder.userId === tatami.controllerActorId;
        } catch (error) {
          if (!(error instanceof ForbiddenException) && !(error instanceof UnauthorizedException))
            throw error;
        }
      }
    }
    const actor = tatami.controllerActorId
      ? await db.user.findUnique({
          where: { id: tatami.controllerActorId },
          select: { name: true },
        })
      : null;
    return {
      generation: tatami.controlGeneration,
      held,
      owned:
        holderValid &&
        tatami.controllerSessionId === user.sessionId &&
        tatami.controllerActorId === user.id &&
        !!deviceId &&
        tatami.controllerDeviceId === deviceId,
      holderName: actor?.name ?? null,
      holderValid,
      acquiredAt: tatami.controlledAt?.toISOString() ?? null,
    };
  }

  private async locked(
    tx: Prisma.TransactionClient,
    user: Principal,
    tatamiId: string,
    admin = false,
  ) {
    const found = await tx.tatami.findUnique({ where: { id: tatamiId } });
    if (!found) throw new ForbiddenException('FORBIDDEN');
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${found.tournamentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${found.tournamentId} ORDER BY id FOR UPDATE`;
    const mat = await tx.tatami.findUniqueOrThrow({ where: { id: tatamiId } });
    await assertActivePrincipal(tx, user, {
      tournamentId: mat.tournamentId,
      ...(admin ? {} : { tatamiId }),
    });
    await tx.$queryRaw`SELECT id FROM "Contest" WHERE "tatamiId"=${tatamiId} AND status='ACTIVE' ORDER BY id FOR UPDATE`;
    return mat;
  }

  private async receipt(
    tx: Prisma.TransactionClient,
    mat: Tatami,
    user: Principal,
    type: string,
    command: { id: string },
    normalized: Prisma.InputJsonValue,
  ) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${command.id}, 0))`;
    const receipt = await tx.accessCommand.findUnique({ where: { id: command.id } });
    if (receipt) {
      if (
        receipt.tatamiId !== mat.id ||
        receipt.tournamentId !== mat.tournamentId ||
        receipt.actorId !== user.id ||
        receipt.sessionId !== user.sessionId ||
        receipt.type !== type ||
        !isDeepStrictEqual(receipt.command, normalized)
      )
        throw new ConflictException('COMMAND_ID_REUSED');
      return receipt.response;
    }
    await assertUnusedCommandIds(tx, [command.id], null);
    return null;
  }

  private async save(
    tx: Prisma.TransactionClient,
    mat: Tatami,
    user: Principal,
    type: string,
    id: string,
    command: Prisma.InputJsonValue,
    response: unknown,
    payload: unknown,
  ) {
    await tx.accessCommand.create({
      data: {
        id,
        tournamentId: mat.tournamentId,
        tatamiId: mat.id,
        actorId: user.id,
        sessionId: user.sessionId,
        type,
        command,
        response: json(response),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        tournamentId: mat.tournamentId,
        entityId: mat.id,
        action: 'ACCESS_' + type,
        payload: json({ commandId: id, ...(payload as object) }),
      },
    });
  }

  async command(user: Principal, tatamiId: string, dto: ControlAccessDto) {
    return this.db.$transaction(async (tx) => {
      const mat = await this.locked(tx, user, tatamiId, dto.type === 'TAKEOVER');
      const normalized = json(dto);
      const saved = await this.receipt(tx, mat, user, dto.type, dto, normalized);
      if (saved) return saved;
      if (mat.accessRevision !== dto.expectedRevision)
        throw new ConflictException('ACCESS_VERSION_CONFLICT');
      const same =
        mat.controllerSessionId === user.sessionId &&
        mat.controllerActorId === user.id &&
        mat.controllerDeviceId === dto.deviceId;
      let holder: {
        controllerSessionId: string | null;
        controllerDeviceId: string | null;
        controllerActorId: string | null;
        controlledAt: Date | null;
      };
      let generation = mat.controlGeneration;
      if (dto.type === 'CLAIM') {
        if (mat.controllerSessionId && !same) throw new ConflictException('CONTROL_HELD');
        if (!same) generation++;
        holder = {
          controllerSessionId: user.sessionId,
          controllerDeviceId: dto.deviceId,
          controllerActorId: user.id,
          controlledAt: same ? mat.controlledAt : new Date(),
        };
      } else if (dto.type === 'RELEASE') {
        if (!same) throw new ConflictException('CONTROL_HELD');
        const active = await tx.contest.findMany({ where: { tatamiId, status: 'ACTIVE' } });
        if (active.some((row) => row.offlineSessionId))
          throw new ConflictException('OFFLINE_OWNED');
        if (active.some((row) => (row.state as unknown as MatchState | null)?.hold))
          throw new ConflictException('RESOLVE_HOLD_FIRST');
        if (active.some((row) => (row.state as unknown as MatchState | null)?.status === 'RUNNING'))
          throw new ConflictException('PAUSE_REQUIRED');
        holder = {
          controllerSessionId: null,
          controllerDeviceId: null,
          controllerActorId: null,
          controlledAt: null,
        };
        generation++;
      } else {
        if (workRole(user.role) !== 'ADMIN') throw new ForbiddenException('FORBIDDEN');
        if (!dto.reason || dto.reason.trim().length < 3)
          throw new BadRequestException('REASON_REQUIRED');
        if (
          await tx.contest.findFirst({
            where: { tatamiId, status: 'ACTIVE', offlineSessionId: { not: null } },
          })
        )
          throw new ConflictException('OFFLINE_OWNED');
        await pauseControlledContests(tx, tatamiId, {
          actorId: user.id,
          tournamentId: mat.tournamentId,
          action: 'TAKEOVER',
          reason: dto.reason.trim(),
        });
        holder = {
          controllerSessionId: user.sessionId,
          controllerDeviceId: dto.deviceId,
          controllerActorId: user.id,
          controlledAt: new Date(),
        };
        generation++;
      }
      const updated = await tx.tatami.update({
        where: { id: tatamiId },
        data: { ...holder, controlGeneration: generation, accessRevision: { increment: 1 } },
      });
      const response = {
        revision: updated.accessRevision,
        control: await this.status(tx, updated, user, dto.deviceId),
      };
      await this.save(tx, mat, user, dto.type, dto.id, normalized, response, {
        revision: updated.accessRevision,
        generation,
        previousActorId: mat.controllerActorId,
        reason: dto.reason ?? null,
      });
      return response;
    });
  }

  async invite(user: Principal, tatamiId: string, dto: InviteDto) {
    if (!dto.label.trim()) throw new BadRequestException('INVALID_NAME');
    const normalized = json({
      id: dto.id,
      expectedRevision: dto.expectedRevision,
      label: dto.label,
      hours: dto.hours,
      tokenHash: hash(dto.token),
    });
    return this.db.$transaction(async (tx) => {
      const mat = await this.locked(tx, user, tatamiId, true);
      const saved = await this.receipt(tx, mat, user, 'INVITE', dto, normalized);
      if (saved) return { ...(saved as object), token: dto.token };
      if (mat.accessRevision !== dto.expectedRevision)
        throw new ConflictException('ACCESS_VERSION_CONFLICT');
      let invitation: Invitation;
      try {
        invitation = await tx.invitation.create({
          data: {
            tatamiId,
            label: dto.label.trim(),
            tokenHash: hash(dto.token),
            expiresAt: new Date(Date.now() + dto.hours * 3600000),
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ConflictException('INVITATION_TOKEN_REUSED');
        throw error;
      }
      const updated = await tx.tatami.update({
        where: { id: tatamiId },
        data: { accessRevision: { increment: 1 } },
      });
      const response = {
        id: invitation.id,
        expiresAt: invitation.expiresAt.toISOString(),
        revision: updated.accessRevision,
      };
      await this.save(tx, mat, user, 'INVITE', dto.id, normalized, response, {
        invitationId: invitation.id,
        label: invitation.label,
        expiresAt: response.expiresAt,
        revision: updated.accessRevision,
      });
      return { ...response, token: dto.token };
    });
  }

  async revoke(user: Principal, invitationId: string, dto: RevokeInvitationDto) {
    if (dto.reason.trim().length < 3) throw new BadRequestException('REASON_REQUIRED');
    return this.db.$transaction(async (tx) => {
      const invite = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!invite) throw new ForbiddenException('FORBIDDEN');
      const mat = await this.locked(tx, user, invite.tatamiId, true);
      const normalized = json({ ...dto, invitationId });
      const saved = await this.receipt(tx, mat, user, 'REVOKE_INVITATION', dto, normalized);
      if (saved) return saved;
      if (mat.accessRevision !== dto.expectedRevision)
        throw new ConflictException('ACCESS_VERSION_CONFLICT');
      const invitation = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      if (invitation.revokedAt) throw new ConflictException('INVITATION_REVOKED');
      const sessions = await tx.session.findMany({ where: { invitationId }, select: { id: true } });
      const held =
        !!mat.controllerSessionId &&
        sessions.some((session) => session.id === mat.controllerSessionId);
      await tx.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
      if (held)
        await pauseControlledContests(tx, mat.id, {
          actorId: user.id,
          tournamentId: mat.tournamentId,
          action: 'REVOKE_INVITATION',
          reason: dto.reason.trim(),
        });
      await tx.session.deleteMany({ where: { invitationId } });
      const updated = await tx.tatami.update({
        where: { id: mat.id },
        data: {
          accessRevision: { increment: 1 },
          ...(held ? { controlGeneration: { increment: 1 } } : {}),
        },
      });
      const response = {
        ok: true,
        revision: updated.accessRevision,
        control: await this.status(tx, updated, user),
      };
      await this.save(tx, mat, user, 'REVOKE_INVITATION', dto.id, normalized, response, {
        invitationId,
        reason: dto.reason.trim(),
        revision: updated.accessRevision,
        generation: updated.controlGeneration,
        controllerInvalidated: held,
      });
      return response;
    });
  }

  async accept(token: string, name: string) {
    if (!name.trim()) throw new BadRequestException('INVALID_NAME');
    return this.db.$transaction(async (tx) => {
      const found = await tx.invitation.findUnique({
        where: { tokenHash: hash(token) },
        include: { tatami: true },
      });
      if (!found) throw new UnauthorizedException('INVALID_INVITATION');
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${found.tatami.tournamentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${found.tatami.tournamentId} ORDER BY id FOR UPDATE`;
      const now = new Date();
      const invite = await tx.invitation.findUniqueOrThrow({ where: { id: found.id } });
      if (invite.usedAt || invite.revokedAt || invite.expiresAt <= now)
        throw new UnauthorizedException('INVALID_INVITATION');
      await tx.invitation.update({ where: { id: invite.id }, data: { usedAt: now } });
      const user = await tx.user.create({ data: { name: name.trim(), role: 'OPERATOR' } });
      const sessionToken = randomBytes(32).toString('hex');
      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: hash(sessionToken),
          tatamiId: invite.tatamiId,
          invitationId: invite.id,
          expiresAt: new Date(Math.min(now.getTime() + 8 * 3600000, invite.expiresAt.getTime())),
        },
      });
      const updated = await tx.tatami.update({
        where: { id: invite.tatamiId },
        data: { accessRevision: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: found.tatami.tournamentId,
          entityId: invite.id,
          action: 'ACCESS_ACCEPT_INVITATION',
          payload: json({
            invitationId: invite.id,
            tatamiId: invite.tatamiId,
            revision: updated.accessRevision,
          }),
        },
      });
      return {
        token: sessionToken,
        tournamentId: found.tatami.tournamentId,
        tatamiId: invite.tatamiId,
      };
    });
  }

  async logout(user: Principal) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.tatami.findMany({
        where: { controllerSessionId: user.sessionId },
        orderBy: { id: 'asc' },
      });
      for (const tournamentId of [...new Set(initial.map((mat) => mat.tournamentId))].sort()) {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${tournamentId} ORDER BY id FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${user.sessionId} FOR UPDATE`;
      const session = await tx.session.findUnique({ where: { id: user.sessionId } });
      // Concurrent logout requests may both have passed AuthGuard. Once the
      // first deletes this session, the second only clears its client cookie.
      if (!session) return;
      if (session.userId !== user.id) throw new UnauthorizedException('AUTH_REQUIRED');
      const held = await tx.tatami.findMany({
        where: { controllerSessionId: user.sessionId },
        orderBy: { id: 'asc' },
      });
      // A concurrent CLAIM can win between the discovery and the first lock.
      // That mat must be included in the lock set before deleting the session.
      if (held.some((mat) => !initial.some((candidate) => candidate.id === mat.id)))
        throw new ConflictException('ACCESS_CHANGED_RETRY');
      for (const mat of held) {
        await tx.$queryRaw`SELECT id FROM "Contest" WHERE "tatamiId"=${mat.id} AND status='ACTIVE' ORDER BY id FOR UPDATE`;
        await pauseControlledContests(tx, mat.id, {
          actorId: user.id,
          tournamentId: mat.tournamentId,
          action: 'LOGOUT',
          reason: 'Controller session logged out',
        });
        const updated = await tx.tatami.update({
          where: { id: mat.id },
          data: { controlGeneration: { increment: 1 }, accessRevision: { increment: 1 } },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: mat.tournamentId,
            entityId: mat.id,
            action: 'ACCESS_LOGOUT',
            payload: json({
              revision: updated.accessRevision,
              generation: updated.controlGeneration,
              controllerInvalidated: true,
            }),
          },
        });
      }
      await tx.session.deleteMany({ where: { id: user.sessionId, userId: user.id } });
    });
  }
}
