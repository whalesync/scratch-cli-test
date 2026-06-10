import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the api-client to monorepo source (mirrors electron.vite.config.ts) so tests run
      // against the same code the app bundles AND so `vi.mock('axios')` reaches it — the published
      // `dist` CJS in node_modules is outside the test module graph and would not be intercepted.
      '@spinner/shared-types/api-client': resolve(__dirname, '../packages/shared-types/src/api-client/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/shared/**/*.test.ts',
      'src/main/**/__tests__/*.spec.ts',
      'src/renderer/src/**/__tests__/*.spec.ts',
    ],
  },
});
