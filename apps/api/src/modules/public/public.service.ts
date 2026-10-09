import { MatchesService } from '../matches/matches.service.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { tatamiQueue } from '../tatamis/queue.js';
@Injectable()
export class PublicService {
  constructor(
    private readonly db: DatabaseService,
    private readonly matches: MatchesService,
  ) {}
  list() {
    return this.db.tournament.findMany({
      where: { publishedAt: { not: null } },
      orderBy: { startDate: 'desc' },
      select: {
        id: true,
        name: true,
        city: true,
        venue: true,
        startDate: true,
        endDate: true,
        tatamiCount: true,
        _count: { select: { categories: true } },
      },
    });
  }
  async get(id: string) {
    const t = await this.db.tournament.findFirst({
      where: { id, publishedAt: { not: null } },
      select: {
        id: true,
        name: true,
        city: true,
        venue: true,
        startDate: true,
        endDate: true,
        publishedAt: true,
        tatamis: { orderBy: { number: 'asc' }, select: { id: true, number: true, status: true } },
        categories: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            format: true,
            entries: {
              where: { archivedAt: null },
              orderBy: { lastName: 'asc' },
              select: { id: true, firstName: true, lastName: true, club: true },
            },
            draw: {
              select: {
                id: true,
                status: true,
                version: true,
                publishedAt: true,
                snapshot: true,
                contests: {
                  orderBy: [{ round: 'asc' }, { key: 'asc' }],
                  select: {
                    id: true,
                    key: true,
                    status: true,
                    tatamiId: true,
                    whiteEntryId: true,
                    blueEntryId: true,
                    winnerEntryId: true,
                    resultReason: true,
                    confirmedAt: true,
                    state: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!t) throw new NotFoundException('PUBLIC_TOURNAMENT_NOT_FOUND');
    return {
      ...t,
      categories: t.categories.map((c) => ({
        ...c,
        draw: c.draw?.status === 'CONFIRMED' && c.draw.publishedAt ? c.draw : null,
      })),
      tatamis: await Promise.all(
        t.tatamis.map(async (m) => ({
          ...m,
          currentMatch: (await this.matches.view(m.id)).currentMatch,
          queue: await tatamiQueue(this.db, m.id),
        })),
      ),
    };
  }
}
