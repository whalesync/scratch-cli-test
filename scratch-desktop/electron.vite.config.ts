import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

// TODO: Remove this useless comment.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
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
        '@spinner/shared-types': resolve('../packages/shared-types/src/index.ts'),
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
