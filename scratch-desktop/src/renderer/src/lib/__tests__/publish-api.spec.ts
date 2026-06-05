/**
 * Tracer test for publishApi. Locks down the wire contract between the
 * desktop renderer and the server's `/cli/v1/workbooks/.../publish-v2/{plan,run}-job`
 * CLI shim endpoints. If the server changes the URL path, request body
 * field names, or response shape, these tests should break and force a
 * coordinated fix.
 *
 * Mirrors the contract in:
 *   - server/src/cli/cli-workbook.controller.ts
 *   - server/src/publish-plan/dto/publish-v2.dto.ts
 *   - packages/shared-types/src/dto/publish/publish-plan-build.dto.ts
 *     (and publish-plan-run.dto.ts)
 *
 * No React rendering — just verifies the axios call shapes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface AxiosCall {
  url: string;
  body: unknown;
}

const calls: AxiosCall[] = [];
const responseQueue: unknown[] = [];

vi.mock('../api', () => ({
  API_CONFIG: {
    getAxiosInstance: () => ({
      post: vi.fn((url: string, body: unknown) => {
        calls.push({ url, body });
        const data = responseQueue.shift() ?? {};
        return Promise.resolve({ data });
      }),
    }),
  },
}));

beforeEach(() => {
  calls.length = 0;
  responseQueue.length = 0;
});

describe('publishApi.startPlanJob', () => {
  it('POSTs to /cli/v1/workbooks/:id/publish-v2/plan-job with connectorAccountId and runAfterPlan=false', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    const result = await publishApi.startPlanJob('wkb_123', 'ca_456');

    expect(calls).toEqual([
      {
        url: '/cli/v1/workbooks/wkb_123/publish-v2/plan-job',
        body: { connectorAccountId: 'ca_456', runAfterPlan: false },
      },
    ]);
    expect(result).toEqual({ jobId: 'job_1', pipelineId: 'pipe_1' });
  });

  it('passes through the no-diff response shape (both fields null)', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: null, pipelineId: null });

    const result = await publishApi.startPlanJob('wkb_abc', 'ca_xyz');

    expect(result).toEqual({ jobId: null, pipelineId: null });
  });

  it('includes expectedBaseDirtyHead in the body when provided (DEV-10316 TOCTOU token)', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await publishApi.startPlanJob('wkb_123', 'ca_456', 'dirtyhead_sha');

    expect(calls[0].body).toEqual({
      connectorAccountId: 'ca_456',
      runAfterPlan: false,
      expectedBaseDirtyHead: 'dirtyhead_sha',
    });
  });

  it('omits expectedBaseDirtyHead when null/undefined (legacy / no token captured)', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: 'job_1', pipelineId: 'pipe_1' });

    await publishApi.startPlanJob('wkb_123', 'ca_456', null);

    const body = calls[0].body as Record<string, unknown>;
    expect('expectedBaseDirtyHead' in body).toBe(false);
  });
});

describe('publishApi.startRunJob', () => {
  it('POSTs to /cli/v1/workbooks/:id/publish-v2/run-job with pipelineId', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: 'job_2' });

    const result = await publishApi.startRunJob('wkb_123', 'pipe_1');

    expect(calls).toEqual([
      {
        url: '/cli/v1/workbooks/wkb_123/publish-v2/run-job',
        body: { pipelineId: 'pipe_1' },
      },
    ]);
    expect(result).toEqual({ jobId: 'job_2' });
  });

  it('does not include executeSinglePhase (server treats undefined as false)', async () => {
    const { publishApi } = await import('../publish-api');
    responseQueue.push({ jobId: 'job_3' });

    await publishApi.startRunJob('wkb_99', 'pipe_99');

    const body = calls[0].body as Record<string, unknown>;
    expect('executeSinglePhase' in body).toBe(false);
  });
});
