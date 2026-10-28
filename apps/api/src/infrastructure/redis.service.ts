import { Injectable, Logger, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RuntimeConfig } from './runtime-config.js';

/** Only fixed categories enter logs; Redis errors can contain connection secrets. */
export function redisFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (
    typeof code === 'string' &&
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(
      code,
    )
  )
    return code;
  if (typeof message === 'string') {
    if (/^NOAUTH\b/.test(message)) return 'AUTH_REQUIRED';
    if (/^WRONGPASS\b/.test(message)) return 'AUTH_REJECTED';
    if (/timeout/i.test(message)) return 'TIMEOUT';
  }
  return 'UNKNOWN';
}

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  readonly pub?: Redis;
  readonly sub?: Redis;
  private readonly logger = new Logger(RedisService.name);
  private lastErrorAt = 0;
  private readonly publications = new Set<Promise<number>>();
  constructor(private readonly config: RuntimeConfig) {
    if (!config.redisUrl) return;
    this.pub = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 3000),
    });
    this.sub = this.pub.duplicate();
    // The adapter does not await publish(). Keep failures handled, and let the
    // outbox dispatcher wait for Redis to acknowledge its actual publication.
    const publish = this.pub.publish.bind(this.pub);
    this.pub.publish = ((channel: string, message: string | Buffer) => {
      const pending = publish(channel, message);
      this.publications.add(pending);
      void pending.then(
        () => this.publications.delete(pending),
        () => this.publications.delete(pending),
      );
      return pending;
    }) as Redis['publish'];
    for (const client of [this.pub, this.sub])
      client.on('error', (error: unknown) => {
        if (Date.now() - this.lastErrorAt > 30000) {
          this.lastErrorAt = Date.now();
          this.logger.warn(`REDIS_UNAVAILABLE:${redisFailureCode(error)}`);
        }
      });
  }
  get configured() {
    return !!this.pub;
  }
  get ready() {
    return !this.pub || (this.pub.status === 'ready' && this.sub?.status === 'ready');
  }
  async ping() {
    if (this.pub) await this.pub.ping();
  }
  async onModuleInit() {
    if (!this.pub || !this.sub) return;
    try {
      await Promise.all([this.pub.connect(), this.sub.connect()]);
      await this.pub.ping();
    } catch {
      this.pub.disconnect();
      this.sub.disconnect();
      throw new Error('REDIS_STARTUP_FAILED');
    }
  }
  async broadcast(send: () => void) {
    if (!this.ready) throw new Error('REDIS_UNAVAILABLE');
    send();
    await Promise.all([...this.publications]);
  }
  onApplicationShutdown() {
    // LiveService drains the dispatcher and closes Socket.IO first.
    this.pub?.disconnect();
    this.sub?.disconnect();
  }
}
