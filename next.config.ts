import type { NextConfig } from 'next';
import { MIDDLEWARE_UPLOAD_MAX_BYTES } from './lib/transfer-limits';

const nextConfig: NextConfig = {
  output: 'standalone',
  skipMiddlewareUrlNormalize: true,
  distDir: process.env.TDB_DIST_DIR ?? '.next',
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ['unzipper', 'archiver', 'sharp', 'pdfkit', 'argon2', 'better-sqlite3-multiple-ciphers', '@prisma/driver-adapter-utils'],
  outputFileTracingIncludes: { '/**': ['./prisma/migrations/**/*', './assets/fonts/**/*', './node_modules/better-sqlite3-multiple-ciphers/prebuilds/**/*'] },
  outputFileTracingExcludes: { '/**': ['./.env', './.env.*', './data/**/*', './uploads/**/*', './prisma/data/**/*', './prisma/**/*.db', './prisma/**/*.db-*', './prisma/**/*.sqlite', './prisma/**/*.sqlite-*'] },
  experimental: {
    // Middleware clones upload bodies before route-level size checks. Its
    // default 10 MiB silently truncates valid backups and sync archives.
    middlewareClientMaxBodySize: MIDDLEWARE_UPLOAD_MAX_BYTES,
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
  webpack: (config) => {
    // unzipper подтягивает опциональный @aws-sdk/client-s3 для S3-источников;
    // нам он не нужен, помечаем как внешний, чтобы Next не пытался его бандлить.
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : []),
      { '@aws-sdk/client-s3': 'commonjs @aws-sdk/client-s3' },
    ];
    return config;
  },
};

export default nextConfig;
