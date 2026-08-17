import { BUILD_VERSION } from '@/version';
import { withPostHogConfig } from '@posthog/nextjs-config';
import type { NextConfig } from 'next';
import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The function form of a Next config — `next.config.ts` may export either a plain `NextConfig` or a
 * factory that Next invokes with the build phase. `withPostHogConfig` returns this form (despite
 * being typed as returning a plain `NextConfig`), so we need the type to wrap what it hands back.
 */
type NextConfigFactory = (phase: string, context: { defaultConfig: NextConfig }) => Promise<NextConfig>;

const baseNextConfig: NextConfig = {
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

/**
 * Deletes the browser sourcemaps from the build output, the way PostHog's `deleteAfterUpload` would.
 *
 * `deleteAfterUpload` only runs on a successful upload, so without this a failed upload would leave
 * the sourcemaps in place — and because `productionBrowserSourceMaps` is on, the deployed client
 * would then serve them publicly. Never throws: this runs while already recovering from an upload
 * failure, and a cleanup problem must not be what fails the build.
 */
async function deleteBrowserSourcemapsFromBuildOutput(projectDir: string, distDir: string): Promise<void> {
  const staticAssetsDirectory = join(isAbsolute(distDir) ? distDir : resolve(projectDir, distDir), 'static');

  try {
    const staticAssetEntries = await readdir(staticAssetsDirectory, { recursive: true, withFileTypes: true });
    const sourcemapPaths = staticAssetEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.map'))
      .map((entry) => join(entry.parentPath, entry.name));

    await Promise.all(sourcemapPaths.map((sourcemapPath) => rm(sourcemapPath, { force: true })));
    console.warn(`Deleted ${sourcemapPaths.length} un-uploaded browser sourcemap(s) from ${staticAssetsDirectory}.`);
  } catch (sourcemapCleanupError) {
    console.warn(
      `Failed to delete un-uploaded browser sourcemaps from ${staticAssetsDirectory}.`,
      sourcemapCleanupError,
    );
  }
}

/**
 * Wraps the base config with PostHog's sourcemap upload, made non-fatal.
 *
 * PostHog uploads sourcemaps from inside `next build` via the `runAfterProductionCompile` compiler
 * hook, and `@posthog/nextjs-config` exposes no fail-soft option — so a transient outage of their
 * symbol-set API aborts the entire production build and strands the deploy (exactly what happened on
 * pipeline 2766636773, where two request timeouts and a 500 exhausted posthog-cli's retries). Losing
 * one build's sourcemaps only degrades how readable PostHog's error tracking is; failing the build
 * blocks the release, so we swallow the upload error and carry on.
 *
 * The wrapping has to happen at the factory level: the hook does not exist on what `withPostHogConfig`
 * returns, only on the config its factory resolves to once Next calls it.
 */
function withFailSoftPosthogSourcemapUpload(configToWrap: NextConfig): NextConfigFactory {
  // `withPostHogConfig` is typed as returning a plain `NextConfig`, but it actually returns the
  // function form of a Next config.
  const posthogNextConfigFactory = withPostHogConfig(configToWrap, {
    envId: process.env.POSTHOG_PROJECT_ID as string, // Environment ID for the project
    personalApiKey: process.env.POSTHOG_API_KEY as string, // Personal API key for uploading sourcemaps
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    sourcemaps: {
      enabled: true,
      version: BUILD_VERSION || undefined,
      deleteAfterUpload: true,
    },
  }) as unknown as NextConfigFactory;

  return async (phase, context) => {
    const posthogResolvedConfig = await posthogNextConfigFactory(phase, context);
    const posthogSourcemapUploadHook = posthogResolvedConfig.compiler?.runAfterProductionCompile;
    if (!posthogSourcemapUploadHook) {
      return posthogResolvedConfig;
    }

    return {
      ...posthogResolvedConfig,
      compiler: {
        ...posthogResolvedConfig.compiler,
        runAfterProductionCompile: async (productionCompileMetadata) => {
          try {
            await posthogSourcemapUploadHook(productionCompileMetadata);
          } catch (posthogSourcemapUploadError) {
            console.warn(
              'PostHog sourcemap upload failed; continuing the production build without uploaded sourcemaps.',
              posthogSourcemapUploadError,
            );
            await deleteBrowserSourcemapsFromBuildOutput(
              productionCompileMetadata.projectDir,
              productionCompileMetadata.distDir,
            );
          }
        },
      },
    };
  };
}

const shouldUploadSourcemapsToPosthog = Boolean(process.env.POSTHOG_PROJECT_ID && process.env.POSTHOG_API_KEY);

export default shouldUploadSourcemapsToPosthog ? withFailSoftPosthogSourcemapUpload(baseNextConfig) : baseNextConfig;
