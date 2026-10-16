import { withdrawalPlan } from './withdrawal-plan.js';
import { profile } from '../rules/profile.js';
import { LiveService } from '../matches/live.service.js';
import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import {
  approveAdditionalRound,
  drawProgress,
  generateDraw,
  resolveMatches,
  type AdditionalRoundApproval,
  type Draw,
} from '@judo/engine/draw';
import { Prisma, type Contest, type DrawRecord } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { MatchState } from '@judo/engine/match';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertActivePrincipal, lockAdminMutation } from '../auth/access-guards.js';
import { assertUnusedCommandIds } from '../matches/command-ids.js';
import type {
  AssignDto,
  AssignmentResult,
  DrawConfirmDto,
  DrawPreviewDto,
  DrawPublicationDto,
  TiebreakCommandDto,
  WithdrawalCommandDto,
} from './draws.dto.js';
import { normalizedName } from '../roster/roster-validation.js';
import { enqueueLive } from '../matches/live-outbox.js';
import {
  confirmedDrawWinners,
  propagateDraw,
  unstartedContest,
  tournamentComplete,
} from './draw-propagation.js';
import { hasOfflineOwnership } from '../matches/offline-ownership.js';
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

function tiebreakPlan(
  record: DrawRecord,
  rows: Contest[],
  approval: AdditionalRoundApproval,
  actorId: string,
  tournamentId: string,
) {
  const before = record.snapshot as unknown as Draw;
  const snapshot = approveAdditionalRound(before, confirmedDrawWinners(rows), approval);
  const resolvedByKey = new Map(
    resolveMatches(snapshot, confirmedDrawWinners(rows)).map((m) => [m.id, m]),
  );
  const additionalMatches = snapshot.matches.filter(
    (match) => !before.matches.some((old) => old.id === match.id),
  );
  const changedRounds = rows.flatMap((row) => {
    const match = snapshot.matches.find((candidate) => candidate.id === row.key);
    return match && match.round !== row.round
      ? [{ id: row.id, key: row.key, beforeRound: row.round, afterRound: match.round }]
      : [];
  });
  const impactToken = createHash('sha256')
    .update(
      JSON.stringify({
        actorId,
        tournamentId,
        categoryId: record.categoryId,
        version: record.version,
        snapshot: record.snapshot,
        approval: {
          parent: approval.parent,
          pool: approval.pool,
          procedure: approval.procedure,
          members:
            approval.procedure === 'ORDERED_PLACES'
              ? [...approval.members]
              : [...approval.members].sort(),
        },
        contests: [...rows]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((row) => {
            const state = row.state as unknown as MatchState | null;
            return { ...row, state: state ? { ...state, receipts: {} } : null };
          }),
      }),
    )
    .digest('hex');
  return {
    parent: approval.parent,
    pool: approval.pool,
    members: approval.members,
    procedure: approval.procedure,
    impactToken,
    additionalMatches,
    changedRounds,
    blocked:
      rows.some((row) => {
        if (hasOfflineOwnership(row)) return true;
        const match = resolvedByKey.get(row.key);
        return (
          match &&
          (row.whiteEntryId !== (match.whiteEntryId ?? null) ||
            row.blueEntryId !== (match.blueEntryId ?? null) ||
            (row.status === 'WAITING' && match.ready)) &&
          !unstartedContest(row)
        );
      }) ||
      changedRounds.some((change) => !unstartedContest(rows.find((row) => row.id === change.id)!)),
    snapshot,
  };
}
@Injectable()
export class DrawsService {
  constructor(
    private readonly live: LiveService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async receipt(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    categoryId: string,
    dto: { id: string },
    type: string,
    user: Principal,
  ) {
    const receipt = await tx.drawCommand.findUnique({ where: { id: dto.id } });
    if (!receipt) return null;
    if (
      receipt.actorId !== user.id ||
      receipt.tournamentId !== tournamentId ||
      receipt.categoryId !== categoryId ||
      receipt.type !== type ||
      !isDeepStrictEqual(receipt.command, json(dto))
    )
      throw new ConflictException('COMMAND_ID_REUSED');
    return receipt;
  }
  private async save(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    categoryId: string,
    dto: { id: string },
    type: string,
    user: Principal,
    response: unknown,
  ) {
    await tx.drawCommand.create({
      data: {
        id: dto.id,
        tournamentId,
        categoryId,
        actorId: user.id,
        type,
        command: json(dto),
        response: json(response),
      },
    });
    return json(response);
  }
  async category(id: string, user: Principal) {
    const c = await this.db.category.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('CATEGORY_NOT_FOUND');
    await this.auth.owner(user, c.tournamentId);
    return c;
  }
  async get(id: string, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(
      async (tx) => {
        await assertActivePrincipal(tx, user, {
          tournamentId: category.tournamentId,
          lockSession: false,
        });
        const draw = await tx.drawRecord.findUnique({
          where: { categoryId: id },
          include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } },
        });
        return {
          draw,
          progress:
            draw && draw.status === 'CONFIRMED'
              ? drawProgress(draw.snapshot as unknown as Draw, confirmedDrawWinners(draw.contests))
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async progress(id: string, user: Principal) {
    const { draw, progress } = await this.get(id, user);
    if (!draw || draw.status !== 'CONFIRMED') throw new ConflictException('DRAW_NOT_CONFIRMED');
    return { drawId: draw.id, version: draw.version, ...progress };
  }
  async tiebreakImpact(id: string, user: Principal, approval?: AdditionalRoundApproval) {
    const category = await this.category(id, user);
    return this.db.$transaction(
      async (tx) => {
        await assertActivePrincipal(tx, user, {
          tournamentId: category.tournamentId,
          lockSession: false,
        });
        const record = await tx.drawRecord.findUnique({
          where: { categoryId: id },
          include: { contests: true },
        });
        if (!record || record.status !== 'CONFIRMED')
          throw new ConflictException('DRAW_NOT_CONFIRMED');
        const progress = drawProgress(
          record.snapshot as unknown as Draw,
          confirmedDrawWinners(record.contests),
        );
        if (approval) {
          let impact: ReturnType<typeof tiebreakPlan>;
          try {
            impact = tiebreakPlan(
              record,
              record.contests,
              approval,
              user.id,
              category.tournamentId,
            );
          } catch (error) {
            throw new ConflictException((error as Error).message);
          }
          const { snapshot: _, ...review } = impact;
          return { drawId: record.id, expectedVersion: record.version, reviews: [review] };
        }
        const reviews = progress.pendingReviews.map((review) => {
          const { snapshot: _, ...impact } = tiebreakPlan(
            record,
            record.contests,
            {
              parent: review.parent,
              pool: review.pool,
              members: review.members,
              procedure: 'ROUND_ROBIN',
            },
            user.id,
            category.tournamentId,
          );
          return impact;
        });
        return { drawId: record.id, expectedVersion: record.version, reviews };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async tiebreak(id: string, dto: TiebreakCommandDto, user: Principal) {
    const category = await this.category(id, user);
    if (dto.reason.trim().length < 3) throw new BadRequestException('REASON_REQUIRED');
    const result = await this.db
      .$transaction(async (tx) => {
        await lockAdminMutation(tx, user, category.tournamentId);
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
        const record = await tx.drawRecord.findUnique({ where: { categoryId: id } });
        if (!record || record.status !== 'CONFIRMED')
          throw new ConflictException('DRAW_NOT_CONFIRMED');
        await tx.$queryRaw`SELECT id FROM "Contest" WHERE "drawId"=${record.id} ORDER BY id FOR UPDATE`;
        const receipt = await tx.drawCommand.findUnique({ where: { id: dto.id } });
        if (receipt) {
          if (
            receipt.actorId !== user.id ||
            receipt.tournamentId !== category.tournamentId ||
            receipt.categoryId !== id ||
            receipt.type !== 'APPROVE_TIE_ROUND' ||
            !isDeepStrictEqual(receipt.command, json(dto))
          )
            throw new ConflictException('COMMAND_ID_REUSED');
          return receipt.response;
        }
        await assertUnusedCommandIds(tx, [dto.id], null);
        if (record.version !== dto.expectedVersion) throw new ConflictException('DRAW_STALE');
        const rows = await tx.contest.findMany({ where: { drawId: record.id } });
        let impact: ReturnType<typeof tiebreakPlan>;
        try {
          impact = tiebreakPlan(record, rows, dto, user.id, category.tournamentId);
        } catch (error) {
          throw new ConflictException((error as Error).message);
        }
        if (impact.impactToken !== dto.impactToken) throw new ConflictException('IMPACT_CHANGED');
        if (impact.blocked) throw new ConflictException('TIEBREAK_DEPENDENCY_STARTED');
        const currentCategory = await tx.category.findUniqueOrThrow({ where: { id } });
        const propagated = await propagateDraw(
          tx,
          record,
          currentCategory.homeTatamiId,
          user.id,
          category.tournamentId,
          impact.snapshot,
        );
        if (await tournamentComplete(tx, category.tournamentId)) {
          await tx.tournament.update({
            where: { id: category.tournamentId },
            data: { status: 'FINISHED' },
          });
          await tx.auditEvent.create({
            data: {
              actorId: user.id,
              tournamentId: category.tournamentId,
              entityId: category.tournamentId,
              action: 'TOURNAMENT_FINISHED',
              payload: json({ commandId: dto.id, source: 'TIEBREAK_DECISION' }),
            },
          });
        }
        const response = json({
          drawId: record.id,
          version: propagated.draw.version,
          progress: propagated.progress,
          addedContestIds: propagated.addedContestIds,
          changedContestIds: propagated.changedContestIds,
        });
        await tx.drawCommand.create({
          data: {
            id: dto.id,
            categoryId: id,
            tournamentId: category.tournamentId,
            actorId: user.id,
            type: 'APPROVE_TIE_ROUND',
            command: json(dto),
            response,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: category.tournamentId,
            entityId: record.id,
            action: 'TIEBREAK_PROCEDURE_APPROVED',
            payload: json({ command: dto, response }),
          },
        });
        await enqueueLive(tx, { tournamentId: category.tournamentId, kind: 'queue' });
        return response;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ConflictException('COMMAND_ID_REUSED');
        throw error;
      });
    this.live.notify({ kind: 'queue', tournamentId: category.tournamentId });
    return result;
  }
  async withdrawalImpact(id: string, entryId: string, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(
      async (tx) => {
        await assertActivePrincipal(tx, user, {
          tournamentId: category.tournamentId,
          lockSession: false,
        });
        const record = await tx.drawRecord.findUnique({ where: { categoryId: id } });
        if (!record || record.status !== 'CONFIRMED')
          throw new ConflictException('DRAW_NOT_CONFIRMED');
        const rows = await tx.contest.findMany({ where: { drawId: record.id } });
        try {
          const { snapshot: _, ...impact } = withdrawalPlan(record, rows, entryId, user.id);
          return { drawId: record.id, ...impact };
        } catch (error) {
          throw new ConflictException((error as Error).message);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async withdraw(id: string, dto: WithdrawalCommandDto, user: Principal) {
    const category = await this.category(id, user);
    if (dto.reason.trim().length < 3) throw new BadRequestException('REASON_REQUIRED');
    const result = await this.db
      .$transaction(async (tx) => {
        await lockAdminMutation(tx, user, category.tournamentId);
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
        const record = await tx.drawRecord.findUnique({ where: { categoryId: id } });
        if (!record || record.status !== 'CONFIRMED')
          throw new ConflictException('DRAW_NOT_CONFIRMED');
        await tx.$queryRaw`SELECT id FROM "Contest" WHERE "drawId"=${record.id} ORDER BY id FOR UPDATE`;
        const receipt = await this.receipt(
          tx,
          category.tournamentId,
          id,
          dto,
          'WITHDRAW_ENTRY',
          user,
        );
        if (receipt) return receipt.response;
        await assertUnusedCommandIds(tx, [dto.id], null);
        if (record.version !== dto.expectedVersion) throw new ConflictException('DRAW_STALE');
        const tournament = await tx.tournament.findUniqueOrThrow({
          where: { id: category.tournamentId },
        });
        if (!['DRAFT', 'RUNNING'].includes(tournament.status))
          throw new ConflictException('TOURNAMENT_FINISHED');
        const rows = await tx.contest.findMany({ where: { drawId: record.id } });
        let impact: ReturnType<typeof withdrawalPlan>;
        try {
          impact = withdrawalPlan(record, rows, dto.entryId, user.id);
        } catch (error) {
          throw new ConflictException((error as Error).message);
        }
        if (impact.impactToken !== dto.impactToken) throw new ConflictException('IMPACT_CHANGED');
        if (impact.blocked) throw new ConflictException('WITHDRAWAL_MATCH_REQUIRES_REVIEW');
        const current = await tx.category.findUniqueOrThrow({ where: { id } });
        const propagated = await propagateDraw(
          tx,
          record,
          current.homeTatamiId,
          user.id,
          category.tournamentId,
          impact.snapshot,
        );
        if (await tournamentComplete(tx, category.tournamentId)) {
          await tx.tournament.update({
            where: { id: category.tournamentId },
            data: { status: 'FINISHED' },
          });
          await tx.auditEvent.create({
            data: {
              actorId: user.id,
              tournamentId: category.tournamentId,
              entityId: category.tournamentId,
              action: 'TOURNAMENT_FINISHED',
              payload: json({ commandId: dto.id, source: 'WITHDRAWAL' }),
            },
          });
        }
        const response = json({
          drawId: record.id,
          version: propagated.draw.version,
          entryId: dto.entryId,
          changedContestIds: propagated.changedContestIds,
          progress: propagated.progress,
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: category.tournamentId,
            entityId: dto.entryId,
            action: 'ENTRY_WITHDRAWN',
            payload: json({ command: dto, response }),
          },
        });
        await enqueueLive(tx, { tournamentId: category.tournamentId, kind: 'queue' });
        return this.save(tx, category.tournamentId, id, dto, 'WITHDRAW_ENTRY', user, response);
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ConflictException('COMMAND_ID_REUSED');
        throw error;
      });
    this.live.notify({ tournamentId: category.tournamentId, kind: 'queue' });
    return result;
  }
  async publication(id: string, dto: DrawPublicationDto, user: Principal) {
    const category = await this.category(id, user);
    const result = await this.db.$transaction(async (tx) => {
      await lockAdminMutation(tx, user, category.tournamentId);
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const receipt = await this.receipt(
        tx,
        category.tournamentId,
        id,
        dto,
        'DRAW_PUBLICATION',
        user,
      );
      if (receipt) return receipt.response;
      const d = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if (!d || d.status !== 'CONFIRMED') throw new ConflictException('DRAW_NOT_CONFIRMED');
      if (d.publicationRevision !== dto.expectedRevision)
        throw new ConflictException('PUBLICATION_STALE');
      await assertUnusedCommandIds(tx, [dto.id], null);
      if (!!d.publishedAt !== dto.published) {
        await tx.drawRecord.update({
          where: { id: d.id },
          data: {
            publishedAt: dto.published ? new Date() : null,
            publicationRevision: { increment: 1 },
          },
        });
        await enqueueLive(tx, { kind: 'result', tournamentId: category.tournamentId });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: category.tournamentId,
            entityId: d.id,
            action: dto.published ? 'DRAW_PUBLISHED' : 'DRAW_HIDDEN',
            payload: json(dto),
          },
        });
      }
      const response = await tx.drawRecord.findUniqueOrThrow({
        where: { id: d.id },
        include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } },
      });
      return this.save(tx, category.tournamentId, id, dto, 'DRAW_PUBLICATION', user, response);
    });
    this.live.notify({ kind: 'result', tournamentId: category.tournamentId });
    return result;
  }
  async preview(id: string, dto: DrawPreviewDto, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(async (tx) => {
      await lockAdminMutation(tx, user, category.tournamentId);
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const receipt = await this.receipt(tx, category.tournamentId, id, dto, 'DRAW_PREVIEW', user);
      if (receipt) return receipt.response;
      const old = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if ((old?.version ?? 0) !== dto.expectedVersion) throw new ConflictException('DRAW_STALE');
      if (old?.status === 'CONFIRMED') throw new ConflictException('DRAW_LOCKED');
      await assertUnusedCommandIds(tx, [dto.id], null);
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
        ...(rules.tieRanking ? { tieRanking: rules.tieRanking } : {}),
        ...(rules.tieMany ? { tieMany: rules.tieMany } : {}),
        ...(rules.roundRobinMedals ? { roundRobinMedals: rules.roundRobinMedals } : {}),
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
          payload: json({ command: dto, version: result.version }),
        },
      });
      await enqueueLive(tx, { kind: 'result', tournamentId: category.tournamentId });
      return this.save(tx, category.tournamentId, id, dto, 'DRAW_PREVIEW', user, {
        ...result,
        contests: [],
      });
    });
  }
  async confirm(id: string, dto: DrawConfirmDto, user: Principal) {
    const category = await this.category(id, user);
    return this.db.$transaction(async (tx) => {
      await lockAdminMutation(tx, user, category.tournamentId);
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${id} FOR UPDATE`;
      const receipt = await this.receipt(tx, category.tournamentId, id, dto, 'DRAW_CONFIRM', user);
      if (receipt) return receipt.response;
      const draw = await tx.drawRecord.findUnique({ where: { categoryId: id } });
      if (!draw) throw new NotFoundException('DRAW_NOT_FOUND');
      if (draw.status === 'STALE') throw new ConflictException('DRAW_ENTRIES_CHANGED');
      if (draw.version !== dto.version) throw new ConflictException('DRAW_STALE');
      await assertUnusedCommandIds(tx, [dto.id], null);
      if (draw.status === 'CONFIRMED')
        return this.save(tx, category.tournamentId, id, dto, 'DRAW_CONFIRM', user, {
          ...draw,
          contests: await tx.contest.findMany({
            where: { drawId: draw.id },
            orderBy: [{ round: 'asc' }, { key: 'asc' }],
          }),
        });
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
          payload: json({ command: dto, version: dto.version }),
        },
      });
      await enqueueLive(tx, { kind: 'queue', tournamentId: category.tournamentId });
      return this.save(tx, category.tournamentId, id, dto, 'DRAW_CONFIRM', user, {
        ...result,
        contests: await tx.contest.findMany({
          where: { drawId: draw.id },
          orderBy: [{ round: 'asc' }, { key: 'asc' }],
        }),
      });
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
        // Logout, access changes and sporting commands use the same lock order.
        // Recheck the session before returning a receipt or changing the queue.
        await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${tournamentId} ORDER BY id FOR UPDATE`;
        await assertActivePrincipal(tx, user, { tournamentId });
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${match.draw.categoryId} FOR UPDATE`;
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
            previous.actorId !== user.id ||
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
          hasOfflineOwnership(row) ||
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
        await enqueueLive(tx, { kind: 'queue', tournamentId, tatamiId: dto.tatamiId });
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
