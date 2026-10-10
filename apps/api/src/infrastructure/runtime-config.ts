import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';

function flag(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`INVALID_${name}`);
  return value === 'true';
}

/** One validated policy is shared by HTTP, Socket.IO and session cookies. */
@Injectable()
export class RuntimeConfig {
  readonly production: boolean;
  readonly host: string;
  readonly port: number;
  readonly origins: string[];
  readonly cookieSecure: boolean;
  readonly trustProxy: false | number | string[];
  readonly redisUrl?: string;

  constructor() {
    const env = process.env;
    this.production = env.NODE_ENV === 'production';
    this.host = env.API_HOST ?? (this.production ? '0.0.0.0' : '127.0.0.1');
    if (!isIP(this.host)) throw new Error('INVALID_API_HOST');
    this.port = Number(env.PORT ?? 4319);
    if (!Number.isSafeInteger(this.port) || this.port < 1 || this.port > 65535)
      throw new Error('INVALID_PORT');
    const origins =
      env.ALLOWED_ORIGINS ?? (this.production ? '' : 'http://127.0.0.1:4318,http://localhost:4318');
    this.origins = [
      ...new Set(
        origins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (!this.origins.length) throw new Error('ALLOWED_ORIGINS_REQUIRED');
    for (const origin of this.origins) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error('INVALID_ALLOWED_ORIGINS');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('INVALID_ALLOWED_ORIGINS');
    }
    this.cookieSecure = flag(env.COOKIE_SECURE, this.production, 'COOKIE_SECURE');
    if (this.production && !this.cookieSecure && env.COOKIE_SECURE !== 'false')
      throw new Error('COOKIE_SECURE_REQUIRED');
    if (this.cookieSecure && this.origins.some((origin) => origin.startsWith('http:')))
      throw new Error('SECURE_COOKIE_REQUIRES_HTTPS_ORIGINS');
    const proxy = env.TRUST_PROXY ?? 'false';
    if (proxy === 'false') this.trustProxy = false;
    else if (/^[1-3]$/.test(proxy)) this.trustProxy = Number(proxy);
    else {
      const addresses = proxy.split(',').map((s) => s.trim());
      if (
        !addresses.length ||
        addresses.some((entry) => {
          const [address, mask, extra] = entry.split('/');
          const version = isIP(address);
          return (
            !version ||
            extra !== undefined ||
            (mask !== undefined &&
              (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
          );
        })
      )
        throw new Error('INVALID_TRUST_PROXY');
      this.trustProxy = addresses;
    }
    if (env.API_REPLICAS !== undefined && env.API_REPLICAS !== '1')
      throw new Error('MULTIPLE_API_CLOCK_OWNERS_NOT_SUPPORTED');
    if (env.REDIS_URL) {
      try {
        const url = new URL(env.REDIS_URL);
        if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.hash)
          throw new Error();
      } catch {
        throw new Error('INVALID_REDIS_URL');
      }
      this.redisUrl = env.REDIS_URL;
    } else if (this.production) throw new Error('REDIS_URL_REQUIRED');
  }

  allowedOrigin(origin: string | undefined, allowMissing = false) {
    return origin === undefined ? allowMissing : this.origins.includes(origin);
  }
}
