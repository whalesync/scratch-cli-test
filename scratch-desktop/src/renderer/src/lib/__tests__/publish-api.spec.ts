/**
 * Tracer test for the desktop CLI publish contract: the wire shape between the desktop renderer
 * and the server's `/cli/v1/workbooks/.../publish-v2/{plan,run}-job` CLI shim endpoints, now
 * routed through the shared client's `publish.viaCliRoute.*` namespace
 * (`packages/shared-types/src/api-client/resources/publish-via-cli-route.ts`). If the server
 * changes the URL path, request body field names, or response shape, these tests should break and
 * force a coordinated fix.
 *
 * This locks the DESKTOP `/cli/v1/...` route family ONLY — it is deliberately distinct from the
 * web `/workbook/...` publish route family (`publish.viaWorkbookRoute.*`). Do not conflate them.
 *
 * Mirrors the contract in:
 *   - server/src/cli/cli-workbook.controller.ts
 *   - server/src/publish-plan/dto/publish-v2.dto.ts
 *
 * No React rendering — `axios` is mocked so the shared client's internal instance records the
 * exact `(url, body)` of each request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface AxiosCall {
  url: string;
  body?: unknown;
  params?: unknown;
}

const calls: AxiosCall[] = [];
const responseQueue: unknown[] = [];

const mockInstance = {
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  post: vi.fn((url: string, body: unknown) => {
    calls.push({ url, body });
    return Promise.resolve({ data: responseQueue.shift() ?? {} });
  }),
  get: vi.fn((url: string, config?: { params?: unknown }) => {
    calls.push({ url, params: config?.params });
    return Promise.resolve({ data: responseQueue.shift() ?? {} });
  }),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  request: vi.fn(),
};

vi.mock('axios', () => {
  const create = vi.fn(() => mockInstance);
  const isAxiosError = vi.fn(() => false);
  return { default: { create, isAxiosError }, create, isAxiosError };
});

beforeEach(() => {
  calls.length = 0;
  responseQueue.length = 0;
});

describe('publish.viaCliRoute.planJob', () => {
  it('POSTs to /cli/v1/workbooks/:id/publish-v2/plan-job with connectorAccountId and runAfterPlan=false', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    const result = await scratchApiClient.publish.viaCliRoute.planJob('wkb_123', 'ca_456');

    expect(calls).toEqual([
      {
        url: '/cli/v1/workbooks/wkb_123/publish-v2/plan-job',
        body: { connectorAccountId: 'ca_456', runAfterPlan: false },
      },
    ]);
    expect(result).toEqual({ jobId: 'job_1', pipelineId: 'pipe_1' });
  });

  it('passes through the no-diff response shape (both fields null)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: null, pipelineId: null });

    const result = await scratchApiClient.publish.viaCliRoute.planJob('wkb_abc', 'ca_xyz');

    expect(result).toEqual({ jobId: null, pipelineId: null });
  });

  it('includes expectedBaseDirtyHead in the body when provided (DEV-10316 TOCTOU token)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await scratchApiClient.publish.viaCliRoute.planJob('wkb_123', 'ca_456', {
      expectedBaseDirtyHead: 'dirtyhead_sha',
    });

    expect(calls[0].body).toEqual({
      connectorAccountId: 'ca_456',
      runAfterPlan: false,
      expectedBaseDirtyHead: 'dirtyhead_sha',
    });
  });

  it('omits expectedBaseDirtyHead when null/undefined (legacy / no token captured)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await scratchApiClient.publish.viaCliRoute.planJob('wkb_123', 'ca_456', {
      expectedBaseDirtyHead: null,
    });

    const body = calls[0].body as Record<string, unknown>;
    expect('expectedBaseDirtyHead' in body).toBe(false);
  });

  it('includes filePath in the body when provided (DEV-10413 single-record scope)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await scratchApiClient.publish.viaCliRoute.planJob('wkb_123', 'ca_456', {
      filePath: 'posts/rec_1.json',
    });

    expect(calls[0].body).toEqual({
      connectorAccountId: 'ca_456',
      runAfterPlan: false,
      filePath: 'posts/rec_1.json',
    });
  });

  it('omits filePath when not provided (workspace-wide publish)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await scratchApiClient.publish.viaCliRoute.planJob('wkb_123', 'ca_456');

    const body = calls[0].body as Record<string, unknown>;
    expect('filePath' in body).toBe(false);
  });
});

describe('publish.viaCliRoute.runJob', () => {
  it('POSTs to /cli/v1/workbooks/:id/publish-v2/run-job with pipelineId and publishOrigin=desktop', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_2' });

    const result = await scratchApiClient.publish.viaCliRoute.runJob('wkb_123', 'pipe_1');

    // DEV-10048: the desktop/CLI route always sends publishOrigin=desktop so the
    // server routes connector-rejected paths back to the client (failed-patches.json).
    expect(calls).toEqual([
      {
        url: '/cli/v1/workbooks/wkb_123/publish-v2/run-job',
        body: { pipelineId: 'pipe_1', publishOrigin: 'desktop' },
      },
    ]);
    expect(result).toEqual({ jobId: 'job_2' });
  });

  it('does not include executeSinglePhase (server treats undefined as false)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    responseQueue.push({ jobId: 'job_3' });

    await scratchApiClient.publish.viaCliRoute.runJob('wkb_99', 'pipe_99');

    const body = calls[0].body as Record<string, unknown>;
    expect('executeSinglePhase' in body).toBe(false);
  });
});

describe('publish.viaCliRoute.failedOperations', () => {
  it('GETs the complete failed-operations set with pagination params (DEV-10756)', async () => {
    const { scratchApiClient } = await import('../scratch-api-client');
    const page = {
      data: [{ filePath: 'Folder/a.json', phase: 'edits', error: 'rejected' }],
      total: 1,
      page: 2,
      pageSize: 200,
    };
    responseQueue.push(page);

    const result = await scratchApiClient.publish.viaCliRoute.failedOperations('wkb_123', 'pipe_1', {
      page: 2,
      pageSize: 200,
    });

    // This is the complete-set channel the reconcile trusts — distinct from the
    // capped `publicProgress.failedOperations`. If the server route/path changes,
    // this and the Rust client must move together.
    expect(calls).toEqual([
      {
        url: '/cli/v1/workbooks/wkb_123/publish-v2/pipe_1/failed-operations',
        params: { page: 2, pageSize: 200 },
      },
    ]);
    expect(result).toEqual(page);
  });
});
