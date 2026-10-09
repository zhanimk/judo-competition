import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@judo/engine'],
  devIndicators: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: 'http://127.0.0.1:4319/api/v1/:path*' }];
  },
};
export default config;
