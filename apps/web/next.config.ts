import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@judo/engine'],
  devIndicators: false,
  async rewrites() {
    const endpoint = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4319';
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('INVALID_API_INTERNAL_URL');
    return [{ source: '/api/v1/:path*', destination: `${url.origin}/api/v1/:path*` }];
  },
};
export default config;
