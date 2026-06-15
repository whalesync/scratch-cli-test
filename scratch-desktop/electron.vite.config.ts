import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';
import { sharedTypesSourceAliases } from './shared-types-source-aliases';

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
