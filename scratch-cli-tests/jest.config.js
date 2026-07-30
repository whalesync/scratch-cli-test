/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.spec.ts"],
  setupFiles: ["./src/load-env.ts"],
  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",
  // Must stay above ASYNC_JOB_POLLING_CLI_COMMAND_TIMEOUT_MS in src/cli.ts
  // (300s) plus the deploy-settle gate's wait budget (180s), so that a stalled
  // job-backed command surfaces the harness's explanatory timeout message
  // rather than being cut short by a bare Jest timeout.
  testTimeout: 540000,
};
