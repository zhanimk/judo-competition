import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { DatabaseService } from '../../database/database.service.js';
import { AuthService } from '../auth/auth.service.js';
import { RuntimeConfig } from '../../infrastructure/runtime-config.js';
import { RedisService } from '../../infrastructure/redis.service.js';
import type { DurableLiveNotice } from './live-outbox.js';

export type LiveNotice = {
  tournamentId: string;
  tatamiId?: string;
  kind: DurableLiveNotice['kind'] | 'connected' | 'resync';
  /** Decimal string: JSON cannot safely encode PostgreSQL bigint as a number. */
  cursor?: string;
};
type Client = {
  tournamentId: string;
  req: IncomingMessage;
  syncing: boolean;
  queued: LiveNotice[];
  backpressure: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = new Set(['state', 'result', 'queue', 'roster', 'protocol', 'access']);
const room = (id: string) => `tournament:${id}`;
export function liveCursor(value: unknown): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new Error('INVALID_LIVE_CURSOR');
  const cursor = BigInt(value);
  if (cursor > 9223372036854775807n) throw new Error('INVALID_LIVE_CURSOR');
  return cursor;
}

/** Notifications only invalidate views; HTTP/Prisma remain authoritative. */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly sockets = new Map<Socket, Client>();
  private readonly logger = new Logger(LiveService.name);
  private server?: Server;
  private pollTimer?: ReturnType<typeof setInterval>;
  private authTimer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private sweeping = false;
  private stopping = false;
  private lastErrorAt = 0;
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly config: RuntimeConfig,
    private readonly redis: RedisService,
  ) {}
  get ready() {
    return !!this.server && !this.stopping;
  }
  private async allowed(id: string, req: IncomingMessage) {
    const t = await this.db.tournament.findUnique({ where: { id } });
    if (!t) return false;
    if (t.publishedAt) return true;
    const user = await this.auth.authenticate(req.headers.cookie);
    if (!user) return false;
    if (user.role === 'SUPER_ADMIN' || (user.role === 'ORGANIZER' && t.ownerId === user.id))
      return true;
    if (user.role === 'OPERATOR' && user.tatamiId)
      return !!(await this.db.tatami.findFirst({ where: { id: user.tatamiId, tournamentId: id } }));
    return false;
  }
  attach(http: HttpServer) {
    if (this.server) throw new Error('LIVE_ALREADY_ATTACHED');
    const io = new Server(http, {
      path: '/api/v1/live',
      addTrailingSlash: false,
      transports: ['polling', 'websocket'],
      maxHttpBufferSize: 2048,
      pingInterval: 15000,
      pingTimeout: 10000,
      cors: { origin: this.config.origins, credentials: true },
      allowRequest: (req, accept) => accept(null, this.config.allowedOrigin(req.headers.origin)),
    });
    if (this.redis.pub && this.redis.sub)
      io.adapter(createAdapter(this.redis.pub, this.redis.sub, { key: 'judo:live' }));
    this.server = io;
    io.use(async (socket, next) => {
      const { tournamentId, cursor } = socket.handshake.auth;
      try {
        if (typeof tournamentId !== 'string' || !uuid.test(tournamentId))
          throw new Error('INVALID_TOURNAMENT_ID');
        liveCursor(cursor);
        if (!(await this.allowed(tournamentId, socket.request)))
          throw new Error('LIVE_ACCESS_DENIED');
        next();
      } catch (error) {
        const code =
          error instanceof Error &&
          ['INVALID_TOURNAMENT_ID', 'INVALID_LIVE_CURSOR', 'LIVE_ACCESS_DENIED'].includes(
            error.message,
          )
            ? error.message
            : 'LIVE_UNAVAILABLE';
        next(new Error(code));
      }
    });
    io.on('connection', (socket) => {
      const client: Client = {
        tournamentId: socket.handshake.auth.tournamentId,
        req: socket.request,
        syncing: true,
        queued: [],
        backpressure: 0,
      };
      this.sockets.set(socket, client);
      socket.on('disconnect', () => this.sockets.delete(socket));
      // This stream is read-only. A new connection carries the latest cursor.
      socket.onAny(() => socket.disconnect(true));
      void this.replay(socket, client, liveCursor(socket.handshake.auth.cursor)).catch(() => {
        socket.emit('notice', { kind: 'resync', tournamentId: client.tournamentId });
        socket.disconnect(true);
      });
    });
    this.pollTimer = setInterval(() => this.poll(), 250);
    this.authTimer = setInterval(() => void this.revalidate(), 15000);
    this.pollTimer.unref();
    this.authTimer.unref();
    this.poll();
  }
  private async replay(socket: Socket, client: Client, cursor: bigint | undefined) {
    if (!(await this.allowed(client.tournamentId, client.req))) {
      socket.disconnect(true);
      return;
    }
    const head =
      (
        await this.db.liveOutbox.findFirst({
          where: { tournamentId: client.tournamentId },
          orderBy: { id: 'desc' },
          select: { id: true },
        })
      )?.id ?? 0n;
    // A future cursor can follow a restored backup. Explicit resync moves the
    // client to the current boundary rather than silently skipping new events.
    let replay: { id: bigint; kind: string; tatamiId: string | null }[] = [];
    if (cursor !== undefined && cursor <= head)
      replay = await this.db.liveOutbox.findMany({
        where: { tournamentId: client.tournamentId, id: { gt: cursor, lte: head } },
        orderBy: { id: 'asc' },
        take: 101,
        select: { id: true, kind: true, tatamiId: true },
      });
    if (!socket.connected || !(await this.allowed(client.tournamentId, client.req))) {
      socket.disconnect(true);
      return;
    }
    if (cursor !== undefined && (cursor > head || replay.length > 100))
      socket.emit('notice', {
        kind: 'resync',
        tournamentId: client.tournamentId,
        cursor: head.toString(),
      });
    else {
      for (const event of replay) {
        if (!kinds.has(event.kind)) continue;
        socket.emit('notice', {
          kind: event.kind,
          tournamentId: client.tournamentId,
          ...(event.tatamiId ? { tatamiId: event.tatamiId } : {}),
          cursor: event.id.toString(),
        });
      }
      socket.emit('notice', {
        kind: 'connected',
        tournamentId: client.tournamentId,
        cursor: head.toString(),
      });
    }
    // Registration precedes the boundary query. Notices committed during replay
    // are buffered locally; joining and flushing have no intervening await.
    void socket.join(room(client.tournamentId));
    client.syncing = false;
    for (const notice of client.queued) socket.emit('notice', notice);
    client.queued = [];
  }
  private async revalidate() {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      for (const [socket, client] of this.sockets) {
        try {
          if (!(await this.allowed(client.tournamentId, client.req))) socket.disconnect(true);
        } catch {
          socket.disconnect(true);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
  private async broadcast(event: LiveNotice) {
    if (!this.server || this.stopping) throw new Error('LIVE_NOT_READY');
    for (const [socket, client] of this.sockets) {
      if (client.tournamentId !== event.tournamentId) continue;
      if (client.syncing) {
        if (client.queued.length >= 100) socket.disconnect(true);
        else client.queued.push(event);
      } else {
        // Engine.IO owns its private buffer. Bound consecutive notifications
        // while its public transport reports that it cannot accept a write.
        client.backpressure = socket.conn.transport.writable ? 0 : client.backpressure + 1;
        if (client.backpressure > 100) socket.disconnect(true);
      }
    }
    await this.redis.broadcast(() =>
      this.server!.to(room(event.tournamentId)).emit('notice', event),
    );
  }
  /** Optional immediate invalidation; critical durability comes from enqueueLive(tx). */
  notify(event: LiveNotice) {
    void this.broadcast(event).catch(() => this.warn('LIVE_EPHEMERAL_UNAVAILABLE'));
  }
  private warn(code: string) {
    if (Date.now() - this.lastErrorAt < 30000) return;
    this.lastErrorAt = Date.now();
    this.logger.warn(code);
  }
  private poll() {
    if (this.polling || this.stopping) return;
    this.polling = this.dispatch()
      .catch(() => this.warn('LIVE_OUTBOX_UNAVAILABLE'))
      .finally(() => {
        this.polling = undefined;
      });
  }
  private async dispatch() {
    if (!this.server || this.stopping || !this.redis.ready) return;
    // A single API clock owner is supported. Event order within each tournament
    // follows the Tournament lock used by every enqueueLive caller.
    const events = await this.db.liveOutbox.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: 100,
    });
    const blocked = new Set<string>();
    for (const event of events) {
      if (this.stopping || !this.redis.ready) return;
      if (blocked.has(event.tournamentId)) continue;
      if (event.nextAttemptAt.getTime() > Date.now()) {
        blocked.add(event.tournamentId);
        continue;
      }
      try {
        if (!kinds.has(event.kind)) throw new Error('INVALID_OUTBOX_KIND');
        await this.broadcast({
          tournamentId: event.tournamentId,
          kind: event.kind as DurableLiveNotice['kind'],
          ...(event.tatamiId ? { tatamiId: event.tatamiId } : {}),
          cursor: event.id.toString(),
        });
        await this.db.liveOutbox.update({
          where: { id: event.id },
          data: { publishedAt: new Date(), lastError: null },
        });
      } catch {
        // Publish-before-mark intentionally permits a duplicate after a crash.
        await this.db.liveOutbox.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lastError: 'DELIVERY_UNAVAILABLE',
            nextAttemptAt: new Date(
              Date.now() + Math.min(30000, 250 * 2 ** Math.min(event.attempts, 7)),
            ),
          },
        });
        this.warn('LIVE_OUTBOX_RETRY');
        // Do not send a later cursor of this tournament past the failed event.
        blocked.add(event.tournamentId);
      }
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.authTimer) clearInterval(this.authTimer);
    await this.polling;
    for (const socket of this.sockets.keys()) socket.disconnect(true);
    this.sockets.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
