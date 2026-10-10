import { drawFormat, type Draw } from '@judo/engine/draw';
import { currentProfile, profile } from '../rules/profile.js';
import { scheduleCategories } from './scheduling.js';
import { LiveService } from '../matches/live.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertActivePrincipal } from '../auth/access-guards.js';
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
import { CreateTournamentDto, CreateCategoryDto, CreateEntryDto } from './dto.js';
import { cleanName, normalizedName } from '../roster/roster-validation.js';
import { invalidatePreviewDraws } from '../roster/draw-invalidation.js';
@Injectable()
export class TournamentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveService,
    private readonly auth: AuthService,
  ) {}
  async start(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const result = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
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
        for (const mat of [...t.tatamis].sort((a, b) => a.id.localeCompare(b.id)))
          await tx.$queryRaw`SELECT id FROM "Tatami" WHERE id=${mat.id} FOR UPDATE`;
        await assertActivePrincipal(tx, user, { tournamentId: id });
        if (t.status === 'RUNNING' || t.status === 'FINISHED') return { status: t.status };
        const categories = requireCompetitionCategories(t.categories);
        await scheduleCategories(tx, id, user);
        await tx.tournament.update({
          where: { id },
          data: {
            status: 'RUNNING',
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
        return { status: 'RUNNING' };
      },
      { timeout: 30000 },
    );
    this.live.notify({ kind: 'queue', tournamentId: id });
    return result;
  }
  async schedule(id: string, user: Principal) {
    await this.auth.owner(user, id);
    const result = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
        return scheduleCategories(tx, id, user);
      },
      { timeout: 30000 },
    );
    this.live.notify({ kind: 'queue', tournamentId: id });
    return result;
  }
  async publish(id: string, user: Principal) {
    await this.auth.owner(user, id);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
      const t = await tx.tournament.findUniqueOrThrow({ where: { id } });
      if (t.publishedAt) return t;
      const result = await tx.tournament.update({
        where: { id },
        data: { publishedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: id,
          entityId: id,
          action: 'TOURNAMENT_PUBLISHED',
          payload: {},
        },
      });
      return result;
    });
  }
  list(user: Principal) {
    if (!['ORGANIZER', 'SUPER_ADMIN'].includes(user.role))
      throw new ForbiddenException('FORBIDDEN');
    return this.db.tournament.findMany({
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
  create(dto: CreateTournamentDto, user: Principal) {
    if (!['ORGANIZER', 'SUPER_ADMIN'].includes(user.role))
      throw new ForbiddenException('FORBIDDEN');
    for (const v of [dto.startDate, dto.endDate])
      if (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
        throw new BadRequestException('Некорректная дата');
    if (dto.endDate < dto.startDate) throw new BadRequestException('Дата окончания раньше начала');
    if (!dto.name.trim() || !dto.city.trim() || !dto.venue.trim())
      throw new BadRequestException('Заполните обязательные поля');
    return this.db.tournament.create({
      data: {
        ...dto,
        rulesSnapshot: JSON.parse(JSON.stringify(currentProfile())),
        ownerId: user.id,
        name: dto.name.trim(),
        city: dto.city.trim(),
        venue: dto.venue.trim(),
        tatamis: { create: Array.from({ length: dto.tatamiCount }, (_, i) => ({ number: i + 1 })) },
      },
    });
  }
  async category(id: string, dto: CreateCategoryDto, user: Principal) {
    const t = await this.get(id, user);
    if (t.status !== 'DRAFT') throw new ConflictException('Настройки турнира заблокированы');
    const upperBound = dto.maxWeightGrams !== null && dto.minWeightGrams == null;
    const lowerBound = dto.maxWeightGrams === null && dto.minWeightGrams != null;
    if (!upperBound && !lowerBound) throw new BadRequestException('INVALID_WEIGHT_BOUNDS');
    if (dto.birthYearFrom > dto.birthYearTo)
      throw new BadRequestException('Неверный диапазон годов');
    if (!dto.name.trim()) throw new BadRequestException('Укажите название');
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
        const current = await tx.tournament.findUniqueOrThrow({ where: { id } });
        if (current.status !== 'DRAFT')
          throw new ConflictException('Настройки турнира заблокированы');
        const policy = profile(current.rulesSnapshot).drawPolicy;
        const format = dto.format ?? (policy ? 'REPECHAGE' : 'SINGLE_ELIMINATION');
        if (policy && format === 'SINGLE_ELIMINATION')
          throw new BadRequestException('FORMAT_UNSUPPORTED');
        return tx.category.create({
          data: { ...dto, format, name: dto.name.trim(), tournamentId: id },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Категория с таким названием уже существует');
      throw e;
    }
  }
  async entry(id: string, categoryId: string, dto: CreateEntryDto, user: Principal) {
    await this.auth.owner(user, id);
    if (!dto.firstName.trim() || !dto.lastName.trim() || !dto.club.trim())
      throw new BadRequestException('Заполните данные спортсмена');
    const result = await this.db.$transaction(async (tx) => {
      // All roster mutations lock tournament before categories. Draw confirmation
      // also takes the category lock, so admission cannot partially change a draw.
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Category" WHERE id = ${categoryId} FOR UPDATE`;
      const c = await tx.category.findFirst({
        where: { id: categoryId, tournamentId: id },
        include: { tournament: true },
      });
      if (!c) throw new NotFoundException('Категория не найдена');
      if (c.tournament.status !== 'DRAFT') throw new ConflictException('Состав заблокирован');
      if (await tx.drawRecord.findFirst({ where: { categoryId, status: 'CONFIRMED' } }))
        throw new ConflictException('DRAW_LOCKED');
      if (dto.birthYear < c.birthYearFrom || dto.birthYear > c.birthYearTo)
        throw new BadRequestException('Год рождения не соответствует категории');
      if ((await tx.entry.count({ where: { categoryId, archivedAt: null } })) >= 128)
        throw new ConflictException('В категории уже 128 участников');
      const club = await tx.club.upsert({
        where: {
          tournamentId_normalizedName: {
            tournamentId: id,
            normalizedName: normalizedName(dto.club),
          },
        },
        update: {},
        create: {
          tournamentId: id,
          name: cleanName(dto.club),
          normalizedName: normalizedName(dto.club),
        },
      });
      const athlete = await tx.athlete.create({ data: { ownerId: c.tournament.ownerId } });
      const entry = await tx.entry.create({
        data: {
          ...dto,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          club: dto.club.trim(),
          categoryId,
          clubId: club.id,
          gender: c.gender,
          athleteId: athlete.id,
        },
      });
      const updated = await tx.tournament.update({
        where: { id },
        data: { rosterRevision: { increment: 1 } },
      });
      await invalidatePreviewDraws(tx, id, [categoryId], user.id, { type: 'ENTRY_ADDED' });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          tournamentId: id,
          entityId: entry.id,
          action: 'ENTRY_ADDED',
          payload: JSON.parse(JSON.stringify({ revision: updated.rosterRevision, entry })),
        },
      });
      return entry;
    });
    this.live.notify({ kind: 'result', tournamentId: id });
    return result;
  }
}
