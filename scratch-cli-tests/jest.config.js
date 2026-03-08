/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  setupFiles: ['./src/load-env.ts'],
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/global-teardown.ts',
  testTimeout: 120000, // 120s — pull/publish operations can be slow
};
