import { BUILD_VERSION } from '@/version';
import { withPostHogConfig } from '@posthog/nextjs-config';
import type { NextConfig } from 'next';

let nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: true,
  turbopack: {
    root: '..',
  },
  devIndicators: {
    position: 'bottom-right',
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.infrastructureLogging = { ...config.infrastructureLogging, level: 'error' };
    }
    return config;
  },
  async redirects() {
    return [
      { source: '/signout', destination: '/sign-out', permanent: true },
      { source: '/logout', destination: '/sign-out', permanent: true },
      { source: '/log-out', destination: '/sign-out', permanent: true },
      { source: '/signin', destination: '/sign-in', permanent: true },
      { source: '/login', destination: '/sign-in', permanent: true },
      { source: '/log-in', destination: '/sign-in', permanent: true },
    ];
  },
  // Use a separate output directory in dev mode so `yarn build` doesn't clobber
  // the dev server's webpack chunks (which causes MODULE_NOT_FOUND errors).
  ...(process.env.NODE_ENV === 'development' && { distDir: '.next-dev' }),
};

if (process.env.POSTHOG_PROJECT_ID && process.env.POSTHOG_API_KEY) {
  // Additional config to upload sourcemaps to PostHog for production builds
  nextConfig = withPostHogConfig(nextConfig, {
    envId: process.env.POSTHOG_PROJECT_ID as string, // Environment ID for the project
    personalApiKey: process.env.POSTHOG_API_KEY as string, // Personal API key for uploading sourcemaps
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    sourcemaps: {
      enabled: true,
      version: BUILD_VERSION || undefined,
      deleteAfterUpload: true,
    },
  });
}

export default nextConfig;
