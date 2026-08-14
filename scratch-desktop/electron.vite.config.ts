import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { sharedTypesSourceAliases } from './shared-types-source-aliases';

// Short git commit the renderer bundle was built at, stamped in at build time and surfaced in the
// Settings screen footer. GitLab CI injects CI_COMMIT_SHORT_SHA into the release pipeline's package
// jobs; local/dev builds have no CI commit, so they show 'dev'.
const shortGitCommitHashAtBuildTime = process.env.CI_COMMIT_SHORT_SHA || 'dev';

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Derive the PostHog *assets* origin from the configured ingest host. PostHog's JS client fetches its
 * remote config from the region assets host (`https://<region>-assets.i.posthog.com/array/<token>/config`),
 * which is a different origin from the ingest host and so needs its own `connect-src` entry. For managed
 * cloud (`us.i.posthog.com`, `eu.i.posthog.com`, …) that means inserting `-assets` into the region label;
 * for a self-hosted/custom host, assets are served from the same host, so we return that host's own origin.
 */
function posthogAssetsOriginForHost(postHogHostUrl: string | undefined): string | null {
  if (!postHogHostUrl) return null;
  let parsedPostHogHostUrl: URL;
  try {
    parsedPostHogHostUrl = new URL(postHogHostUrl);
  } catch {
    return null;
  }
  const managedCloudRegionMatch = parsedPostHogHostUrl.hostname.match(/^([a-z]+)\.i\.posthog\.com$/);
  if (managedCloudRegionMatch) {
    return `https://${managedCloudRegionMatch[1]}-assets.i.posthog.com`;
  }
  return parsedPostHogHostUrl.origin;
}

/**
 * Build the renderer's Content-Security-Policy (SCR-006 / DEV-11001, defense-in-depth for renderer
 * XSS). `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`) is the load-bearing directive: it stops
 * an injected/remote script from running even if the HTML sanitizer were ever bypassed. `connect-src`
 * is derived from the SAME build-time env the renderer bundles (`VITE_SCRATCH_API_URL`,
 * `VITE_POSTHOG_HOST`) so it always matches where the app actually talks; PostHog uses the bundled
 * "no-external" build (DEV-10676) so no PostHog *script* is ever fetched. Two PostHog origins are still
 * `connect-src`ed: the ingest host (event capture) and the region *assets* host
 * (`<region>-assets.i.posthog.com`), where the client fetches its remote config JSON — session replay
 * waits for that config before it starts, so blocking it silently disables replay.
 * `style-src 'unsafe-inline'` is required by Mantine's runtime style injection and the rich-text
 * renderer's scoped `<style>`; inline styles are not a script-execution vector.
 */
function buildContentSecurityPolicy(env: Record<string, string>): string {
  const connectSrc = new Set<string>(["'self'", 'https://us.i.posthog.com', 'https://us-assets.i.posthog.com']);
  for (const origin of [
    originOf(env.VITE_SCRATCH_API_URL),
    originOf(env.VITE_POSTHOG_HOST),
    posthogAssetsOriginForHost(env.VITE_POSTHOG_HOST),
  ]) {
    if (origin) connectSrc.add(origin);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSrc).join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ');
}

/**
 * Inject the CSP as a `<meta http-equiv>` — the packaged renderer is a `file://` `loadFile`, so an
 * HTTP `Content-Security-Policy` header (`onHeadersReceived`) never fires and the meta tag is the
 * correct delivery. Build-only (`apply: 'build'`): dev (`electron-vite dev`, http://localhost:5173)
 * keeps HMR's inline scripts working and is already covered by the main-process navigation guard.
 */
function contentSecurityPolicyMetaPlugin(): Plugin {
  let resolvedEnv: Record<string, string> = {};
  return {
    name: 'scratch-csp-meta',
    apply: 'build',
    configResolved(config) {
      resolvedEnv = config.env as Record<string, string>;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildContentSecurityPolicy(resolvedEnv) },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    resolve: {
      // Bundle every @spinner/shared-types entrypoint from monorepo source so main never requires
      // node_modules/@spinner/shared-types/dist. Shared with vitest.config.mts so the tests and the
      // app resolve identically — see shared-types-source-aliases.ts.
      alias: sharedTypesSourceAliases(process.cwd()),
    },
    plugins: [
      externalizeDepsPlugin({
        // @spinner/shared-types is aliased to monorepo source above; if externalized, main would still require() the npm package.
        // lodash: shared-types (e.g. ids.ts) uses lodash/findKey; electron-builder strips node_modules/lodash from app.asar (renderer-only), so bundle it into main.
        exclude: ['electron-store', '@spinner/shared-types', 'lodash'],
      }),
    ],
    build: {
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        ...sharedTypesSourceAliases(process.cwd()),
      },
    },
    define: {
      __GIT_COMMIT_HASH__: JSON.stringify(shortGitCommitHashAtBuildTime),
    },
    plugins: [react(), contentSecurityPolicyMetaPlugin()],
    build: {
      // Electron/Chromium supports <link rel="modulepreload"> natively, so drop Vite's inline
      // module-preload polyfill <script> — it would otherwise need 'unsafe-inline' in script-src and
      // defeat the CSP (SCR-006 / DEV-11001).
      modulePreload: { polyfill: false },
      commonjsOptions: {
        include: [/node_modules/],
      },
    },
    css: {
      modules: {
        localsConvention: 'camelCaseOnly',
      },
    },
  },
});
