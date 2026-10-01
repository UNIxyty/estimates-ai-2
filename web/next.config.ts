import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Local only: several `next dev` servers can run side by side with separate build dirs (default .next).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@node-rs/argon2', 'postgres'],
  eslint: { ignoreDuringBuilds: true },
  env: {
    // Baked at build time (Docker ARG BUILD_HASH -> ENV BUILD_HASH) so client code can show it too.
    NEXT_PUBLIC_BUILD_HASH: process.env.BUILD_HASH || 'dev',
  },
};

export default nextConfig;
