import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
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
