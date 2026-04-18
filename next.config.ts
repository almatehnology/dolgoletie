import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['unzipper', 'archiver', 'sharp', 'pdfkit'],
  experimental: {
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
