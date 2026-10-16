import { informationContent, informationState } from './tournament-information.js';
import { enqueueLive } from '../matches/live-outbox.js';
import { drawFormat, type Draw } from '@judo/engine/draw';
import { currentProfile, profile } from '../rules/profile.js';
import { scheduleCategories } from './scheduling.js';
import { LiveService } from '../matches/live.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertSessionIdentity, lockAdminMutation } from '../auth/access-guards.js';
import { requireCompetitionCategories } from './active-categories.js';
import { ForbiddenException } from '@nestjs/common';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../database/database.service.js';
import {
  TournamentInformationDto,
  AdministrationCommandDto,
  CreateTournamentDto,
  CreateCategoryDto,
  CreateEntryDto,
} from './dto.js';
import { RosterService } from '../roster/roster.service.js';
import { tournamentComplete } from '../draws/draw-propagation.js';
import { assertUnusedCommandIds } from '../matches/command-ids.js';
import { isDeepStrictEqual } from 'node:util';
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
@Injectable()
export class TournamentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveService,
    private readonly auth: AuthService,
    private readonly roster: RosterService,
  ) {}
  private async receipt(
    tx: Prisma.TransactionClient,
    tournamentId: string | null,
    dto: { id: string },
    type: string,
    user: Principal,
  ) {
    const receipt = await tx.tournamentCommand.findUnique({ where: { id: dto.id } });
    if (!receipt) return null;
    if (
      receipt.actorId !== user.id ||
      receipt.type !== type ||
      (tournamentId !== null && receipt.tournamentId !== tournamentId) ||
      !isDeepStrictEqual(receipt.command, json(dto))
    )
      throw new ConflictException('COMMAND_ID_REUSED');
    return receipt;
  }
  private async requireRevision(
    tx: Prisma.TransactionClient,
    id: string,
    dto: AdministrationCommandDto,
  ) {
    const tournament = await tx.tournament.findUniqueOrThrow({ where: { id } });
    if (tournament.administrationRevision !== dto.expectedRevision)
      throw new ConflictException('ADMINISTRATION_STALE');
    await assertUnusedCommandIds(tx, [dto.id], null);
    return tournament;
  }
  private async record(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    dto: { id: string },
    type: string,
    user: Principal,
    response: unknown,
    kind: 'roster' | 'queue' | 'protocol',
  ) {
    await tx.tournamentCommand.create({
      data: {
        id: dto.id,
        tournamentId,
        actorId: user.id,
        type,
        command: json(dto),
        response: json(response),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        tournamentId,
        entityId: tournamentId,
        action: 'ADMINISTRATION_' + type,
        payload: json({ command: dto, response }),
      },
    });
    await enqueueLive(tx, { tournamentId, kind });
    return json(response);
  }
  async information(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const t = await this.db.tournament.findUniqueOrThrow({
      where: { id },
      select: { publicInformation: true, administrationRevision: true },
    });
    return {
      ...informationState(t.publicInformation),
      administrationRevision: t.administrationRevision,
    };
  }
  async saveInformation(id: string, dto: TournamentInformationDto, user: Principal) {
    await this.auth.owner(user, id);
    const content = informationContent(dto);
    return this.db.$transaction(async (tx) => {
      await lockAdminMutation(tx, user, id);
      const receipt = await this.receipt(tx, id, dto, 'INFORMATION', user);
      if (receipt) return receipt.response;
      const t = await this.requireRevision(tx, id, dto);
      const previous = informationState(t.publicInformation);
      if (dto.action === 'PUBLISH' && !t.publishedAt)
        throw new ConflictException('Сначала опубликуйте турнир');
      const state = {
        draft: content,
        published:
          dto.action === 'PUBLISH' ? content : dto.action === 'HIDE' ? null : previous.published,
      };
      const updated = await tx.tournament.update({
        where: { id },
        data: {
          publicInformation: json(state),
          administrationRevision: { increment: 1 },
        },
      });
      return this.record(
        tx,
        id,
        dto,
        'INFORMATION',
        user,
        {
          administrationRevision: updated.administrationRevision,
          action: dto.action,
        },
        'protocol',
      );
    });
  }
  async start(id: string, dto: AdministrationCommandDto, user: Principal) {
    await this.auth.owner(user, id);
    const result = await this.db.$transaction(
      async (tx) => {
        await lockAdminMutation(tx, user, id);
        const receipt = await this.receipt(tx, id, dto, 'START', user);
        if (receipt) return receipt.response;
        await this.requireRevision(tx, id, dto);
        const t = await tx.tournament.findUniqueOrThrow({
          where: { id },
          include: {
            categories: {
              orderBy: { name: 'asc' },
              include: {
                _count: { select: { entries: { where: { archivedAt: null } } } },
                draw: { include: { contests: true } },
              },
            },
            tatamis: { orderBy: { number: 'asc' } },
          },
        });
        if (t.status === 'RUNNING' || t.status === 'FINISHED') {
          const updated = await tx.tournament.update({
            where: { id },
            data: { administrationRevision: { increment: 1 } },
          });
          return this.record(
            tx,
            id,
            dto,
            'START',
            user,
            { status: updated.status, administrationRevision: updated.administrationRevision },
            'queue',
          );
        }
        const categories = requireCompetitionCategories(t.categories);
        await scheduleCategories(tx, id, user);
        let updated = await tx.tournament.update({
          where: { id },
          data: {
            status: 'RUNNING',
            administrationRevision: { increment: 1 },
            rulesSnapshot: JSON.parse(
              JSON.stringify({
                ...profile(t.rulesSnapshot),
                approvedAt: new Date().toISOString(),
                categories: Object.fromEntries(
                  categories.map((c) => [
                    c.id,
                    {
                      durationSeconds: c.durationSeconds,
                      format: c.format,
                      resolvedFormat: drawFormat(c.draw!.snapshot as unknown as Draw),
                    },
                  ]),
                ),
              }),
            ),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: id,
            entityId: id,
            action: 'TOURNAMENT_STARTED',
            payload: {},
          },
        });
        if (
          categories.some((c) => (c.draw!.snapshot as unknown as Draw).withdrawnEntryIds?.length) &&
          (await tournamentComplete(tx, id))
        ) {
          updated = await tx.tournament.update({ where: { id }, data: { status: 'FINISHED' } });
          await tx.auditEvent.create({
            data: {
              actorId: user.id,
              tournamentId: id,
              entityId: id,
              action: 'TOURNAMENT_FINISHED',
              payload: json({ source: 'PRE_START_WITHDRAWALS', commandId: dto.id }),
            },
          });
        }
        return this.record(
          tx,
          id,
          dto,
          'START',
          user,
          { status: updated.status, administrationRevision: updated.administrationRevision },
          'queue',
        );
      },
      { timeout: 30000 },
    );
    this.live.notify({ kind: 'queue', tournamentId: id });
    return result;
  }
  async schedule(id: string, dto: AdministrationCommandDto, user: Principal) {
    await this.auth.owner(user, id);
    const result = await this.db.$transaction(
      async (tx) => {
        await lockAdminMutation(tx, user, id);
        const receipt = await this.receipt(tx, id, dto, 'SCHEDULE', user);
        if (receipt) return receipt.response;
        await this.requireRevision(tx, id, dto);
        const response = await scheduleCategories(tx, id, user);
        const updated = await tx.tournament.update({
          where: { id },
          data: { administrationRevision: { increment: 1 } },
        });
        return this.record(
          tx,
          id,
          dto,
          'SCHEDULE',
          user,
          { ...response, administrationRevision: updated.administrationRevision },
          'queue',
        );
      },
      { timeout: 30000 },
    );
    this.live.notify({ kind: 'queue', tournamentId: id });
    return result;
  }
  async publish(id: string, dto: AdministrationCommandDto, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction(async (tx) => {
      await lockAdminMutation(tx, user, id);
      const receipt = await this.receipt(tx, id, dto, 'PUBLISH', user);
      if (receipt) return receipt.response;
      const t = await this.requireRevision(tx, id, dto);
      const result = await tx.tournament.update({
        where: { id },
        data: {
          publishedAt: t.publishedAt ?? new Date(),
          administrationRevision: { increment: 1 },
        },
      });
      if (!t.publishedAt)
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: id,
            entityId: id,
            action: 'TOURNAMENT_PUBLISHED',
            payload: {},
          },
        });
      return this.record(tx, id, dto, 'PUBLISH', user, result, 'protocol');
    });
  }
  list(user: Principal) {
    if (!['ORGANIZER', 'SUPER_ADMIN'].includes(user.role))
      throw new ForbiddenException('FORBIDDEN');
    return this.db.tournament.findMany({
      omit: { publicInformation: true },
      where: user.role === 'SUPER_ADMIN' ? {} : { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        categories: {
          include: { _count: { select: { entries: { where: { archivedAt: null } } } } },
        },
      },
    });
  }
  async get(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const t = await this.db.tournament.findUnique({
      omit: { publicInformation: true },
      where: { id },
      include: {
        tatamis: { orderBy: { number: 'asc' } },
        clubs: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            _count: { select: { entries: { where: { archivedAt: null } } } },
          },
        },
        categories: {
          orderBy: { name: 'asc' },
          include: {
            entries: { where: { archivedAt: null }, orderBy: { lastName: 'asc' } },
            draw: {
              select: { status: true, publishedAt: true, _count: { select: { contests: true } } },
            },
          },
        },
      },
    });
    if (!t) throw new NotFoundException('Турнир не найден');
    return {
      ...t,
      categories: t.categories.map((category) => ({
        ...category,
        entries: category.entries.map((entry) => ({
          ...entry,
          gender: entry.gender ?? category.gender,
        })),
      })),
    };
  }
  async create(dto: CreateTournamentDto, user: Principal) {
    if (!['ORGANIZER', 'SUPER_ADMIN'].includes(user.role))
      throw new ForbiddenException('FORBIDDEN');
    for (const v of [dto.startDate, dto.endDate])
      if (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
        throw new BadRequestException('Некорректная дата');
    if (dto.endDate < dto.startDate) throw new BadRequestException('Дата окончания раньше начала');
    if (!dto.name.trim() || !dto.city.trim() || !dto.venue.trim())
      throw new BadRequestException('Заполните обязательные поля');
    return this.db
      .$transaction(async (tx) => {
        await assertSessionIdentity(tx, user);
        const receipt = await this.receipt(tx, null, dto, 'CREATE', user);
        if (receipt) return receipt.response;
        await assertUnusedCommandIds(tx, [dto.id], null);
        const { id: commandId, ...fields } = dto;
        // The newly inserted row is exclusively owned by this transaction. No
        // other mutation/outbox writer can lock this Tournament before commit.
        const result = await tx.tournament.create({
          data: {
            ...fields,
            rulesSnapshot: json(currentProfile()),
            ownerId: user.id,
            name: dto.name.trim(),
            city: dto.city.trim(),
            venue: dto.venue.trim(),
            tatamis: {
              create: Array.from({ length: dto.tatamiCount }, (_, i) => ({ number: i + 1 })),
            },
          },
        });
        return this.record(tx, result.id, dto, 'CREATE', user, result, 'roster');
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ConflictException('COMMAND_ID_REUSED');
        throw error;
      });
  }
  async category(id: string, dto: CreateCategoryDto, user: Principal) {
    await this.auth.owner(user, id);
    const upperBound = dto.maxWeightGrams !== null && dto.minWeightGrams == null;
    const lowerBound = dto.maxWeightGrams === null && dto.minWeightGrams != null;
    if (!upperBound && !lowerBound) throw new BadRequestException('INVALID_WEIGHT_BOUNDS');
    if (dto.birthYearFrom > dto.birthYearTo)
      throw new BadRequestException('Неверный диапазон годов');
    if (!dto.name.trim()) throw new BadRequestException('Укажите название');
    try {
      return await this.db.$transaction(async (tx) => {
        await lockAdminMutation(tx, user, id);
        const receipt = await this.receipt(tx, id, dto, 'CATEGORY', user);
        if (receipt) return receipt.response;
        const current = await this.requireRevision(tx, id, dto);
        if (current.status !== 'DRAFT')
          throw new ConflictException('Настройки турнира заблокированы');
        const policy = profile(current.rulesSnapshot).drawPolicy;
        const format = dto.format ?? (policy ? 'REPECHAGE' : 'SINGLE_ELIMINATION');
        if (policy && format === 'SINGLE_ELIMINATION')
          throw new BadRequestException('FORMAT_UNSUPPORTED');
        const { id: commandId, expectedRevision, ...fields } = dto;
        const category = await tx.category.create({
          data: { ...fields, format, name: dto.name.trim(), tournamentId: id },
        });
        const updated = await tx.tournament.update({
          where: { id },
          data: { administrationRevision: { increment: 1 } },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            tournamentId: id,
            entityId: category.id,
            action: 'CATEGORY_CREATED',
            payload: JSON.parse(JSON.stringify(dto)),
          },
        });
        return this.record(
          tx,
          id,
          dto,
          'CATEGORY',
          user,
          { ...category, administrationRevision: updated.administrationRevision },
          'roster',
        );
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Категория с таким названием уже существует');
      throw e;
    }
  }
  async entry(id: string, categoryId: string, dto: CreateEntryDto, user: Principal) {
    return this.roster.admitSingle(id, categoryId, dto, user);
  }
}
