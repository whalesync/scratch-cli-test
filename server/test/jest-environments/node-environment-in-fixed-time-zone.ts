/**
 * Jest's `node` test environment, with the worker process pinned to a fixed time zone while one test file runs.
 *
 * Assigning `process.env.TZ` inside a spec does nothing: Jest hands each test file a sandboxed COPY of
 * `process.env`, so the Node runtime never sees the change and keeps the host's zone (UTC in CI). A test
 * environment runs in the worker itself, outside that sandbox, so it can set the real `TZ`. Node re-reads it on
 * assignment for every `Date` and `Intl` in the process. The previous zone is restored when the file finishes, so
 * the next file in the same worker is unaffected.
 *
 * Opt in from the first comment block of a spec:
 *
 *   @jest-environment <rootDir>/../test/jest-environments/node-environment-in-fixed-time-zone.ts   (unit specs)
 *   @jest-environment <rootDir>/../jest-environments/node-environment-in-fixed-time-zone.ts        (integration)
 *   @jest-environment-options {"timeZone": "America/New_York"}
 */
import { TestEnvironment as NodeTestEnvironment } from 'jest-environment-node';

// Taken from the base class: the hoisted `@jest/environment` is a different major than the one it was built against.
type NodeTestEnvironmentConstructorParameters = ConstructorParameters<typeof NodeTestEnvironment>;

export default class NodeEnvironmentInFixedTimeZone extends NodeTestEnvironment {
  private readonly timeZoneWhileThisTestFileRuns: string;
  private workerTimeZoneBeforeThisTestFile: string | undefined;

  constructor(
    config: NodeTestEnvironmentConstructorParameters[0],
    context: NodeTestEnvironmentConstructorParameters[1],
  ) {
    super(config, context);
    const configuredTimeZone = config.projectConfig.testEnvironmentOptions.timeZone;
    if (typeof configuredTimeZone !== 'string' || configuredTimeZone === '') {
      throw new Error(
        `${context.testPath}: node-environment-in-fixed-time-zone needs @jest-environment-options {"timeZone": "<IANA zone>"}`,
      );
    }
    this.timeZoneWhileThisTestFileRuns = configuredTimeZone;
  }

  override async setup(): Promise<void> {
    await super.setup();
    this.workerTimeZoneBeforeThisTestFile = process.env.TZ;
    process.env.TZ = this.timeZoneWhileThisTestFileRuns;
  }

  override async teardown(): Promise<void> {
    if (this.workerTimeZoneBeforeThisTestFile === undefined) delete process.env.TZ;
    else process.env.TZ = this.workerTimeZoneBeforeThisTestFile;
    await super.teardown();
  }
}
