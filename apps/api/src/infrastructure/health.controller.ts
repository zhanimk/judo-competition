import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { Public } from '../modules/auth/auth.guard.js';
import { LiveService } from '../modules/matches/live.service.js';
import { RedisService } from './redis.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly live: LiveService,
  ) {}
  @Get('live') @Header('Cache-Control', 'no-store') liveness() {
    return { status: 'ok' };
  }
  @Get('ready') @Header('Cache-Control', 'no-store') async readiness() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.redis.ready || !this.live.ready) throw new Error('NOT_READY');
      await Promise.race([
        Promise.all([this.db.$queryRaw`SELECT 1`, this.redis.ping()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('TIMEOUT')), 2000);
          timeout.unref();
        }),
      ]);
      return { status: 'ok', database: 'ok', realtime: this.redis.configured ? 'redis' : 'local' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }
}
