import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type Contest } from '@prisma/client';
import { dependentMatches, type Draw } from '@judo/engine/draw';
import type { MatchState } from '@judo/engine/match';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { MatchesService } from '../matches/matches.service.js';
import { LiveService } from '../matches/live.service.js';
import { tatamiQueue } from '../tatamis/queue.js';
import { ControlCommandDto } from './control.dto.js';
import { assertUnusedCommandIds } from '../matches/command-ids.js';
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function plan(draw: Draw, row: Contest, all: Contest[]) {
  const ids = dependentMatches(draw, row.key);
  const dependent = all
    .filter((c) => ids.includes(c.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const signature = [row, ...dependent].map((c) => [
    c.id,
    c.revision,
    c.status,
    c.tatamiId,
    c.queueOrder,
    c.winnerEntryId,
    c.whiteEntryId,
    c.blueEntryId,
  ]);
  return {
    revision: row.revision,
    impactToken: createHash('sha256').update(JSON.stringify(signature)).digest('hex'),
    dependent: dependent.map((c) => ({
      id: c.id,
      key: c.key,
      status: c.status,
      tatamiId: c.tatamiId,
    })),
    blocked: dependent.some((c) => c.status === 'ACTIVE' || c.status === 'CONFIRMED'),
  };
}
@Injectable()
export class ControlService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly matches: MatchesService,
    private readonly live: LiveService,
  ) {}
  async dashboard(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const t = await this.db.tournament.findUniqueOrThrow({
      where: { id },
      include: {
        tatamis: { orderBy: { number: 'asc' } },
        categories: { include: { entries: { where: { archivedAt: null } } } },
      },
    });
    const rows = await this.db.contest.findMany({
      where: { draw: { category: { tournamentId: id } } },
      include: { draw: { select: { categoryId: true } } },
      orderBy: [{ queueOrder: 'asc' }, { round: 'asc' }, { key: 'asc' }],
    });
    const entries = t.categories.flatMap((c) => c.entries);
    const contests = rows.map((c) => ({
      id: c.id,
      key: c.key,
      category: t.categories.find((cat) => cat.id === c.draw.categoryId)!.name,
      durationSeconds: t.categories.find((cat) => cat.id === c.draw.categoryId)!.durationSeconds,
      status: c.status,
      revision: c.revision,
      tatamiId: c.tatamiId,
      queueOrder: c.queueOrder,
      offlineActive: !!c.offlineSessionId,
      white: entries.find((e) => e.id === c.whiteEntryId),
      blue: entries.find((e) => e.id === c.blueEntryId),
      winnerEntryId: c.winnerEntryId,
    }));
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      total: rows.length,
      finished: rows.filter((c) => c.status === 'CONFIRMED').length,
      unassigned: rows.filter((c) => c.status === 'READY' && !c.tatamiId).length,
      tatamis: await Promise.all(
        t.tatamis.map(async (m) => ({
          ...m,
          live: await this.matches.view(m.id),
          queue: await tatamiQueue(this.db, m.id),
          remaining: rows.filter((c) => c.tatamiId === m.id && c.status !== 'CONFIRMED').length,
          finished: rows.filter((c) => c.tatamiId === m.id && c.status === 'CONFIRMED').length,
          scheduledSeconds: contests
            .filter((c) => c.tatamiId === m.id && c.status === 'READY')
            .reduce((n, c) => n + c.durationSeconds, 0),
        })),
      ),
      contests,
    };
  }
  async impact(id: string, contestId: string, user: Principal) {
    await this.auth.owner(user, id);
    const row = await this.db.contest.findFirst({
      where: { id: contestId, draw: { category: { tournamentId: id } } },
      include: { draw: true },
    });
    if (!row) throw new NotFoundException('MATCH_NOT_FOUND');
    const all = await this.db.contest.findMany({ where: { drawId: row.drawId } });
    return plan(row.draw.snapshot as unknown as Draw, row, all);
  }
  async command(id: string, contestId: string, dto: ControlCommandDto, user: Principal) {
    await this.auth.owner(user, id);
    if (dto.reason.trim().length < 3) throw new BadRequestException('REASON_REQUIRED');
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
      // Same lock order as sporting commands; lock all mats for atomic cross-mat moves.
      await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${id} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Contest" WHERE id=${contestId} FOR UPDATE`;
      const row = await tx.contest.findFirst({
        where: { id: contestId, draw: { category: { tournamentId: id } } },
        include: { draw: true },
      });
      if (!row) throw new NotFoundException('MATCH_NOT_FOUND');
      const receipt = await tx.matchEvent.findUnique({ where: { id: dto.id } });
      if (receipt) {
        if (receipt.contestId !== row.id || !isDeepStrictEqual(receipt.payload, json(dto)))
          throw new ConflictException('COMMAND_ID_REUSED');
        return { ok: true };
      }
      if (row.revision !== dto.expectedRevision) throw new ConflictException('VERSION_CONFLICT');
      await assertUnusedCommandIds(tx, [dto.id], row.state as unknown as MatchState | null);
      const all = await tx.contest.findMany({ where: { drawId: row.drawId } });
      const impact = plan(row.draw.snapshot as unknown as Draw, row, all);
      if (impact.impactToken !== dto.impactToken) throw new ConflictException('IMPACT_CHANGED');
      if (row.offlineSessionId && dto.type !== 'RELEASE_OFFLINE')
        throw new ConflictException('OFFLINE_OWNED');
      const savedDraw = row.draw.snapshot as unknown as Draw;
      const savedMatch = savedDraw.matches.find((m) => m.id === row.key);
      // Pool corrections can invalidate generated tie-break rounds. Knockout medal
      // corrections do not alter group standings and use the normal dependency guard.
      if (
        dto.type === 'REOPEN' &&
        savedDraw.tieRounds?.length &&
        (savedDraw.algorithm === 'custom-round-robin-v1' || savedMatch?.pool)
      )
        throw new ConflictException('TIEBREAK_REVIEW_REQUIRED');
      const before = {
        row,
        dependent: all.filter((c) => impact.dependent.some((d) => d.id === c.id)),
      };
      let data: Prisma.ContestUpdateInput = { revision: { increment: 1 } };
      const current = row.state as unknown as MatchState | null;
      if (dto.type === 'RELEASE_OFFLINE') {
        if (!row.offlineSessionId || !current) throw new ConflictException('OFFLINE_NOT_ACTIVE');
        data = {
          ...data,
          offlineSessionId: null,
          offlineActorId: null,
          clockAnchorMs: null,
          clockEpoch: null,
          state: json({
            ...current,
            status: current.status === 'RUNNING' ? 'PAUSED' : current.status,
          }),
        };
      } else if (dto.type === 'MOVE') {
        if (!['READY', 'ACTIVE'].includes(row.status))
          throw new ConflictException('MATCH_NOT_MOVABLE');
        if (current?.status === 'RUNNING') throw new ConflictException('PAUSE_REQUIRED');
        if (current?.hold) throw new ConflictException('RESOLVE_HOLD_FIRST');
        const mat = await tx.tatami.findFirst({
          where: { id: dto.tatamiId ?? '', tournamentId: id },
        });
        if (!mat) throw new BadRequestException('TATAMI_MISMATCH');
        if (
          row.status === 'ACTIVE' &&
          (await tx.contest.findFirst({
            where: { tatamiId: mat.id, status: 'ACTIVE', id: { not: row.id } },
          }))
        )
          throw new ConflictException('TATAMI_BUSY');
        const category = await tx.category.findUniqueOrThrow({
          where: { id: row.draw.categoryId },
        });
        if (!category.homeTatamiId)
          await tx.category.update({
            where: { id: category.id },
            data: { homeTatamiId: row.tatamiId ?? mat.id },
          });
        const last = await tx.contest.aggregate({
          where: { tatamiId: mat.id },
          _max: { queueOrder: true },
        });
        data = {
          ...data,
          tatami: { connect: { id: mat.id } },
          queueOrder: (last._max.queueOrder ?? 0) + 1,
        };
      } else if (dto.type === 'REMOVE') {
        if (row.status !== 'READY') throw new ConflictException('RESET_FIRST');
        data = { ...data, tatami: { disconnect: true }, queueOrder: null };
      } else if (dto.type === 'RESET') {
        if (!['ACTIVE', 'READY'].includes(row.status)) throw new ConflictException('REOPEN_FIRST');
        const last = row.tatamiId
          ? await tx.contest.aggregate({
              where: { tatamiId: row.tatamiId },
              _max: { queueOrder: true },
            })
          : null;
        data = {
          ...data,
          status: 'READY',
          state: Prisma.DbNull,
          clockAnchorMs: null,
          clockEpoch: null,
          winnerEntryId: null,
          resultReason: null,
          confirmedAt: null,
          queueOrder: row.tatamiId ? (last?._max.queueOrder ?? 0) + 1 : null,
        };
      } else {
        if (row.status !== 'CONFIRMED' || !current || !row.tatamiId)
          throw new ConflictException('RESULT_NOT_CONFIRMED');
        if (impact.blocked) throw new ConflictException('DEPENDENT_CONTESTS_STARTED');
        if (
          await tx.contest.findFirst({
            where: {
              status: 'ACTIVE',
              OR: [
                { tatamiId: row.tatamiId },
                { whiteEntryId: { in: [row.whiteEntryId!, row.blueEntryId!] } },
                { blueEntryId: { in: [row.whiteEntryId!, row.blueEntryId!] } },
              ],
            },
          })
        )
          throw new ConflictException('TATAMI_OR_ATHLETE_BUSY');
        // Invalidate only unstarted dependencies. Full old states stay in the audit log.
        for (const c of impact.dependent)
          await tx.contest.update({
            where: { id: c.id },
            data: {
              status: 'WAITING',
              whiteEntryId: null,
              blueEntryId: null,
              tatamiId: null,
              queueOrder: null,
              revision: { increment: 1 },
            },
          });
        data = {
          ...data,
          status: 'ACTIVE',
          winnerEntryId: null,
          resultReason: null,
          confirmedAt: null,
          clockAnchorMs: null,
          clockEpoch: null,
          state: json({
            ...current,
            status: 'PROVISIONAL',
            version: current.version + 1,
            receipts: {},
          }),
        };
        await tx.tournament.update({ where: { id }, data: { status: 'RUNNING' } });
      }
      const updated = await tx.contest.update({ where: { id: row.id }, data });
      for (const matId of new Set(
        [row.tatamiId, updated.tatamiId].filter((s): s is string => !!s),
      )) {
        const active = await tx.contest.count({ where: { tatamiId: matId, status: 'ACTIVE' } });
        await tx.tatami.update({
          where: { id: matId },
          data: { status: active ? 'BUSY' : 'IDLE' },
        });
      }
      try {
        await tx.matchEvent.create({
          data: {
            id: dto.id,
            contestId: row.id,
            actorId: user.id,
            type: 'ADMIN_' + dto.type,
            payload: json(dto),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ConflictException('COMMAND_ID_REUSED');
        throw e;
      }
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: id,
          entityId: row.id,
          action: 'ADMIN_' + dto.type,
          payload: json({ command: dto, before, after: updated }),
        },
      });
      return { ok: true };
    });
    this.live.notify({ kind: 'result', tournamentId: id });
    return result;
  }
}
