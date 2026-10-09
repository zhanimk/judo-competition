import { LiveService } from './modules/matches/live.service.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // Local development only. Reject browser requests from other origins.
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
      if (origin && !['http://127.0.0.1:4318', 'http://localhost:4318'].includes(origin)) {
        res.status(403).json({ message: 'Origin not allowed' });
        return;
      }
      next();
    },
  );
  app.enableShutdownHooks();
  app.get(LiveService).attach(app.getHttpServer());
  const port = Number(process.env.PORT ?? 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  await app.listen(port, '127.0.0.1');
}
void bootstrap();
