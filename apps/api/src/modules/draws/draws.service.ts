import { profile } from '../rules/profile.js';
import { LiveService } from '../matches/live.service.js';
import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { generateDraw, resolveMatches, type Draw } from '@judo/engine/draw';
import { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { MatchState } from '@judo/engine/match';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertUnusedCommandIds } from '../matches/command-ids.js';
import type { AssignDto, AssignmentResult } from './draws.dto.js';
import { normalizedName } from '../roster/roster-validation.js';
type FingerprintEntry = {
  id: string;
  categoryId: string;
  firstName: string;
  lastName: string;
  birthYear: number;
  club: string;
  createdAt: Date;
};
// Keep the exact original Prisma Entry column order. New metadata must not
// invalidate previously saved previews or rewrite confirmed historical draws.
export const entryFingerprint = (entries: FingerprintEntry[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          id: entry.id,
          categoryId: entry.categoryId,
          firstName: entry.firstName,
          lastName: entry.lastName,
          birthYear: entry.birthYear,
          club: entry.club,
          createdAt: entry.createdAt,
        })),
      ),
    )
    .digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type AssignmentReceipt = { command: AssignDto; response: AssignmentResult };
@Injectable()
export class DrawsService {
  constructor(
    private readonly live: LiveService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  async category(id: string, user: Principal) {
    const c = await this.db.category.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('CATEGORY_NOT_FOUND');
    await this.auth.owner(user, c.tournamentId);
    return c;
  }
  async get(id: string, user: Principal) {
    await this.category(id, user);
    const draw = await this.db.drawRecord.findUnique({
      where: { categoryId: id },
      include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } },
    });
    return { draw };
  }
  async publication(id: string, published: boolean, expectedRevision: number, user: Principal) {
    const category = await this.category(id, user);
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const d = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if (!d || d.status !== 'CONFIRMED') throw new ConflictException('DRAW_NOT_CONFIRMED');
      if (!!d.publishedAt !== published) {
        if (d.publicationRevision !== expectedRevision)
          throw new ConflictException('PUBLICATION_STALE');
        await tx.drawRecord.update({
          where: { id: d.id },
          data: {
            publishedAt: published ? new Date() : null,
            publicationRevision: { increment: 1 },
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: category.tournamentId,
            entityId: d.id,
            action: published ? 'DRAW_PUBLISHED' : 'DRAW_HIDDEN',
            payload: { expectedRevision },
          },
        });
      }
      return tx.drawRecord.findUniqueOrThrow({
        where: { id: d.id },
        include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } },
      });
    });
    this.live.notify({ kind: 'result', tournamentId: category.tournamentId });
    return result;
  }
  async preview(id: string, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const old = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if (old?.status === 'CONFIRMED') throw new ConflictException('DRAW_LOCKED');
      const entries = await tx.entry.findMany({
        where: { categoryId: id, archivedAt: null },
        orderBy: { id: 'asc' },
      });
      if (entries.length < 2 || entries.length > 128)
        throw new BadRequestException('DRAW_ENTRY_COUNT');
      const tournament = await tx.tournament.findUniqueOrThrow({
        where: { id: category.tournamentId },
      });
      const rules = profile(tournament.rulesSnapshot);
      if (!rules.drawPolicy) {
        if (category.format === 'REPECHAGE' && entries.length < 8)
          throw new BadRequestException('REPECHAGE_MIN_8');
        if (category.format === 'MIXED' && entries.length < 4)
          throw new BadRequestException('MIXED_MIN_4');
      }
      if (rules.drawPolicy && category.format === 'SINGLE_ELIMINATION')
        throw new BadRequestException('FORMAT_UNSUPPORTED');
      const snapshot = {
        ...generateDraw(
          category.format,
          entries.map((e) => ({
            id: e.id,
            clubId: e.clubId ?? normalizedName(e.club),
          })),
          randomInt(0, 0x100000000),
          rules.drawPolicy ?? 'LEGACY',
        ),
        tieBreak: rules.tieBreak,
      };
      const data = {
        status: 'PREVIEW',
        fingerprint: entryFingerprint(entries),
        snapshot: json(snapshot),
      };
      const result = old
        ? await tx.drawRecord.update({
            where: { id: old.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.drawRecord.create({ data: { categoryId: id, ...data } });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: category.tournamentId,
          action: 'DRAW_PREVIEW',
          entityId: result.id,
          payload: { version: result.version },
        },
      });
      return { ...result, contests: [] };
    });
  }
  async confirm(id: string, version: number, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const draw = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if (!draw) throw new NotFoundException('DRAW_NOT_FOUND');
      if (draw.status === 'STALE') throw new ConflictException('DRAW_ENTRIES_CHANGED');
      if (draw.version !== version) throw new ConflictException('DRAW_STALE');
      if (draw.status === 'CONFIRMED')
        return {
          ...draw,
          contests: await tx.contest.findMany({
            where: { drawId: draw.id },
            orderBy: [{ round: 'asc' }, { key: 'asc' }],
          }),
        };
      const entries = await tx.entry.findMany({
        where: { categoryId: id, archivedAt: null },
        orderBy: { id: 'asc' },
      });
      if (entryFingerprint(entries) !== draw.fingerprint)
        throw new ConflictException('DRAW_ENTRIES_CHANGED');
      const rows = resolveMatches(draw.snapshot as unknown as Draw, {});
      await tx.contest.createMany({
        data: rows.map((m) => ({
          drawId: draw.id,
          key: m.id,
          round: m.round,
          whiteEntryId: m.whiteEntryId,
          blueEntryId: m.blueEntryId,
          status: m.ready ? 'READY' : 'WAITING',
        })),
      });
      const result = await tx.drawRecord.update({
        where: { id: draw.id },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: category.tournamentId,
          action: 'DRAW_CONFIRMED',
          entityId: draw.id,
          payload: { version },
        },
      });
      return {
        ...result,
        contests: await tx.contest.findMany({
          where: { drawId: draw.id },
          orderBy: [{ round: 'asc' }, { key: 'asc' }],
        }),
      };
    });
  }
  async assign(id: string, dto: AssignDto, user: Principal): Promise<AssignmentResult> {
    const match = await this.db.contest.findUnique({
      where: { id },
      include: { draw: { include: { category: true } } },
    });
    if (!match) throw new NotFoundException('MATCH_NOT_FOUND');
    const tournamentId = match.draw.category.tournamentId;
    await this.auth.owner(user, tournamentId);
    const assigned = await this.db
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Tatami" WHERE id=${dto.tatamiId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Contest" WHERE id=${id} FOR UPDATE`;
        const row = await tx.contest.findUniqueOrThrow({
          where: { id },
          include: { draw: true },
        });
        const previous = await tx.matchEvent.findUnique({ where: { id: dto.id } });
        if (previous) {
          const receipt = previous.payload as unknown as AssignmentReceipt;
          if (
            previous.contestId !== id ||
            previous.type !== 'MATCH_ASSIGNED' ||
            !isDeepStrictEqual(receipt.command, json(dto))
          )
            throw new ConflictException('COMMAND_ID_REUSED');
          // Retry a lost response before checking the now-current contest version/status.
          return receipt.response;
        }
        if (row.revision !== dto.expectedRevision) throw new ConflictException('VERSION_CONFLICT');
        await assertUnusedCommandIds(tx, [dto.id], row.state as unknown as MatchState | null);
        if (
          row.status !== 'READY' ||
          row.state ||
          row.offlineSessionId ||
          !row.whiteEntryId ||
          !row.blueEntryId ||
          row.draw.status !== 'CONFIRMED'
        )
          throw new ConflictException('MATCH_NOT_ASSIGNABLE');
        const tatami = await tx.tatami.findFirst({ where: { id: dto.tatamiId, tournamentId } });
        if (!tatami) throw new BadRequestException('TATAMI_MISMATCH');
        const category = await tx.category.findUniqueOrThrow({
          where: { id: match.draw.categoryId },
        });
        if (category.homeTatamiId && category.homeTatamiId !== dto.tatamiId)
          throw new ConflictException('CATEGORY_TATAMI_LOCKED');
        if (row.tatamiId) throw new ConflictException('MATCH_NOT_ASSIGNABLE');
        if (!category.homeTatamiId)
          await tx.category.update({
            where: { id: category.id },
            data: { homeTatamiId: dto.tatamiId },
          });
        const last = await tx.contest.aggregate({
          where: { tatamiId: dto.tatamiId },
          _max: { queueOrder: true },
        });
        const result = await tx.contest.update({
          where: { id },
          data: {
            tatamiId: dto.tatamiId,
            queueOrder: (last._max.queueOrder ?? 0) + 1,
            revision: { increment: 1 },
          },
        });
        const response: AssignmentResult = {
          id: result.id,
          revision: result.revision,
          status: 'READY',
          tatamiId: dto.tatamiId,
          queueOrder: result.queueOrder!,
          updatedAt: result.updatedAt.toISOString(),
        };
        await tx.matchEvent.create({
          data: {
            id: dto.id,
            contestId: id,
            actorId: user.id,
            type: 'MATCH_ASSIGNED',
            payload: json({ command: dto, response }),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId,
            action: 'MATCH_ASSIGNED',
            entityId: id,
            payload: json({
              command: dto,
              before: {
                revision: row.revision,
                tatamiId: row.tatamiId,
                queueOrder: row.queueOrder,
                homeTatamiId: category.homeTatamiId,
              },
              after: response,
            }),
          },
        });
        return response;
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ConflictException('COMMAND_ID_REUSED');
        throw e;
      });
    this.live.notify({ kind: 'queue', tournamentId, tatamiId: dto.tatamiId });
    return assigned;
  }
}
