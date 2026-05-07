import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

const sharedTypesSrc = resolve('../packages/shared-types/src/index.ts');

// TODO: Remove this useless comment.
export default defineConfig({
  main: {
    resolve: {
      alias: {
        // Same as renderer: bundle from source so main never requires node_modules/@spinner/shared-types/dist.
        '@spinner/shared-types': sharedTypesSrc,
      },
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
        '@spinner/shared-types': sharedTypesSrc,
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
