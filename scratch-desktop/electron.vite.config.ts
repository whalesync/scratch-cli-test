import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';
import { sharedTypesSourceAliases } from './shared-types-source-aliases';

// Short git commit the renderer bundle was built at, stamped in at build time and surfaced in the
// Settings screen footer. GitLab CI injects CI_COMMIT_SHORT_SHA into the release pipeline's package
// jobs; local/dev builds have no CI commit, so they show 'dev'.
const shortGitCommitHashAtBuildTime = process.env.CI_COMMIT_SHORT_SHA || 'dev';

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
    plugins: [react()],
    build: {
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
