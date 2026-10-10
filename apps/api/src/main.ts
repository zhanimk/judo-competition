import { LiveService } from './modules/matches/live.service.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { RuntimeConfig } from './infrastructure/runtime-config.js';
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(RuntimeConfig);
  app.set('trust proxy', config.trustProxy);
  // A permitted 500-row roster with Unicode names exceeds Express's 100 KB default.
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Origins are exact, configured URLs; the same policy guards WebSocket upgrades.
  app.use(
    (
      req: { method: string; headers: Record<string, string | undefined> },
      res: { status: (n: number) => { json: (v: unknown) => void } },
      next: () => void,
    ) => {
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers['x-judo-client'] !== 'web'
      ) {
        res.status(403).json({ message: 'CSRF_REJECTED' });
        return;
      }
      const origin = req.headers.origin;
      if (!config.allowedOrigin(origin, true)) {
        res.status(403).json({ message: 'Origin not allowed' });
        return;
      }
      next();
    },
  );
  app.enableCors({
    origin: config.origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Judo-Client'],
  });
  app.enableShutdownHooks();
  await app.init();
  app.get(LiveService).attach(app.getHttpServer());
  await app.listen(config.port, config.host);
}
void bootstrap();
