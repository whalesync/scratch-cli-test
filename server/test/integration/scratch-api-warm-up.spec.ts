/**
 * Regression tests for `waitForScratchApiToBeWarm` in `common.ts`.
 *
 * test-api scales to zero, so a suite whose first request lands on a cold instance waited ~40s for
 * Cloud Run to start one, and its first write timed out on a healthy server. These lock down that
 * the warm-up waits out a cold start (including a second one right after the first response),
 * treats an error status or a dropped connection as "not warm yet", and fails with a readable
 * error when the API never warms up.
 *
 * Fully self-contained — it drives a local `http` server and needs no database, no external
 * network, and no environment configuration.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

import { ScratchApiWarmUpSettings, waitForScratchApiToBeWarm } from './common';

/** How each `/health` probe is answered, in arrival order. Probes past the end of the list get the last entry. */
type HealthProbeBehavior = 'fast-200' | 'slow-200' | 'fast-503' | 'drop-connection';

/** Comfortably above any local round trip, comfortably below the delay used to simulate a cold instance. */
const MAXIMUM_LATENCY_OF_A_WARM_RESPONSE_IN_TESTS_MS = 300;
const SIMULATED_COLD_START_DELAY_MS = 900;

const FAST_TEST_WARM_UP_SETTINGS: Partial<ScratchApiWarmUpSettings> = {
  maximumLatencyOfAWarmHealthResponseMs: MAXIMUM_LATENCY_OF_A_WARM_RESPONSE_IN_TESTS_MS,
  consecutiveFastHealthResponsesRequiredToCountAsWarm: 3,
  delayBetweenWarmUpProbesMs: 10,
  warmUpProbeTimeoutMs: 5_000,
  totalWarmUpBudgetMs: 15_000,
};

describe('waitForScratchApiToBeWarm', () => {
  jest.setTimeout(30_000);

  let server: http.Server;
  let baseUrl: string;
  let healthProbeBehaviorsInArrivalOrder: HealthProbeBehavior[];
  let handledHealthProbeCount: number;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    handledHealthProbeCount = 0;
    server = http.createServer((request, response) => {
      const behaviorIndex = Math.min(handledHealthProbeCount, healthProbeBehaviorsInArrivalOrder.length - 1);
      const behavior = healthProbeBehaviorsInArrivalOrder[behaviorIndex];
      handledHealthProbeCount += 1;
      switch (behavior) {
        case 'fast-200':
          response.writeHead(200).end('{"status":"alive"}');
          return;
        case 'slow-200':
          setTimeout(() => response.writeHead(200).end('{"status":"alive"}'), SIMULATED_COLD_START_DELAY_MS);
          return;
        case 'fast-503':
          response.writeHead(503).end('Service is disabled');
          return;
        case 'drop-connection':
          request.socket.destroy();
          return;
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleWarnSpy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns after the required run of fast responses when the API is already warm', async () => {
    healthProbeBehaviorsInArrivalOrder = ['fast-200'];

    await waitForScratchApiToBeWarm(baseUrl, FAST_TEST_WARM_UP_SETTINGS);

    expect(handledHealthProbeCount).toBe(3);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('waits out a cold start and reports that the API was cold', async () => {
    healthProbeBehaviorsInArrivalOrder = ['slow-200', 'fast-200'];

    await waitForScratchApiToBeWarm(baseUrl, FAST_TEST_WARM_UP_SETTINGS);

    // The slow first response does not count toward the run, so three fast ones must follow it.
    expect(handledHealthProbeCount).toBe(4);
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('was cold'));
  });

  it('starts the run over when a second cold start follows the first fast response', async () => {
    // Cloud Run has replaced a freshly started instance right after its first response, so one fast
    // response must not be taken as proof the API will stay warm.
    healthProbeBehaviorsInArrivalOrder = ['slow-200', 'fast-200', 'slow-200', 'fast-200'];

    await waitForScratchApiToBeWarm(baseUrl, FAST_TEST_WARM_UP_SETTINGS);

    expect(handledHealthProbeCount).toBe(6);
  });

  it('does not count an error status or a dropped connection as warm', async () => {
    healthProbeBehaviorsInArrivalOrder = ['fast-503', 'drop-connection', 'fast-200', 'fast-503', 'fast-200'];

    await waitForScratchApiToBeWarm(baseUrl, FAST_TEST_WARM_UP_SETTINGS);

    // fast-503, drop, fast-200, fast-503 (resets the run), then three fast-200s.
    expect(handledHealthProbeCount).toBe(7);
  });

  it('gives up with an error that lists what the probes saw when the API never warms up', async () => {
    healthProbeBehaviorsInArrivalOrder = ['fast-503'];

    await expect(
      waitForScratchApiToBeWarm(baseUrl, { ...FAST_TEST_WARM_UP_SETTINGS, totalWarmUpBudgetMs: 500 }),
    ).rejects.toThrow(/did not warm up within 0\.5s.*503 in \d+ms/);
  });
});
