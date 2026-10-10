import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Prisma, ProtocolArtifact } from '@prisma/client';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { assertActivePrincipal } from '../auth/access-guards.js';
import { assertUnusedCommandIds, lockCommandIds } from '../matches/command-ids.js';
import { enqueueLive } from '../matches/live-outbox.js';
import { protocolScope } from './protocol-scope.js';
import { requireTeamResults } from './protocol-readiness.js';
import { renderProtocol } from './render-protocol.js';
import {
  MAX_PROTOCOL_BYTES,
  protocolHash,
  protocolSourceHash,
  verifiedProtocolBytes,
} from './protocol-artifact.js';
import {
  PUBLISHED_PROTOCOL_KINDS,
  type PublishedProtocolKind,
  type ProtocolCreateDto,
  type ProtocolVisibilityDto,
} from './protocol-publication.dto.js';
import type { ProtocolTournament } from './protocol-model.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const headerSelect = {
  id: true,
  tournamentId: true,
  version: true,
  kind: true,
  lang: true,
  categoryIds: true,
  scope: true,
  source: true,
  sha256: true,
  byteSize: true,
  createdById: true,
  createdAt: true,
  publishedAt: true,
} satisfies Prisma.ProtocolArtifactSelect;
type Header = Omit<ProtocolArtifact, 'bytes'>;

async function snapshot(tx: Prisma.TransactionClient, id: string) {
  const t = await tx.tournament.findUnique({
    where: { id },
    include: {
      categories: {
        orderBy: [{ birthYearFrom: 'desc' }, { maxWeightGrams: 'asc' }, { name: 'asc' }],
        include: {
          entries: {
            where: { archivedAt: null },
            orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
          },
          draw: { include: { contests: { orderBy: [{ round: 'asc' }, { key: 'asc' }] } } },
        },
      },
    },
  });
  if (!t) throw new NotFoundException('TOURNAMENT_NOT_FOUND');
  return t;
}
function selectedSnapshot(t: ProtocolTournament, kind: PublishedProtocolKind, ids?: string[]) {
  const selected = ids
    ? t.categories.filter((category) => ids.includes(category.id))
    : t.categories;
  if (ids && selected.length !== new Set(ids).size)
    throw new NotFoundException('CATEGORY_NOT_FOUND');
  const categories = [...protocolScope(selected, kind)];
  if (kind === 'TEAMS') requireTeamResults(categories);
  return { ...t, categories };
}
function sourceCurrent(row: Header, t: ProtocolTournament): boolean {
  try {
    if (!PUBLISHED_PROTOCOL_KINDS.includes(row.kind as PublishedProtocolKind)) return false;
    const source = row.source as { hash?: string };
    const ids = row.scope === 'ALL' ? undefined : (row.categoryIds as string[]);
    return (
      source.hash ===
      protocolSourceHash(
        selectedSnapshot(t, row.kind as PublishedProtocolKind, ids),
        row.kind as PublishedProtocolKind,
      )
    );
  } catch {
    return false;
  }
}
function metadata(row: Header, t: ProtocolTournament, guest = false) {
  const { createdById, ...safe } = row;
  return { ...safe, ...(!guest ? { createdById } : {}), sourceCurrent: sourceCurrent(row, t) };
}
function scopeKey(row: Pick<Header, 'kind' | 'lang' | 'scope' | 'categoryIds'>) {
  return JSON.stringify([
    row.kind,
    row.lang,
    row.scope,
    row.scope === 'ALL' ? [] : [...(row.categoryIds as string[])].sort(),
  ]);
}
function validateCommand(dto: ProtocolCreateDto | ProtocolVisibilityDto) {
  const allowed =
    'type' in dto
      ? ['id', 'expectedRevision', 'reason', 'type', 'sha256']
      : ['id', 'expectedRevision', 'reason', 'kind', 'lang', 'categoryIds'];
  if (Object.keys(dto).some((key) => !allowed.includes(key)))
    throw new BadRequestException('UNEXPECTED_PROTOCOL_PAYLOAD');
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(dto.id) ||
    !Number.isSafeInteger(dto.expectedRevision) ||
    dto.expectedRevision < 0
  )
    throw new BadRequestException('INVALID_PROTOCOL_COMMAND');
  if (
    typeof dto.reason !== 'string' ||
    dto.reason.trim().length < 3 ||
    dto.reason.trim().length > 500
  )
    throw new BadRequestException('REASON_REQUIRED');
  if ('type' in dto) {
    if (!['PUBLISH', 'UNPUBLISH'].includes(dto.type) || !/^[a-f0-9]{64}$/.test(dto.sha256))
      throw new BadRequestException('INVALID_PROTOCOL_COMMAND');
  } else if (
    !PUBLISHED_PROTOCOL_KINDS.includes(dto.kind) ||
    !['ru', 'kk'].includes(dto.lang) ||
    (dto.categoryIds !== undefined &&
      (!Array.isArray(dto.categoryIds) ||
        !dto.categoryIds.length ||
        dto.categoryIds.length > 500 ||
        new Set(dto.categoryIds).size !== dto.categoryIds.length ||
        dto.categoryIds.some((id) => typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id))))
  )
    throw new BadRequestException('INVALID_PROTOCOL_COMMAND');
}

