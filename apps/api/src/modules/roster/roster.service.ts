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
import { lockAdminMutation } from '../auth/access-guards.js';
import { enqueueLive } from '../matches/live-outbox.js';
import { assertUnusedCommandIds, lockCommandIds } from '../matches/command-ids.js';
import { LiveService } from '../matches/live.service.js';
import type {
  CreateClubDto,
  RosterCommitDto,
  RosterPreviewDto,
  SingleEntryCommitDto,
} from './roster.dto.js';
import { cleanName, normalizedName, validateRoster } from './roster-validation.js';
import type {
  EntryArchiveDto,
  EntryNameDto,
  EntryPreviewDto,
  EntryRestoreDto,
  EntryUpdateDto,
  EntryIdentityPreviewDto,
  EntryIdentityBindDto,
  AthleteDirectoryQueryDto,
} from './roster.dto.js';
import { invalidatePreviewDraws } from './draw-invalidation.js';
import {
  athleteScope,
  lockAthleteIds,
  lockIdentityDraws,
  scopedAthleteIds,
  searchAthleteIds,
  type AthleteDirectoryItem,
} from './athlete-identity.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const snapshotInclude = {
  categories: {
    include: { entries: { where: { archivedAt: null } }, draw: { select: { status: true } } },
  },
} satisfies Prisma.TournamentInclude;
type DurableCommand = { id: string };

