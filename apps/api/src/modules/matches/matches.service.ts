import { matchRules, profile } from '../rules/profile.js';
import { readyQueue, unfinishedRound } from '../tatamis/queue.js';
import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Prisma, type Contest } from '@prisma/client';
import { createMatch, applyCommand, type MatchState, type Command } from '@judo/engine/match';
import { resolveMatches, appendRematches, type Draw } from '@judo/engine/draw';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertActivePrincipal, assertTatamiControl } from '../auth/access-guards.js';
import { LiveService } from './live.service.js';
import { MatchCommandDto } from './matches.dto.js';
import { assertUnusedCommandIds } from './command-ids.js';
import { lockContestAthletes, requireAvailableAthletes } from './athlete-guards.js';
import { hasOfflineOwnership, hasIncompleteOfflineOwnership } from './offline-ownership.js';
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const now = () => Number(process.hrtime.bigint() / 1000000n);
const commandResult = (row: Contest) => ({
  contestId: row.id,
  revision: row.revision,
  status: row.status,
  state: row.state,
  updatedAt: row.updatedAt.toISOString(),
});
type CommandReceipt = { command: MatchCommandDto; response: ReturnType<typeof commandResult> };
@Injectable()
export class MatchesService implements OnModuleInit, OnModuleDestroy {
  private readonly epoch = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private logger = new Logger(MatchesService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly live: LiveService,
  ) {}
  async onModuleInit() {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.logger.error(e));
    }, 500);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  private advance(row: Contest, at: number) {
    const s = row.state as unknown as MatchState;
    if (s.status !== 'RUNNING') return s;
    if (row.clockEpoch !== this.epoch || row.clockAnchorMs === null)
      return { ...s, status: 'PAUSED' as const };
    const next = applyCommand(s, {
      id: randomUUID(),
      expectedVersion: s.version,
      type: 'ADVANCE',
      ms: Math.max(0, Math.floor(at - row.clockAnchorMs)),
    });
    next.receipts = {};
    return next;
  }
  private async recordHoldScore(tx: Prisma.TransactionClient, row: Contest, state: MatchState) {
    const before = row.state as unknown as MatchState;
    if (!before?.hold || isDeepStrictEqual(before.awards, state.awards)) return;
    await tx.matchEvent.create({
      data: {
        id: randomUUID(),
        contestId: row.id,
        actorId: 'SYSTEM',
        type: 'HOLD_SCORE_UPDATED',
        payload: json({ previousAwardId: before.hold.awardId, state }),
      },
    });
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active = await this.db.contest.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          tatamiId: true,
          draw: { select: { category: { select: { tournamentId: true } } } },
        },
      });
      for (const item of active) {
        const changed = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${item.draw.category.tournamentId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${item.draw.category.tournamentId} ORDER BY id FOR UPDATE`;
          const mat = item.tatamiId
            ? await tx.tatami.findUnique({ where: { id: item.tatamiId } })
            : null;
          let holderValid = false;
          if (mat?.controllerSessionId && mat.controllerActorId && mat.controllerDeviceId) {
            const holder = await tx.session.findUnique({
              where: { id: mat.controllerSessionId },
              include: { user: true },
            });
            if (holder && holder.userId === mat.controllerActorId) {
              try {
                await assertActivePrincipal(
                  tx,
                  {
                    id: holder.userId,
                    name: holder.user.name,
                    role: holder.user.role,
                    tatamiId: holder.tatamiId,
                    sessionId: holder.id,
                  },
                  { tournamentId: mat.tournamentId, tatamiId: mat.id },
                );
                holderValid = true;
              } catch (error) {
                if (
                  !(error instanceof ForbiddenException) &&
                  !(error instanceof UnauthorizedException)
                )
                  throw error;
              }
            }
          }
          await tx.$queryRaw`SELECT id FROM "Contest" WHERE id=${item.id} FOR UPDATE`;
          const row = await tx.contest.findUnique({ where: { id: item.id } });
          if (!row || row.status !== 'ACTIVE' || !row.state) return false;
          const s = row.state as unknown as MatchState;
          if (s.status !== 'RUNNING') return false;
          if (!holderValid || row.tatamiId !== mat?.id) {
            const state = applyCommand(s, {
              id: randomUUID(),
              expectedVersion: s.version,
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
              reason: 'CONTROL_HOLDER_UNAVAILABLE',
              revision: updated.revision,
              clockUncertain: true,
              before: s,
              state,
            });
            await tx.matchEvent.create({
              data: {
                id: randomUUID(),
                contestId: row.id,
                actorId: 'SYSTEM',
                type: 'CONTROL_LOST_PAUSED',
                payload,
              },
            });
            await tx.auditEvent.create({
              data: {
                actorId: 'SYSTEM',
                tournamentId: item.draw.category.tournamentId,
                entityId: row.id,
                action: 'MATCH_CONTROL_LOST_PAUSED',
                payload,
              },
            });
            return true;
          }
          // A valid offline lease owns its own clock and event journal. Only
          // lost access pauses its saved snapshot; the lease remains for review.
          if (hasOfflineOwnership(row)) return false;
          const at = now(),
            state = this.advance(row, at),
            recovery = row.clockEpoch !== this.epoch,
            terminal = !recovery && (state.status === 'DECISION' || state.status === 'PROVISIONAL');
          await this.recordHoldScore(tx, row, state);
          const updated = await tx.contest.update({
            where: { id: row.id },
            data: {
              state: json(state),
              clockAnchorMs: at,
              clockEpoch: this.epoch,
              ...(recovery || terminal ? { revision: { increment: 1 } } : {}),
            },
          });
          if (recovery)
            await tx.matchEvent.create({
              data: {
                id: randomUUID(),
                contestId: row.id,
                actorId: 'SYSTEM',
                type: 'CLOCK_RECOVERY_PAUSED',
                payload: json({ state }),
              },
            });
          if (terminal) {
            const payload = json({
              cause:
                state.status === 'DECISION' || state.outcome?.reason === 'TIME'
                  ? 'REGULAR_TIME_EXPIRED'
                  : 'HOLD_SCORE_FINISHED',
              revision: updated.revision,
              before: s,
              state,
            });
            await tx.matchEvent.create({
              data: {
                id: randomUUID(),
                contestId: row.id,
                actorId: 'SYSTEM',
                type: 'CLOCK_TERMINAL_REACHED',
                payload,
              },
            });
            await tx.auditEvent.create({
              data: {
                actorId: 'SYSTEM',
                tournamentId: item.draw.category.tournamentId,
                entityId: row.id,
                action: 'MATCH_CLOCK_TERMINAL_REACHED',
                payload,
              },
            });
          }
          return true;
        });
        if (changed)
          this.live.notify({
            kind: 'state',
            tournamentId: item.draw.category.tournamentId,
            tatamiId: item.tatamiId!,
          });
      }
    } finally {
      this.ticking = false;
    }
  }
  async view(tatamiId: string) {
    const mat = await this.db.tatami.findUnique({
      where: { id: tatamiId },
      include: { tournament: { select: { id: true, name: true, status: true } } },
    });
    if (!mat) throw new NotFoundException('TATAMI_NOT_FOUND');
    const row = await this.db.contest.findFirst({
      where: { tatamiId, status: 'ACTIVE' },
      include: {
        draw: { include: { category: { include: { entries: { where: { archivedAt: null } } } } } },
      },
    });
    const recent = await this.db.contest.findFirst({
      where: { tatamiId, status: 'CONFIRMED' },
      orderBy: { confirmedAt: 'desc' },
      include: {
        draw: { include: { category: { include: { entries: { where: { archivedAt: null } } } } } },
      },
    });
    if (!row)
      return {
        tournamentId: mat.tournamentId,
        tournamentName: mat.tournament.name,
        tournamentStatus: mat.tournament.status,
        number: mat.number,
        currentMatch: null,
        lastResult: recent
          ? {
              id: recent.id,
              key: recent.key,
              resultReason: recent.resultReason,
              winner: (() => {
                const e = recent.draw.category.entries.find((e) => e.id === recent.winnerEntryId);
                return e
                  ? { id: e.id, firstName: e.firstName, lastName: e.lastName, club: e.club }
                  : null;
              })(),
            }
          : null,
      };
    const entries = row.draw.category.entries;
    const person = (id: string | null) => {
      const e = entries.find((e) => e.id === id);
      return e ? { id: e.id, firstName: e.firstName, lastName: e.lastName, club: e.club } : null;
    };
    const state = structuredClone(row.state) as unknown as MatchState;
    state.receipts = {};
    return {
      tournamentId: mat.tournamentId,
      tournamentName: mat.tournament.name,
      tournamentStatus: mat.tournament.status,
      number: mat.number,
      lastResult: recent
        ? {
            id: recent.id,
            key: recent.key,
            resultReason: recent.resultReason,
            winner: (() => {
              const e = recent.draw.category.entries.find((e) => e.id === recent.winnerEntryId);
              return e
                ? { id: e.id, firstName: e.firstName, lastName: e.lastName, club: e.club }
                : null;
            })(),
          }
        : null,
      currentMatch: {
        id: row.id,
        key: row.key,
        category: row.draw.category.name,
        revision: row.revision,
        offlineActive: hasOfflineOwnership(row),
        updatedAt: row.updatedAt,
        state,
        white: person(row.whiteEntryId),
        blue: person(row.blueEntryId),
      },
    };
  }
  async publicView(tatamiId: string, cookie?: string) {
    await this.auth.viewTatami(await this.auth.authenticate(cookie), tatamiId);
    return this.view(tatamiId);
  }
  async command(tatamiId: string, id: string, dto: MatchCommandDto, user: Principal) {
    const access = await this.auth.control(user, tatamiId);
    // Tournament/mat/contest locks precede shared Athlete locks. Lock this
    // tournament's mats now so result propagation never takes a late mat lock.
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${access.tournamentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${access.tournamentId} ORDER BY id FOR UPDATE`;
      await assertActivePrincipal(tx, user, {
        tournamentId: access.tournamentId,
        tatamiId,
      });
      await tx.$queryRaw`SELECT id FROM "Contest" WHERE id=${id} FOR UPDATE`;
      const row = await tx.contest.findUnique({
        where: { id },
        include: { draw: { include: { category: true } } },
      });
      if (
        !row ||
        row.tatamiId !== tatamiId ||
        row.draw.category.tournamentId !== access.tournamentId
      )
        throw new NotFoundException('MATCH_NOT_FOUND');
      const previous = await tx.matchEvent.findUnique({ where: { id: dto.id } });
      if (previous) {
        const receipt = previous.payload as unknown as Partial<CommandReceipt>;
        if (
          previous.contestId !== id ||
          previous.actorId !== user.id ||
          !isDeepStrictEqual(receipt.command ?? previous.payload, json(dto))
        )
          throw new ConflictException('COMMAND_ID_REUSED');
        // Older events retain their flat command payload; new receipts preserve
        // the original response even after later commands change the contest.
        return receipt.response ?? commandResult(row);
      }
      if (hasIncompleteOfflineOwnership(row))
        throw new ConflictException('OFFLINE_METADATA_INCOMPLETE');
      await assertTatamiControl(tx, user, tatamiId, dto);
      if (row.revision !== dto.expectedVersion) throw new ConflictException('VERSION_CONFLICT');
      if (row.status === 'CONFIRMED') throw new ConflictException('RESULT_LOCKED');
      const offline = dto.type.startsWith('OFFLINE_');
      if (!offline && (dto.events !== undefined || dto.sessionId !== undefined))
        throw new BadRequestException('UNEXPECTED_OFFLINE_PAYLOAD');
      if (
        offline &&
        (dto.side !== undefined || dto.kind !== undefined || dto.awardId !== undefined)
      )
        throw new BadRequestException('UNEXPECTED_MATCH_PAYLOAD');
      if (dto.type === 'OFFLINE_OPEN' && dto.events?.length)
        throw new BadRequestException('OFFLINE_OPEN_EVENTS');
      if (
        row.offlineSessionId &&
        (!offline || dto.sessionId !== row.offlineSessionId || user.id !== row.offlineActorId)
      )
        throw new ConflictException('OFFLINE_OWNED');
      if (offline && !dto.sessionId) throw new BadRequestException('OFFLINE_SESSION_REQUIRED');
      if (offline && !row.state) throw new ConflictException('MATCH_NOT_READY');
      if (dto.type === 'OFFLINE_OPEN' && row.offlineSessionId)
        throw new ConflictException('OFFLINE_OWNED');
      if (['OFFLINE_SYNC', 'OFFLINE_RELEASE'].includes(dto.type) && !row.offlineSessionId)
        throw new ConflictException('OFFLINE_SESSION_REVOKED');
      if (
        ['OFFLINE_SYNC', 'OFFLINE_RELEASE'].includes(dto.type) &&
        row.offlineControlGeneration !== dto.controlGeneration
      )
        throw new ConflictException('OFFLINE_CONTROL_STALE');
      const events = offline ? (dto.events ?? []) : [];
      const ids = [dto.id, ...events.map((event) => event.id)];
      await assertUnusedCommandIds(tx, ids, row.state as unknown as MatchState | null);
      const athletes = await lockContestAthletes(tx, row);
      const at = now();
      let state: MatchState;
      if (!row.state) {
        const tournament = await tx.tournament.findUniqueOrThrow({
          where: { id: access.tournamentId },
        });
        if (tournament.status !== 'RUNNING') throw new ConflictException('TOURNAMENT_NOT_STARTED');
        if (
          dto.type !== 'START' ||
          row.status !== 'READY' ||
          !row.whiteEntryId ||
          !row.blueEntryId ||
          row.draw.status !== 'CONFIRMED'
        )
          throw new ConflictException('MATCH_NOT_READY');
        const earliestRound = await unfinishedRound(tx, tatamiId);
        if (earliestRound !== null && row.round > earliestRound)
          throw new ConflictException('PREVIOUS_ROUND_PENDING');
        const first = (await readyQueue(tx, tatamiId))[0];
        if (first?.id !== id) throw new ConflictException('QUEUE_ORDER');
        // Still counted from confirmedAt; the target tournament's saved profile
        // applies to all aliases of these athletes, including other tournaments.
        await requireAvailableAthletes(tx, row, athletes, {
          restMs: profile(tournament.rulesSnapshot).restMs,
        });
        state = createMatch(
          matchRules(
            tournament.rulesSnapshot,
            row.draw.categoryId,
            row.draw.category.durationSeconds,
          ),
        );
      } else {
        if (row.status !== 'ACTIVE') throw new ConflictException('MATCH_NOT_READY');
        // Pauses, provisional results, offline leases and recovery retain ACTIVE
        // reservation. Resuming that reservation does not impose rest again.
        await requireAvailableAthletes(tx, row, athletes);
        state = row.offlineSessionId
          ? (structuredClone(row.state) as unknown as MatchState)
          : this.advance(row, at);
        await this.recordHoldScore(tx, row, state);
      }
      try {
        if (dto.type === 'OFFLINE_OPEN') {
          if (!['PAUSED', 'DECISION', 'PROVISIONAL'].includes(state.status) || state.hold)
            throw new Error('PAUSE_REQUIRED');
        } else if (offline) {
          for (const event of events) {
            state = applyCommand(state, event as Command);
            state.receipts = {};
          }
          if (dto.type === 'OFFLINE_RELEASE' && (state.status === 'RUNNING' || state.hold))
            throw new Error('PAUSE_REQUIRED');
        } else state = applyCommand(state, { ...dto, expectedVersion: state.version } as Command);
      } catch (e) {
        throw new ConflictException((e as Error).message);
      }
      state.receipts = {};
      const confirmed = state.status === 'CONFIRMED';
      const winner = confirmed
        ? state.outcome!.winner === 'WHITE'
          ? row.whiteEntryId
          : row.blueEntryId
        : null;
      const updated = await tx.contest.update({
        where: { id },
        data: {
          state: json(state),
          ...(dto.type === 'OFFLINE_OPEN'
            ? {
                offlineSessionId: dto.sessionId,
                offlineActorId: user.id,
                offlineControlGeneration: dto.controlGeneration,
              }
            : {}),
          ...(dto.type === 'OFFLINE_RELEASE' || confirmed
            ? { offlineSessionId: null, offlineActorId: null, offlineControlGeneration: null }
            : {}),
          revision: { increment: 1 },
          status: confirmed ? 'CONFIRMED' : 'ACTIVE',
          clockAnchorMs: at,
          clockEpoch: this.epoch,
          winnerEntryId: winner,
          resultReason: confirmed ? state.outcome!.reason : null,
          confirmedAt: confirmed ? new Date() : null,
        },
      });
      await tx.tatami.update({
        where: { id: tatamiId },
        data: { status: confirmed ? 'IDLE' : 'BUSY' },
      });
      const response = commandResult(updated);
      try {
        if (events.length)
          await tx.matchEvent.createMany({
            data: events.map((event) => ({
              id: event.id,
              contestId: id,
              actorId: user.id,
              type: 'OFFLINE_EVENT',
              payload: json(event),
            })),
          });
        await tx.matchEvent.create({
          data: {
            id: dto.id,
            contestId: id,
            actorId: user.id,
            type: dto.type,
            payload: json({ command: dto, response }),
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
          tournamentId: access.tournamentId,
          entityId: id,
          action: 'MATCH_' + dto.type,
          payload: json({ commandId: dto.id, revision: updated.revision, state }),
        },
      });
      if (confirmed) {
        const homeTatamiId = row.draw.category.homeTatamiId ?? tatamiId;
        if (!row.draw.category.homeTatamiId)
          await tx.category.update({ where: { id: row.draw.categoryId }, data: { homeTatamiId } });
        let all = await tx.contest.findMany({ where: { drawId: row.drawId } });
        const winners = Object.fromEntries(
          all
            .filter((c) => c.status === 'CONFIRMED' && c.winnerEntryId)
            .map((c) => [c.key, c.winnerEntryId!]),
        );
        const beforeDraw = row.draw.snapshot as unknown as Draw;
        const draw = appendRematches(beforeDraw, winners);
        if (draw !== beforeDraw) {
          await tx.drawRecord.update({ where: { id: row.drawId }, data: { snapshot: json(draw) } });
          const added = draw.matches.filter(
            (m) => !beforeDraw.matches.some((old) => old.id === m.id),
          );
          await tx.contest.createMany({
            data: added.map((m) => ({
              drawId: row.drawId,
              key: m.id,
              round: m.round,
              status: 'WAITING',
            })),
          });
          await tx.auditEvent.create({
            data: {
              actorId: user.id,
              tournamentId: access.tournamentId,
              entityId: row.drawId,
              action: 'TIEBREAK_CREATED',
              payload: json({ matches: added }),
            },
          });
          all = await tx.contest.findMany({ where: { drawId: row.drawId } });
        }
        const resolved = resolveMatches(draw, winners);
        for (const m of resolved) {
          const target = all.find((c) => c.key === m.id)!;
          if (target.status === 'WAITING' && m.ready) {
            const last = await tx.contest.aggregate({
              where: { tatamiId: homeTatamiId },
              _max: { queueOrder: true },
            });
            await tx.contest.update({
              where: { id: target.id },
              data: {
                whiteEntryId: m.whiteEntryId,
                blueEntryId: m.blueEntryId,
                status: 'READY',
                tatamiId: homeTatamiId,
                queueOrder: (last._max.queueOrder ?? 0) + 1,
              },
            });
          }
        }
      }
      if (
        confirmed &&
        !(await tx.contest.count({
          where: {
            draw: { category: { tournamentId: access.tournamentId } },
            status: { not: 'CONFIRMED' },
          },
        }))
      ) {
        await tx.tournament.update({
          where: { id: access.tournamentId },
          data: { status: 'FINISHED' },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: access.tournamentId,
            entityId: access.tournamentId,
            action: 'TOURNAMENT_FINISHED',
            payload: {},
          },
        });
      }
      return response;
    });
    this.live.notify({
      kind: result.status === 'CONFIRMED' ? 'result' : 'state',
      tournamentId: access.tournamentId,
      tatamiId,
    });
    return result;
  }
}
