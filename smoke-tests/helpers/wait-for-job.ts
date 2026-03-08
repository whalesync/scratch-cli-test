import { TestApiClient } from './test-api-client';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a job until it reaches a terminal state (completed or failed).
 */
export async function waitForJob(
  api: TestApiClient,
  jobId: string,
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const start = Date.now();

  let lastState = '';
  while (Date.now() - start < timeoutMs) {
    const res = await api.get(`/jobs/${jobId}/progress`);

    if (res.status === 401) {
      console.warn(`waitForJob: 401 on job ${jobId} (token refresh may have failed), retrying...`);
      await sleep(2000);
      continue;
    }

    if (res.status !== 200) {
      throw new Error(`Failed to get job progress: ${res.status} ${JSON.stringify(res.data)}`);
    }

    const job = res.data;
    if (job.state !== lastState) {
      console.log(`waitForJob: job ${jobId} state=${job.state}`);
      lastState = job.state;
    }
    if (job.state === 'completed' || job.state === 'failed') {
      return job;
    }

    await sleep(500);
  }

  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms (last state: ${lastState})`);
}

/**
 * Wait for a publish plan to reach "planned" or "failed" status.
 */
export async function waitForPlan(
  api: TestApiClient,
  workbookId: string,
  jobId: string,
  timeoutMs = 60000,
): Promise<{ state: string; publicProgress?: any; failedReason?: string }> {
  const job = await waitForJob(api, jobId, timeoutMs);
  return job;
}