@Injectable()
export class ProtocolPublicationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}
  private async lock(tx: Prisma.TransactionClient, id: string, user: Principal) {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Tatami" WHERE "tournamentId"=${id} ORDER BY id FOR UPDATE`;
    await assertActivePrincipal(tx, user, { tournamentId: id });
  }
  private async receipt(
    tx: Prisma.TransactionClient,
    id: string,
    type: string,
    command: unknown,
    commandId: string,
    user: Principal,
  ) {
    await lockCommandIds(tx, [commandId]);
    const saved = await tx.protocolCommand.findUnique({ where: { id: commandId } });
    if (!saved) return null;
    if (
      saved.tournamentId !== id ||
      saved.actorId !== user.id ||
      saved.type !== type ||
      !isDeepStrictEqual(saved.command, json(command))
    )
      throw new ConflictException('COMMAND_ID_REUSED');
    return saved.response;
  }
  private async commit(
    tx: Prisma.TransactionClient,
    id: string,
    artifact: Header,
    type: string,
    command: ProtocolCreateDto | ProtocolVisibilityDto,
    user: Principal,
    t: ProtocolTournament,
  ) {
    const revision = command.expectedRevision + 1;
    await tx.tournament.update({ where: { id }, data: { protocolRevision: revision } });
    const response = json({ revision, artifact: metadata(artifact, t) });
    await tx.protocolCommand.create({
      data: {
        id: command.id,
        tournamentId: id,
        artifactId: artifact.id,
        actorId: user.id,
        type,
        command: json({ ...command, artifactId: type === 'CREATE' ? undefined : artifact.id }),
        response,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        tournamentId: id,
        action: `PROTOCOL_${type}`,
        entityId: artifact.id,
        payload: json({
          commandId: command.id,
          reason: command.reason.trim(),
          revision,
          version: artifact.version,
          sha256: artifact.sha256,
          source: artifact.source,
          publishedAt: artifact.publishedAt,
        }),
      },
    });
    await enqueueLive(tx, { tournamentId: id, kind: 'protocol' });
    return response;
  }
  async create(id: string, dto: ProtocolCreateDto, user: Principal) {
    await this.auth.owner(user, id);
    validateCommand(dto);
    const initial = await this.db.$transaction(async (tx) => {
      await this.lock(tx, id, user);
      const saved = await this.receipt(tx, id, 'CREATE', dto, dto.id, user);
      if (saved !== null) return { saved };
      await assertUnusedCommandIds(tx, [dto.id], null);
      const t = await snapshot(tx, id);
      if (t.protocolRevision !== dto.expectedRevision)
        throw new ConflictException('PROTOCOL_VERSION_CONFLICT');
      return {
        t: selectedSnapshot(t, dto.kind, dto.categoryIds),
        capturedAt: new Date().toISOString(),
      };
    });
    if ('saved' in initial) return initial.saved;
    const captured = initial.t;
    const hash = protocolSourceHash(captured, dto.kind);
    const bytes = await renderProtocol(
      captured,
      dto.kind,
      dto.lang,
      dto.categoryIds ? 'SELECTED' : 'ALL',
    );
    if (bytes.length > MAX_PROTOCOL_BYTES) throw new ConflictException('PROTOCOL_TOO_LARGE');
    const sha256 = protocolHash(bytes);
    verifiedProtocolBytes(bytes, bytes.length, sha256);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, id, user);
      const saved = await this.receipt(tx, id, 'CREATE', dto, dto.id, user);
      if (saved !== null) return saved;
      await assertUnusedCommandIds(tx, [dto.id], null);
      const t = await snapshot(tx, id);
      if (t.protocolRevision !== dto.expectedRevision)
        throw new ConflictException('PROTOCOL_VERSION_CONFLICT');
      if (protocolSourceHash(selectedSnapshot(t, dto.kind, dto.categoryIds), dto.kind) !== hash)
        throw new ConflictException('PROTOCOL_SOURCE_CHANGED');
      const latest = await tx.protocolArtifact.findFirst({
        where: { tournamentId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const artifact = await tx.protocolArtifact.create({
        data: {
          id: randomUUID(),
          tournamentId: id,
          version: (latest?.version ?? 0) + 1,
          kind: dto.kind,
          lang: dto.lang,
          categoryIds: captured.categories.map((category) => category.id),
          scope: dto.categoryIds ? 'SELECTED' : 'ALL',
          source: json({
            hash,
            capturedAt: initial.capturedAt,
            rosterRevision: captured.rosterRevision,
            tournamentName: captured.name,
            categories: captured.categories.map((category) => ({
              id: category.id,
              name: category.name,
              drawVersion: category.draw?.version ?? null,
            })),
          }),
          sha256,
          byteSize: bytes.length,
          bytes: Uint8Array.from(bytes),
          createdById: user.id,
        },
        select: headerSelect,
      });
      return this.commit(tx, id, artifact, 'CREATE', dto, user, t);
    });
  }
  async visibility(id: string, artifactId: string, dto: ProtocolVisibilityDto, user: Principal) {
    await this.auth.owner(user, id);
    validateCommand(dto);
    const command = { ...dto, artifactId };
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, id, user);
      const saved = await this.receipt(tx, id, dto.type, command, dto.id, user);
      if (saved !== null) return saved;
      await assertUnusedCommandIds(tx, [dto.id], null);
      const t = await snapshot(tx, id);
      if (t.protocolRevision !== dto.expectedRevision)
        throw new ConflictException('PROTOCOL_VERSION_CONFLICT');
      const artifact = await tx.protocolArtifact.findFirst({
        where: { id: artifactId, tournamentId: id },
        select: headerSelect,
      });
      if (!artifact) throw new NotFoundException('PROTOCOL_NOT_FOUND');
      if (artifact.sha256 !== dto.sha256) throw new ConflictException('PROTOCOL_REVIEW_CHANGED');
      if (dto.type === 'PUBLISH') {
        if (!t.publishedAt) throw new ConflictException('TOURNAMENT_NOT_PUBLISHED');
        if (!sourceCurrent(artifact, t)) throw new ConflictException('PROTOCOL_SOURCE_CHANGED');
        if (artifact.publishedAt) throw new ConflictException('PROTOCOL_ALREADY_PUBLISHED');
        const content = await tx.protocolArtifact.findUniqueOrThrow({
          where: { id: artifactId },
          select: { bytes: true },
        });
        verifiedProtocolBytes(content.bytes, artifact.byteSize, artifact.sha256);
      } else if (!artifact.publishedAt) throw new ConflictException('PROTOCOL_NOT_PUBLISHED');
      const changed = await tx.protocolArtifact.update({
        where: { id: artifactId },
        data: { publishedAt: dto.type === 'PUBLISH' ? new Date() : null },
        select: headerSelect,
      });
      return this.commit(tx, id, changed, dto.type, dto, user, t);
    });
  }
  async history(id: string, user: Principal | null, beforeVersion?: number) {
    if (user) await this.auth.owner(user, id);
    return this.db.$transaction(
      async (tx) => {
        const t = await snapshot(tx, id);
        if (!user && !t.publishedAt) throw new NotFoundException('PUBLIC_TOURNAMENT_NOT_FOUND');
        const rows = await tx.protocolArtifact.findMany({
          where: {
            tournamentId: id,
            ...(user ? {} : { publishedAt: { not: null } }),
            ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
          },
          orderBy: { version: 'desc' },
          take: 51,
          select: headerSelect,
        });
        const versions = await tx.protocolArtifact.findMany({
          where: { tournamentId: id, ...(user ? {} : { publishedAt: { not: null } }) },
          orderBy: { version: 'desc' },
          select: { version: true, kind: true, lang: true, scope: true, categoryIds: true },
        });
        const latest = new Map<string, number>();
        for (const row of versions)
          if (!latest.has(scopeKey(row))) latest.set(scopeKey(row), row.version);
        return {
          revision: t.protocolRevision,
          tournamentPublished: !!t.publishedAt,
          artifacts: rows.slice(0, 50).map((row) => ({
            ...metadata(row, t, !user),
            latest: latest.get(scopeKey(row)) === row.version,
          })),
          nextBeforeVersion: rows.length > 50 ? rows[49].version : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async download(id: string, artifactId: string, user: Principal | null) {
    if (user) await this.auth.owner(user, id);
    const artifact = await this.db.protocolArtifact.findFirst({
      where: {
        id: artifactId,
        tournamentId: id,
        ...(user ? {} : { publishedAt: { not: null }, tournament: { publishedAt: { not: null } } }),
      },
    });
    if (!artifact) throw new NotFoundException('PROTOCOL_NOT_FOUND');
    return {
      bytes: verifiedProtocolBytes(artifact.bytes, artifact.byteSize, artifact.sha256),
      filename: `${artifact.kind.toLowerCase()}-v${artifact.version}-${artifact.lang}.pdf`,
      sha256: artifact.sha256,
    };
  }
}