@Injectable()
export class RosterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly live: LiveService,
  ) {}

  private async identityCatalog(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    ownerId: string | null,
    athleteIds: string[],
  ): Promise<AthleteDirectoryItem[]> {
    if (athleteIds.length === 0) return [];
    const athletes = await tx.athlete.findMany({
      where: { ...athleteScope(tournamentId, ownerId), id: { in: athleteIds } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: {
        entries: {
          where:
            ownerId === null
              ? { category: { tournamentId } }
              : { category: { tournament: { ownerId } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 1,
          include: { category: { select: { tournamentId: true, gender: true } } },
        },
      },
    });
    const activeEntries = await tx.entry.findMany({
      where: { athleteId: { in: athleteIds }, archivedAt: null, category: { tournamentId } },
      select: { id: true, athleteId: true, categoryId: true },
    });
    return athletes.flatMap((athlete) => {
      const latest = athlete.entries[0];
      if (!latest) return [];
      const active = activeEntries.find((entry) => entry.athleteId === athlete.id);
      return [
        {
          id: athlete.id,
          display: {
            entryId: latest.id,
            tournamentId: latest.category.tournamentId,
            firstName: latest.firstName,
            lastName: latest.lastName,
            birthYear: latest.birthYear,
            gender: latest.gender ?? latest.category.gender,
            club: latest.club,
          },
          activeEntry: active ? { entryId: active.id, categoryId: active.categoryId } : null,
        },
      ];
    });
  }

  async athletes(id: string, dto: AthleteDirectoryQueryDto, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction(
      async (tx) => {
        const tournament = await tx.tournament.findUnique({ where: { id } });
        if (!tournament) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
        const words = normalizedName(dto.query ?? '')
          .split(' ')
          .filter(Boolean);
        const ids = await searchAthleteIds(tx, id, tournament.ownerId, words, dto.limit);
        const catalogue = await this.identityCatalog(tx, id, tournament.ownerId, ids);
        return {
          athletes: catalogue,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async clubs(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const tournament = await this.db.tournament.findUnique({
      where: { id },
      select: {
        rosterRevision: true,
        clubs: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            _count: { select: { entries: { where: { archivedAt: null } } } },
          },
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
    dto: DurableCommand,
    actorId?: string,
  ) {
    await lockCommandIds(tx, [dto.id]);
    const saved = await tx.rosterCommand.findUnique({ where: { id: dto.id } });
    if (!saved) return null;
    if (
      saved.tournamentId !== tournamentId ||
      (actorId !== undefined && saved.actorId !== actorId) ||
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
    dto: DurableCommand,
    response: Prisma.InputJsonValue,
    entityId: string,
    change?: Prisma.InputJsonObject,
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
        payload: { command: json(dto), response, ...change },
      },
    });
    await enqueueLive(tx, { tournamentId, kind: 'roster' });
  }

  async createClub(id: string, dto: CreateClubDto, user: Principal) {
    await this.auth.owner(user, id);
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    try {
      result = await this.db.$transaction(async (tx) => {
        await lockAdminMutation(tx, user, id);
        const saved = await this.receipt(tx, id, 'CLUB_CREATED', dto, user.id);
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
        const available = await scopedAthleteIds(
          tx,
          id,
          tournament.ownerId,
          dto.entries.flatMap((entry) => (entry.athleteId ? [entry.athleteId] : [])),
        );
        return validateRoster(tournament, club.name, dto.entries, undefined, available);
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
          await lockAdminMutation(tx, user, id);
          const saved = await this.receipt(tx, id, 'ROSTER_ADDED', dto, user.id);
          if (saved !== null) return saved;
          await this.current(tx, id, dto.expectedRevision);
          await assertUnusedCommandIds(tx, [dto.id], null);
          const categoryIds = [...new Set(dto.entries.map((entry) => entry.categoryId))].sort();
          for (const categoryId of categoryIds)
            await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${categoryId} AND "tournamentId"=${id} FOR UPDATE`;
          await lockIdentityDraws(tx, categoryIds);
          const selectedIds = dto.entries.flatMap((entry) =>
            entry.athleteId ? [entry.athleteId] : [],
          );
          await lockAthleteIds(tx, selectedIds);
          const tournament = await tx.tournament.findUniqueOrThrow({
            where: { id },
            include: snapshotInclude,
          });
          const club = await tx.club.findFirst({ where: { id: dto.clubId, tournamentId: id } });
          if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
          const available = await scopedAthleteIds(tx, id, tournament.ownerId, selectedIds);
          const validation = validateRoster(
            tournament,
            club.name,
            dto.entries,
            undefined,
            available,
          );
          if (!validation.canSave)
            throw new BadRequestException({ message: 'ROSTER_VALIDATION_FAILED', ...validation });
          const createdAt = new Date();
          const rows = dto.entries.map((entry) => ({
            id: randomUUID(),
            athleteId: entry.athleteId ?? randomUUID(),
            createdAt,
            categoryId: entry.categoryId,
            firstName: cleanName(entry.firstName),
            lastName: cleanName(entry.lastName),
            birthYear: entry.birthYear,
            gender: entry.gender,
            clubId: club.id,
            club: club.name,
          }));
          const newAthletes = rows
            .filter((_, index) => !dto.entries[index]!.athleteId)
            .map((entry) => ({ id: entry.athleteId, ownerId: tournament.ownerId, createdAt }));
          if (newAthletes.length) await tx.athlete.createMany({ data: newAthletes });
          await tx.entry.createMany({ data: rows });
          const savedEntries = await tx.entry.findMany({
            where: { id: { in: rows.map((row) => row.id) }, archivedAt: null },
          });
          const byId = new Map(savedEntries.map((entry) => [entry.id, entry]));
          const entries = rows.map((row) => byId.get(row.id)!);
          const updated = await tx.tournament.update({
            where: { id },
            data: { rosterRevision: { increment: 1 } },
          });
          const invalidatedCategoryIds = await invalidatePreviewDraws(
            tx,
            id,
            dto.entries.map((entry) => entry.categoryId),
            user.id,
            { type: 'ROSTER_ADDED', commandId: dto.id },
          );
          const response = json({
            revision: updated.rosterRevision,
            clubId: club.id,
            entries,
            invalidatedCategoryIds,
          });
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

  async admitSingle(id: string, categoryId: string, dto: SingleEntryCommitDto, user: Principal) {
    await this.auth.owner(user, id);
    const command = { ...dto, categoryId };
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    try {
      result = await this.db.$transaction(async (tx) => {
        await lockAdminMutation(tx, user, id);
        const saved = await this.receipt(tx, id, 'ENTRY_ADDED', command, user.id);
        if (saved !== null) return saved;
        await this.current(tx, id, dto.expectedRosterRevision);
        await assertUnusedCommandIds(tx, [dto.id], null);
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${categoryId} AND "tournamentId"=${id} FOR UPDATE`;
        await lockIdentityDraws(tx, [categoryId]);
        const selected = dto.athleteId ? [dto.athleteId] : [];
        await lockAthleteIds(tx, selected);
        const tournament = await tx.tournament.findUniqueOrThrow({
          where: { id },
          include: snapshotInclude,
        });
        const category = tournament.categories.find((category) => category.id === categoryId);
        if (!category) throw new NotFoundException('CATEGORY_NOT_FOUND');
        const clubName = cleanName(dto.club);
        if (clubName.length < 2) throw new BadRequestException('CLUB_NAME_REQUIRED');
        const available = await scopedAthleteIds(tx, id, tournament.ownerId, selected);
        const admission = {
          firstName: dto.firstName,
          lastName: dto.lastName,
          birthYear: dto.birthYear,
          gender: category.gender as 'MALE' | 'FEMALE',
          categoryId,
          athleteId: dto.athleteId,
          duplicateConfirmed: dto.duplicateConfirmed,
        };
        const validation = validateRoster(tournament, clubName, [admission], undefined, available);
        if (!validation.canSave)
          throw new BadRequestException({ message: 'ROSTER_VALIDATION_FAILED', ...validation });
        const club = await tx.club.upsert({
          where: {
            tournamentId_normalizedName: {
              tournamentId: id,
              normalizedName: normalizedName(clubName),
            },
          },
          update: {},
          create: { tournamentId: id, name: clubName, normalizedName: normalizedName(clubName) },
        });
        const athleteId = dto.athleteId ?? randomUUID();
        if (!dto.athleteId)
          await tx.athlete.create({ data: { id: athleteId, ownerId: tournament.ownerId } });
        const entry = await tx.entry.create({
          data: {
            categoryId,
            athleteId,
            firstName: cleanName(dto.firstName),
            lastName: cleanName(dto.lastName),
            birthYear: dto.birthYear,
            gender: category.gender,
            clubId: club.id,
            club: club.name,
          },
        });
        const updated = await tx.tournament.update({
          where: { id },
          data: { rosterRevision: { increment: 1 } },
        });
        await invalidatePreviewDraws(tx, id, [categoryId], user.id, {
          type: 'ENTRY_ADDED',
          commandId: dto.id,
        });
        const response = json({ ...entry, rosterRevision: updated.rosterRevision });
        await this.record(tx, id, user, 'ENTRY_ADDED', command, response, entry.id);
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

  async archived(id: string, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction(
      async (tx) => {
        const tournament = await tx.tournament.findUnique({ where: { id } });
        if (!tournament) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
        const entries = await tx.entry.findMany({
          where: { archivedAt: { not: null }, category: { tournamentId: id } },
          include: { category: { select: { gender: true } } },
          orderBy: [{ archivedAt: 'desc' }, { id: 'asc' }],
        });
        return {
          revision: tournament.rosterRevision,
          entries: entries.map(({ category, ...entry }) => ({
            ...entry,
            gender: entry.gender ?? category.gender,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async savedEntry(tx: Prisma.TransactionClient, id: string, entryId: string) {
    const entry = await tx.entry.findFirst({
      where: { id: entryId, category: { tournamentId: id } },
    });
    if (!entry) throw new NotFoundException('ENTRY_NOT_FOUND');
    return entry;
  }

  /** Correct this tournament's display fields without touching any sporting state. */
  async correctName(id: string, entryId: string, dto: EntryNameDto, user: Principal) {
    await this.auth.owner(user, id);
    const command = { ...dto, entryId };
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    let changed = false;
    try {
      result = await this.db.$transaction(async (tx) => {
        await lockAdminMutation(tx, user, id);
        const saved = await this.receipt(tx, id, 'ENTRY_NAME_CORRECTED', command, user.id);
        if (saved !== null) return saved;
        if (
          Object.keys(dto).some(
            (field) =>
              !['id', 'expectedRevision', 'firstName', 'lastName', 'reason'].includes(field),
          )
        )
          throw new BadRequestException('UNEXPECTED_NAME_PAYLOAD');
        const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
        if ([...reason].length < 3 || [...reason].length > 500)
          throw new BadRequestException('REASON_REQUIRED');
        if (typeof dto.firstName !== 'string' || typeof dto.lastName !== 'string')
          throw new BadRequestException('NAME_REQUIRED');
        const firstName = cleanName(dto.firstName),
          lastName = cleanName(dto.lastName);
        if (!firstName || !lastName) throw new BadRequestException('NAME_REQUIRED');
        if ([...firstName].length > 80 || [...lastName].length > 80)
          throw new BadRequestException('NAME_TOO_LONG');
        const tournament = await tx.tournament.findUniqueOrThrow({ where: { id } });
        if (tournament.rosterRevision !== dto.expectedRevision)
          throw new ConflictException('VERSION_CONFLICT');
        if (!['DRAFT', 'RUNNING', 'FINISHED'].includes(tournament.status))
          throw new ConflictException('NAME_CORRECTION_NOT_ALLOWED');
        await assertUnusedCommandIds(tx, [dto.id], null);
        const lookup = await this.savedEntry(tx, id, entryId);
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${lookup.categoryId} AND "tournamentId"=${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Entry" WHERE id=${entryId} FOR UPDATE`;
        const before = await this.savedEntry(tx, id, entryId);
        if (before.archivedAt) throw new ConflictException('ENTRY_ARCHIVED');
        if (tournament.status === 'DRAFT') {
          const draw = await tx.drawRecord.findUnique({ where: { categoryId: before.categoryId } });
          // Unconfirmed previews fingerprint names; use the existing correction
          // flow there rather than silently rewriting that historical fingerprint.
          if (draw?.status !== 'CONFIRMED')
            throw new ConflictException('NAME_CORRECTION_NOT_ALLOWED');
        }
        if (before.firstName === firstName && before.lastName === lastName)
          throw new ConflictException('NAME_UNCHANGED');
        const entry = await tx.entry.update({
          where: { id: entryId },
          data: { firstName, lastName },
        });
        const updated = await tx.tournament.update({
          where: { id },
          data: { rosterRevision: { increment: 1 } },
        });
        const response = json({
          revision: updated.rosterRevision,
          entry,
          invalidatedCategoryIds: [],
        });
        await this.record(tx, id, user, 'ENTRY_NAME_CORRECTED', command, response, entryId, {
          reason,
          before: json(before),
          after: json(entry),
        });
        changed = true;
        return response;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('COMMAND_ID_REUSED');
      throw error;
    }
    if (changed) this.live.notify({ kind: 'roster', tournamentId: id });
    return result;
  }

  private async hasContest(tx: Prisma.TransactionClient, entryId: string) {
    return !!(await tx.contest.findFirst({
      where: {
        OR: [{ whiteEntryId: entryId }, { blueEntryId: entryId }, { winnerEntryId: entryId }],
      },
      select: { id: true },
    }));
  }

  private async entryValidation(
    tx: Prisma.TransactionClient,
    id: string,
    entryId: string,
    dto: EntryPreviewDto,
  ) {
    if ('athleteId' in dto) throw new BadRequestException('IDENTITY_CHANGE_REQUIRES_BIND');
    const entry = await this.savedEntry(tx, id, entryId);
    const tournament = await tx.tournament.findUniqueOrThrow({
      where: { id },
      include: snapshotInclude,
    });
    const source = tournament.categories.find((category) => category.id === entry.categoryId)!;
    const club = await tx.club.findFirst({ where: { id: dto.clubId, tournamentId: id } });
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    const before = { ...entry };
    const fields = (value: EntryPreviewDto) => ({
      firstName: cleanName(value.firstName),
      lastName: cleanName(value.lastName),
      birthYear: value.birthYear,
      gender: value.gender,
      categoryId: value.categoryId,
      clubId: value.clubId,
    });
    const proposed = entry.archivedAt
      ? { ...before, gender: entry.gender ?? source.gender, archivedAt: null }
      : {
          ...before,
          ...fields(dto),
          club: dto.clubId === entry.clubId ? entry.club : club.name,
          archivedAt: null,
        };
    const validation = validateRoster(
      tournament,
      club.name,
      [{ ...dto, athleteId: entry.athleteId }],
      entryId,
    );
    const errors = validation.rows[0]!.errors;
    if (source.draw?.status === 'CONFIRMED' && !errors.includes('DRAW_LOCKED'))
      errors.push('DRAW_LOCKED');
    if (await this.hasContest(tx, entryId)) errors.push('ENTRY_IN_DRAW');
    if (
      entry.archivedAt &&
      !isDeepStrictEqual(
        fields(dto),
        fields({
          ...before,
          gender: before.gender ?? source.gender,
          clubId: before.clubId!,
        } as EntryPreviewDto),
      )
    )
      errors.push('RESTORE_ORIGINAL_ONLY');
    const affectedCategoryIds = [...new Set([entry.categoryId, dto.categoryId])].sort();
    const invalidatedCategoryIds = tournament.categories
      .filter(
        (category) =>
          affectedCategoryIds.includes(category.id) && category.draw?.status === 'PREVIEW',
      )
      .map((category) => category.id)
      .sort();
    return {
      ...validation,
      canSave: errors.length === 0,
      before,
      proposed,
      affectedCategoryIds,
      invalidatedCategoryIds,
    };
  }

  async previewEntry(id: string, entryId: string, dto: EntryPreviewDto, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction((tx) => this.entryValidation(tx, id, entryId, dto), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async identityValidation(
    tx: Prisma.TransactionClient,
    id: string,
    entryId: string,
    dto: EntryIdentityPreviewDto,
  ) {
    const before = await this.savedEntry(tx, id, entryId);
    const tournament = await tx.tournament.findUniqueOrThrow({ where: { id } });
    const source = await tx.category.findFirst({
      where: { id: before.categoryId, tournamentId: id },
      include: { draw: true },
    });
    const selected = (await this.identityCatalog(tx, id, tournament.ownerId, [dto.athleteId]))[0];
    if (!selected) throw new NotFoundException('ATHLETE_NOT_FOUND');
    const { activeEntry: _, ...athlete } = selected;
    const errors: string[] = [];
    if (tournament.status !== 'DRAFT') errors.push('ROSTER_LOCKED');
    if (before.archivedAt) errors.push('ENTRY_ARCHIVED');
    if (before.athleteId === dto.athleteId) errors.push('IDENTITY_UNCHANGED');
    if (source?.draw?.status === 'CONFIRMED') errors.push('DRAW_LOCKED');
    if (await this.hasContest(tx, entryId)) errors.push('ENTRY_IN_DRAW');
    if (
      await tx.entry.findFirst({
        where: {
          athleteId: dto.athleteId,
          id: { not: entryId },
          archivedAt: null,
          category: { tournamentId: id },
        },
        select: { id: true },
      })
    )
      errors.push('ATHLETE_ALREADY_REGISTERED');
    return {
      revision: tournament.rosterRevision,
      before,
      proposed: { ...before, athleteId: dto.athleteId },
      athlete,
      errors,
      canSave: errors.length === 0,
      affectedCategoryIds: [before.categoryId],
      invalidatedCategoryIds: source?.draw?.status === 'PREVIEW' ? [before.categoryId] : [],
    };
  }

  async previewIdentity(
    id: string,
    entryId: string,
    dto: EntryIdentityPreviewDto,
    user: Principal,
  ) {
    await this.auth.owner(user, id);
    return this.db.$transaction((tx) => this.identityValidation(tx, id, entryId, dto), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async bindIdentity(id: string, entryId: string, dto: EntryIdentityBindDto, user: Principal) {
    await this.auth.owner(user, id);
    const command = { ...dto, entryId };
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    try {
      result = await this.db.$transaction(async (tx) => {
        await lockAdminMutation(tx, user, id);
        const saved = await this.receipt(tx, id, 'ENTRY_IDENTITY_BOUND', command, user.id);
        if (saved !== null) return saved;
        const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
        if ([...reason].length < 3 || [...reason].length > 500)
          throw new BadRequestException('REASON_REQUIRED');
        await this.current(tx, id, dto.expectedRevision);
        await assertUnusedCommandIds(tx, [dto.id], null);
        const before = await this.savedEntry(tx, id, entryId);
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${before.categoryId} AND "tournamentId"=${id} FOR UPDATE`;
        await lockIdentityDraws(tx, [before.categoryId]);
        await lockAthleteIds(tx, [before.athleteId, dto.athleteId]);
        const validation = await this.identityValidation(tx, id, entryId, dto);
        if (!validation.canSave) throw new ConflictException(validation.errors[0]);
        const entry = await tx.entry.update({
          where: { id: entryId },
          data: { athlete: { connect: { id: dto.athleteId } } },
        });
        const source = await tx.category.findFirst({
          where: { id: entry.categoryId, tournamentId: id },
        });
        const updated = await tx.tournament.update({
          where: { id },
          data: { rosterRevision: { increment: 1 } },
        });
        const invalidatedCategoryIds = await invalidatePreviewDraws(
          tx,
          id,
          [entry.categoryId],
          user.id,
          {
            type: 'ENTRY_IDENTITY_BOUND',
            commandId: dto.id,
          },
        );
        const response = json({
          revision: updated.rosterRevision,
          entry: { ...entry, gender: entry.gender ?? source!.gender },
          invalidatedCategoryIds,
        });
        await this.record(tx, id, user, 'ENTRY_IDENTITY_BOUND', command, response, entryId, {
          reason,
          before: json(before),
          after: json(entry),
        });
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

  private async changeEntry(
    id: string,
    entryId: string,
    type: 'ENTRY_UPDATED' | 'ENTRY_ARCHIVED' | 'ENTRY_RESTORED',
    dto: EntryUpdateDto | EntryArchiveDto | EntryRestoreDto,
    user: Principal,
  ) {
    await this.auth.owner(user, id);
    let result: Prisma.JsonValue | Prisma.InputJsonValue;
    const command = { ...dto, entryId };
    try {
      result = await this.db.$transaction(
        async (tx) => {
          await lockAdminMutation(tx, user, id);
          const saved = await this.receipt(tx, id, type, command, user.id);
          if (saved !== null) return saved;
          const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
          if ([...reason].length < 3 || [...reason].length > 500)
            throw new BadRequestException('REASON_REQUIRED');
          await this.current(tx, id, dto.expectedRevision);
          await assertUnusedCommandIds(tx, [dto.id], null);
          const before = await this.savedEntry(tx, id, entryId);
          if (type === 'ENTRY_RESTORED' ? !before.archivedAt : !!before.archivedAt)
            throw new ConflictException(
              type === 'ENTRY_RESTORED' ? 'ENTRY_NOT_ARCHIVED' : 'ENTRY_ARCHIVED',
            );
          const targetId =
            type === 'ENTRY_UPDATED' ? (dto as EntryUpdateDto).categoryId : before.categoryId;
          const categoryIds = [...new Set([before.categoryId, targetId])].sort();
          for (const categoryId of categoryIds)
            await tx.$queryRaw`SELECT id FROM "Category" WHERE id=${categoryId} AND "tournamentId"=${id} FOR UPDATE`;
          await lockIdentityDraws(tx, categoryIds);
          await lockAthleteIds(tx, [before.athleteId]);
          if (await this.hasContest(tx, entryId)) throw new ConflictException('ENTRY_IN_DRAW');
          let data: Prisma.EntryUpdateInput;
          if (type === 'ENTRY_ARCHIVED') {
            const source = await tx.category.findFirst({
              where: { id: before.categoryId, tournamentId: id },
              include: { draw: true },
            });
            if (source?.draw?.status === 'CONFIRMED') throw new ConflictException('DRAW_LOCKED');
            data = { archivedAt: new Date() };
          } else {
            let proposedDto: EntryPreviewDto;
            if (type === 'ENTRY_UPDATED') proposedDto = dto as EntryUpdateDto;
            else {
              if (!before.clubId) throw new ConflictException('ENTRY_CLUB_UNRESOLVED');
              const source = await tx.category.findFirst({
                where: { id: before.categoryId, tournamentId: id },
              });
              proposedDto = {
                firstName: before.firstName,
                lastName: before.lastName,
                birthYear: before.birthYear,
                categoryId: before.categoryId,
                clubId: before.clubId!,
                gender: (before.gender ?? source!.gender) as 'MALE' | 'FEMALE',
                duplicateConfirmed: (dto as EntryRestoreDto).duplicateConfirmed,
              };
            }
            const validation = await this.entryValidation(tx, id, entryId, proposedDto);
            if (!validation.canSave)
              throw new BadRequestException({
                message: 'ROSTER_VALIDATION_FAILED',
                ...(json(validation) as Prisma.InputJsonObject),
              });
            data =
              type === 'ENTRY_RESTORED'
                ? { archivedAt: null }
                : {
                    firstName: validation.proposed.firstName,
                    lastName: validation.proposed.lastName,
                    birthYear: validation.proposed.birthYear,
                    gender: validation.proposed.gender,
                    club: validation.proposed.club,
                    category: { connect: { id: targetId } },
                    clubRecord: { connect: { id: proposedDto.clubId } },
                  };
          }
          const entry = await tx.entry.update({ where: { id: entryId }, data });
          const category = await tx.category.findFirst({
            where: { id: entry.categoryId, tournamentId: id },
          });
          const updated = await tx.tournament.update({
            where: { id },
            data: { rosterRevision: { increment: 1 } },
          });
          const invalidatedCategoryIds = await invalidatePreviewDraws(
            tx,
            id,
            categoryIds,
            user.id,
            { type, commandId: dto.id },
          );
          const response = json({
            revision: updated.rosterRevision,
            entry: { ...entry, gender: entry.gender ?? category!.gender },
            invalidatedCategoryIds,
          });
          await this.record(tx, id, user, type, command, response, entryId, {
            reason,
            before: json(before),
            after: json(entry),
          });
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

  updateEntry(id: string, entryId: string, dto: EntryUpdateDto, user: Principal) {
    return this.changeEntry(id, entryId, 'ENTRY_UPDATED', dto, user);
  }
  archiveEntry(id: string, entryId: string, dto: EntryArchiveDto, user: Principal) {
    return this.changeEntry(id, entryId, 'ENTRY_ARCHIVED', dto, user);
  }
  restoreEntry(id: string, entryId: string, dto: EntryRestoreDto, user: Principal) {
    return this.changeEntry(id, entryId, 'ENTRY_RESTORED', dto, user);
  }
}
