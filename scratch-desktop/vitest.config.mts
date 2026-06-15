import { defineConfig } from 'vitest/config';
import { sharedTypesSourceAliases } from './shared-types-source-aliases';

export default defineConfig({
  resolve: {
    // Resolve every @spinner/shared-types entrypoint to monorepo source — shared with
    // electron.vite.config.ts so the test module graph matches what the app bundles (and so
    // vi.mock(...) can intercept it). See shared-types-source-aliases.ts for the full rationale.
    alias: sharedTypesSourceAliases(__dirname),
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
