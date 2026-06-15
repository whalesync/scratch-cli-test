import { resolve } from 'path';

/**
 * Maps every `@spinner/shared-types` entrypoint — the barrel plus each subpath (`/transform`,
 * `/format`, `/api-client`) — to the monorepo SOURCE under `packages/shared-types/src`.
 *
 * This is the single source of truth shared by `electron.vite.config.ts` (what the app bundles)
 * and `vitest.config.mts` (what the tests run), so the two can never drift apart. That drift is
 * exactly what broke the desktop vitest run (DEV-10349): the test config aliased only `/api-client`,
 * so value imports of `/transform` and `/format` fell through to the package `exports` map, which
 * points at a `dist/` that is never built before a local `vitest run` (scratch-desktop is not in
 * Turborepo) — yielding "Cannot find package '@spinner/shared-types/transform'".
 *
 * Resolving to source rather than the built `dist` is deliberate: tests exercise the exact code the
 * app bundles, and `vi.mock(...)` can intercept it (the published `dist` CJS in node_modules sits
 * outside the test module graph and would not be intercepted).
 *
 * Order matters: the specific subpaths MUST precede the bare-barrel alias, because Vite matches
 * string aliases by prefix — `@spinner/shared-types` would otherwise also swallow
 * `@spinner/shared-types/transform`. The returned object preserves that order.
 *
 * @param scratchDesktopDir absolute path to the scratch-desktop package directory. electron-vite
 *   runs with `cwd` = scratch-desktop, so it passes `process.cwd()`; the vitest config passes
 *   `__dirname` (robust to whichever directory vitest is invoked from).
 */
export function sharedTypesSourceAliases(scratchDesktopDir: string): Record<string, string> {
  const sharedTypesSrc = (subpath: string): string =>
    resolve(scratchDesktopDir, '../packages/shared-types/src', subpath);

  return {
    '@spinner/shared-types/transform': sharedTypesSrc('transform/index.ts'),
    '@spinner/shared-types/format': sharedTypesSrc('format/index.ts'),
    '@spinner/shared-types/api-client': sharedTypesSrc('api-client/index.ts'),
    '@spinner/shared-types': sharedTypesSrc('index.ts'),
  };
}
