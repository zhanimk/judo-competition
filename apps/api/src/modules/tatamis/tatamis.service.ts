import { MatchesService } from '../matches/matches.service.js';
import { tatamiQueue } from './queue.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
@Injectable()
export class TatamisService {
  constructor(
    private readonly matches: MatchesService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  async list(tournamentId: string, user: Principal) {
    await this.auth.owner(user, tournamentId);
    if (
      !(await this.db.tournament.findUnique({ where: { id: tournamentId }, select: { id: true } }))
    )
      throw new NotFoundException('TOURNAMENT_NOT_FOUND');
    return this.db.tatami.findMany({ where: { tournamentId }, orderBy: { number: 'asc' } });
  }
  async get(tournamentId: string, id: string, cookie?: string) {
    await this.auth.viewTatami(await this.auth.authenticate(cookie), id, tournamentId);
    const tatami = await this.db.tatami.findFirst({
      where: { id, tournamentId },
      select: {
        id: true,
        number: true,
        status: true,
        tournamentId: true,
        tournament: { select: { id: true, name: true, city: true } },
      },
    });
    if (!tatami) throw new NotFoundException('TATAMI_NOT_FOUND');
    return {
      ...tatami,
      currentMatch: (await this.matches.view(id)).currentMatch,
      queue: await tatamiQueue(this.db, id),
      controlAvailable: false,
    };
  }
}
