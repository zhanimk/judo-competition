import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import type { ProtocolKind } from './protocol-model.js';
import { renderProtocol } from './render-protocol.js';
@Injectable()
export class ProtocolsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  async create(
    id: string,
    categoryId: string | undefined,
    lang: 'ru' | 'kk',
    user: Principal,
    kind: ProtocolKind = 'DRAW',
    categoryIds?: string[],
  ) {
    await this.auth.owner(user, id);
    if (kind !== 'DRAW' && kind !== 'PARTICIPANTS')
      throw new ConflictException('PROTOCOL_NOT_AVAILABLE');
    if (categoryId && categoryIds) throw new BadRequestException('AMBIGUOUS_CATEGORY_SCOPE');
    const ids = categoryIds ?? (categoryId ? [categoryId] : undefined);
    // One consistent database snapshot; PDF rendering happens after the transaction releases.
    const t = await this.db.$transaction(
      (tx) =>
        tx.tournament.findUniqueOrThrow({
          where: { id },
          include: {
            categories: {
              where: ids ? { id: { in: ids } } : {},
              orderBy: [{ birthYearFrom: 'desc' }, { maxWeightGrams: 'asc' }, { name: 'asc' }],
              include: {
                entries: { orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] },
                draw: { include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } } },
              },
            },
          },
        }),
      { isolationLevel: 'RepeatableRead' },
    );
    if (ids && t.categories.length !== new Set(ids).size)
      throw new NotFoundException('CATEGORY_NOT_FOUND');
    return renderProtocol(t, kind, lang);
  }
}
