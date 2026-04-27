import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/shared/**/*.test.ts', 'src/main/**/__tests__/*.spec.ts'],
  },
});
