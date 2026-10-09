import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertUnusedCommandIds, lockCommandIds } from '../matches/command-ids.js';
import { LiveService } from '../matches/live.service.js';
import type { CreateClubDto, RosterCommitDto, RosterPreviewDto } from './roster.dto.js';
import { cleanName, normalizedName, validateRoster } from './roster-validation.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const snapshotInclude = {
  categories: { include: { entries: true, draw: { select: { status: true } } } },
} satisfies Prisma.TournamentInclude;

@Injectable()
export class RosterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly live: LiveService,
  ) {}

  async clubs(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const tournament = await this.db.tournament.findUnique({
      where: { id },
      select: {
        rosterRevision: true,
        clubs: {
          orderBy: { name: 'asc' },
          select: { id: true, name: true, _count: { select: { entries: true } } },
        },
      },
    });
    if (!tournament) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
    return { revision: tournament.rosterRevision, clubs: tournament.clubs };
  }

  private async receipt(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    type: string,
    dto: CreateClubDto | RosterCommitDto,
  ) {
    await lockCommandIds(tx, [dto.id]);
    const saved = await tx.rosterCommand.findUnique({ where: { id: dto.id } });
    if (!saved) return null;
    if (
      saved.tournamentId !== tournamentId ||
      saved.type !== type ||
      !isDeepStrictEqual(saved.command, json(dto))
    )
      throw new ConflictException('COMMAND_ID_REUSED');
    return saved.response;
  }

  private async current(tx: Prisma.TransactionClient, id: string, expectedRevision: number) {
    const tournament = await tx.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
    if (tournament.rosterRevision !== expectedRevision)
      throw new ConflictException('VERSION_CONFLICT');
    if (tournament.status !== 'DRAFT') throw new ConflictException('ROSTER_LOCKED');
    return tournament;
  }

  private async record(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    user: Principal,
    type: string,
    dto: CreateClubDto | RosterCommitDto,
    response: Prisma.InputJsonValue,
    entityId: string,
  ) {
    await tx.rosterCommand.create({
      data: { id: dto.id, tournamentId, actorId: user.id, type, command: json(dto), response },
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        tournamentId,
        entityId,
        action: type,
        payload: { command: json(dto), response },
      },
    });
  }

  async createClub(id: string, dto: CreateClubDto, user: Principal) {
    await this.auth.owner(user, id);
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    try {
      result = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
        const saved = await this.receipt(tx, id, 'CLUB_CREATED', dto);
        if (saved !== null) return saved;
        await this.current(tx, id, dto.expectedRevision);
        await assertUnusedCommandIds(tx, [dto.id], null);
        const name = cleanName(dto.name);
        if (name.length < 2) throw new BadRequestException('CLUB_NAME_REQUIRED');
        const normalized = normalizedName(name);
        if (
          await tx.club.findUnique({
            where: {
              tournamentId_normalizedName: { tournamentId: id, normalizedName: normalized },
            },
          })
        )
          throw new ConflictException('CLUB_ALREADY_EXISTS');
        const club = await tx.club.create({
          data: { tournamentId: id, name, normalizedName: normalized },
        });
        const tournament = await tx.tournament.update({
          where: { id },
          data: { rosterRevision: { increment: 1 } },
        });
        const response = json({
          revision: tournament.rosterRevision,
          club: { id: club.id, name: club.name, _count: { entries: 0 } },
        });
        await this.record(tx, id, user, 'CLUB_CREATED', dto, response, club.id);
        return response;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('COMMAND_ID_REUSED');
      throw error;
    }
    this.live.notify({ kind: 'result', tournamentId: id });
    return result;
  }

  async preview(id: string, dto: RosterPreviewDto, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction(
      async (tx) => {
        const tournament = await tx.tournament.findUnique({
          where: { id },
          include: snapshotInclude,
        });
        if (!tournament) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
        const club = await tx.club.findFirst({ where: { id: dto.clubId, tournamentId: id } });
        if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
        return validateRoster(tournament, club.name, dto.entries);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async commit(id: string, dto: RosterCommitDto, user: Principal) {
    await this.auth.owner(user, id);
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    try {
      result = await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
          const saved = await this.receipt(tx, id, 'ROSTER_ADDED', dto);
          if (saved !== null) return saved;
          await this.current(tx, id, dto.expectedRevision);
          await assertUnusedCommandIds(tx, [dto.id], null);
          for (const categoryId of [
            ...new Set(dto.entries.map((entry) => entry.categoryId)),
          ].sort())
            await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${categoryId} AND "tournamentId"=${id} FOR UPDATE`;
          const tournament = await tx.tournament.findUniqueOrThrow({
            where: { id },
            include: snapshotInclude,
          });
          const club = await tx.club.findFirst({ where: { id: dto.clubId, tournamentId: id } });
          if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
          const validation = validateRoster(tournament, club.name, dto.entries);
          if (!validation.canSave)
            throw new BadRequestException({ message: 'ROSTER_VALIDATION_FAILED', ...validation });
          const createdAt = new Date();
          const rows = dto.entries.map((entry) => ({
            id: randomUUID(),
            createdAt,
            categoryId: entry.categoryId,
            firstName: cleanName(entry.firstName),
            lastName: cleanName(entry.lastName),
            birthYear: entry.birthYear,
            gender: entry.gender,
            clubId: club.id,
            club: club.name,
          }));
          await tx.entry.createMany({ data: rows });
          const savedEntries = await tx.entry.findMany({
            where: { id: { in: rows.map((row) => row.id) } },
          });
          const byId = new Map(savedEntries.map((entry) => [entry.id, entry]));
          const entries = rows.map((row) => byId.get(row.id)!);
          const updated = await tx.tournament.update({
            where: { id },
            data: { rosterRevision: { increment: 1 } },
          });
          const response = json({ revision: updated.rosterRevision, clubId: club.id, entries });
          await this.record(tx, id, user, 'ROSTER_ADDED', dto, response, club.id);
          return response;
        },
        { timeout: 30000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('COMMAND_ID_REUSED');
      throw error;
    }
    this.live.notify({ kind: 'result', tournamentId: id });
    return result;
  }
}
