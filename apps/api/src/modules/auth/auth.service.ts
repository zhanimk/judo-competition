import { tatamiQueue } from '../tatamis/queue.js';
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService } from '../../database/database.service.js';
import type { Principal } from './auth.types.js';
import { AccessService } from './access.service.js';
import { workRole } from './access-guards.js';
import type { InviteDto } from './auth.dto.js';
import type { ControlAccessDto, RevokeInvitationDto } from './access.dto.js';
const scrypt = promisify(scryptCallback);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
@Injectable()
export class AuthService {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}
  limit(key: string) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    const v = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
    v.count++;
    this.attempts.set(key, v);
    if (v.count > 20) throw new HttpException('TRY_LATER', 429);
  }
  async register(email: string, name: string, password: string) {
    if (!name.trim()) throw new BadRequestException('INVALID_NAME');
    const salt = randomBytes(16).toString('hex');
    const key = (await scrypt(password, salt, 64)) as Buffer;
    try {
      return await this.db.user.create({
        data: {
          email: email.trim().toLowerCase(),
          name: name.trim(),
          passwordHash: `${salt}:${key.toString('hex')}`,
          role: 'ORGANIZER',
        },
        select: { id: true, name: true, role: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('EMAIL_IN_USE');
      throw e;
    }
  }
  async login(email: string, password: string) {
    const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const [salt, stored] = (
      user?.passwordHash ?? '00000000000000000000000000000000:' + '00'.repeat(64)
    ).split(':');
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    if (!user || !timingSafeEqual(derived, Buffer.from(stored, 'hex')))
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    return user;
  }
  async session(userId: string) {
    const token = randomBytes(32).toString('hex');
    await this.db.session.create({
      data: { userId, tokenHash: hash(token), expiresAt: new Date(Date.now() + 8 * 3600000) },
    });
    return token;
  }
  async authenticate(cookie?: string): Promise<Principal | null> {
    const token = cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('judo_session='))
      ?.slice(13);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: hash(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date()) return null;
    if (session.invitationId) {
      const invite = await this.db.invitation.findUnique({ where: { id: session.invitationId } });
      if (
        !invite ||
        invite.revokedAt ||
        invite.expiresAt <= new Date() ||
        invite.tatamiId !== session.tatamiId
      )
        return null;
    }
    return {
      id: session.user.id,
      name: session.user.name,
      role: session.user.role,
      tatamiId: session.tatamiId,
      sessionId: session.id,
    };
  }
  async logout(user: Principal) {
    await this.access.logout(user);
  }
  admin(user: Principal) {
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('FORBIDDEN');
  }
  users(user: Principal) {
    this.admin(user);
    return this.db.user.findMany({
      select: { id: true, email: true, name: true, role: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  async owner(user: Principal, tournamentId: string) {
    if (user.role === 'SUPER_ADMIN') return;
    if (
      user.role !== 'ORGANIZER' ||
      !(await this.db.tournament.findFirst({ where: { id: tournamentId, ownerId: user.id } }))
    )
      throw new ForbiddenException('FORBIDDEN');
  }
  async invitations(user: Principal, tatamiId: string) {
    const t = await this.db.tatami.findUnique({ where: { id: tatamiId } });
    if (!t) throw new ForbiddenException('FORBIDDEN');
    await this.owner(user, t.tournamentId);
    return this.db.invitation.findMany({
      where: { tatamiId },
      select: { id: true, label: true, expiresAt: true, usedAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  async invite(user: Principal, tatamiId: string, dto: InviteDto) {
    return this.access.invite(user, tatamiId, dto);
  }
  async revoke(user: Principal, id: string, dto: RevokeInvitationDto) {
    return this.access.revoke(user, id, dto);
  }
  async accept(token: string, name: string) {
    return this.access.accept(token, name);
  }
  async control(user: Principal, tatamiId: string, deviceId?: string) {
    const tatami = await this.db.tatami.findUnique({
      where: { id: tatamiId },
      include: { tournament: { select: { ownerId: true, name: true } } },
    });
    if (!tatami) throw new ForbiddenException('FORBIDDEN');
    if (user.role === 'ORGANIZER' || user.role === 'SUPER_ADMIN') {
      await this.owner(user, tatami.tournamentId);
    } else if (user.role !== 'OPERATOR' || user.tatamiId !== tatamiId)
      throw new ForbiddenException('FORBIDDEN');
    const control = await this.access.status(this.db, tatami, user, deviceId);
    return {
      tatamiId,
      tournamentId: tatami.tournamentId,
      number: tatami.number,
      tournamentName: tatami.tournament.name,
      operatorName: user.name,
      role: user.role,
      workRole: workRole(user.role),
      accessRevision: tatami.accessRevision,
      control,
      matchCommandsAvailable: control.owned,
      queue: await tatamiQueue(this.db, tatamiId),
    };
  }
  async controlCommand(user: Principal, tatamiId: string, dto: ControlAccessDto) {
    return this.access.command(user, tatamiId, dto);
  }
  async viewTatami(user: Principal | null, tatamiId: string, tournamentId?: string) {
    const tatami = await this.db.tatami.findFirst({
      where: { id: tatamiId, ...(tournamentId ? { tournamentId } : {}) },
      include: { tournament: { select: { ownerId: true, publishedAt: true } } },
    });
    if (!tatami) throw new NotFoundException('TATAMI_NOT_FOUND');
    if (tatami.tournament.publishedAt) return;
    if (!user) throw new NotFoundException('PUBLIC_TATAMI_NOT_FOUND');
    if (user.role === 'SUPER_ADMIN') return;
    if (user.role === 'ORGANIZER' && tatami.tournament.ownerId === user.id) return;
    if (user.role === 'OPERATOR' && user.tatamiId === tatamiId) return;
    throw new ForbiddenException('FORBIDDEN');
  }
}
