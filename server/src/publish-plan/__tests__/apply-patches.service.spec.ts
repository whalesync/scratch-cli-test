import { UploadPatchPayload, WorkbookId } from '@spinner/shared-types';
import { Readable } from 'stream';
import { applyJsonMergePatch, ApplyPatchesService } from '../apply-patches.service';

describe('applyJsonMergePatch (RFC 7396)', () => {
  it('overwrites scalar values', () => {
    expect(applyJsonMergePatch({ a: 1, b: 2 }, { a: 99 })).toEqual({ a: 99, b: 2 });
  });

  it('deletes keys when patch sets them to null', () => {
    expect(applyJsonMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it('merges nested objects recursively', () => {
    expect(applyJsonMergePatch({ a: { x: 1, y: 2 } }, { a: { y: 99, z: 3 } })).toEqual({ a: { x: 1, y: 99, z: 3 } });
  });

  it('treats arrays as atomic replacements', () => {
    expect(applyJsonMergePatch({ tags: ['a', 'b'] }, { tags: ['x'] })).toEqual({ tags: ['x'] });
  });

  it('returns the patch unchanged when patch is not an object', () => {
    expect(applyJsonMergePatch({ a: 1 }, null)).toBeNull();
    expect(applyJsonMergePatch({ a: 1 }, 'replaced')).toBe('replaced');
  });

  it('treats a non-object target as if it were empty', () => {
    expect(applyJsonMergePatch(null, { a: 1 })).toEqual({ a: 1 });
    expect(applyJsonMergePatch('previous', { a: 1 })).toEqual({ a: 1 });
  });
});

describe('ApplyPatchesService.applyAndPublish', () => {
  const workbookId = 'wkb_test' as WorkbookId;
  const connectorAccountId = 'ca_test';
  const userId = 'usr_test';
  const organizationId = 'org_test';
  const uploadId = 'up_test';

  function buildService(
    payload: UploadPatchPayload,
    opts?: { hasDiffs?: boolean; existingContent?: Record<string, string> },
  ) {
    const hasDiffs = opts?.hasDiffs ?? true;
    const existingContent = opts?.existingContent ?? {};

    const commitCalls: Array<{ branch: string; files: { path: string; content: string }[]; message: string }> = [];
    const deleteCalls: Array<{ branch: string; paths: string[]; message: string }> = [];
    const planJobCalls: Array<{ pipelineId: string; runAfterPlan: boolean }> = [];
    const setActiveCalls: Array<{ pipelineId: string; bullJobId: string }> = [];

    const db = {
      client: {
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([{ path: '/Companies' }, { path: '/Posts' }]),
        },
      },
    };

    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org/wkb/ca'),
      getRepoFile: jest.fn((_repo: string, _branch: string, path: string) =>
        Promise.resolve(existingContent[path] ? { content: existingContent[path] } : null),
      ),
      commitFilesToBranch: jest.fn(
        (_repo: string, branch: string, files: { path: string; content: string }[], message: string) => {
          commitCalls.push({ branch, files, message });
          return Promise.resolve();
        },
      ),
      deleteFilesFromBranch: jest.fn((_repo: string, branch: string, paths: string[], message: string) => {
        deleteCalls.push({ branch, paths, message });
        return Promise.resolve();
      }),
    };

    const objectStorageService = {
      streamObjectFromPatchUpload: jest.fn(() => Readable.from([Buffer.from(JSON.stringify(payload))])),
    };

    const publishPlanBuildService = {
      hasDiffs: jest.fn().mockResolvedValue(hasDiffs),
      createPipeline: jest.fn().mockResolvedValue({ pipelineId: 'pipe_1', branchName: 'publish/usr/pipe_1' }),
      setActiveJob: jest.fn((pipelineId: string, bullJobId: string) => {
        setActiveCalls.push({ pipelineId, bullJobId });
        return Promise.resolve();
      }),
    };

    const bullEnqueuerService = {
      enqueuePlanPipelineJob: jest.fn(
        (_wb: unknown, _actor: unknown, pipelineId: string, _ca: unknown, runAfterPlan: boolean) => {
          planJobCalls.push({ pipelineId, runAfterPlan });
          return Promise.resolve({ id: 'job_1' });
        },
      ),
    };

    const service = new ApplyPatchesService(
      db as never,
      scratchGitService as never,
      objectStorageService as never,
      publishPlanBuildService as never,
      bullEnqueuerService as never,
    );

    return {
      service,
      commitCalls,
      deleteCalls,
      planJobCalls,
      setActiveCalls,
      mocks: { db, scratchGitService, objectStorageService, publishPlanBuildService, bullEnqueuerService },
    };
  }

  function defaultArgs(uploadIdOverride?: string) {
    return {
      workbookId,
      userId,
      organizationId,
      connectorAccountId,
      uploadId: uploadIdOverride ?? uploadId,
    };
  }

  it('applies a partial merge patch on top of existing content', async () => {
    const { service, commitCalls } = buildService(
      {
        patches: [
          {
            path: 'Companies/rec1.json',
            patch: { name: 'New Name' },
          },
        ],
      },
      {
        existingContent: {
          'Companies/rec1.json': JSON.stringify({ id: 'rec1', name: 'Old Name', industry: 'Tech' }),
        },
      },
    );

    const result = await service.applyAndPublish(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0].branch).toBe('dirty');
    expect(commitCalls[0].files).toHaveLength(1);
    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    expect(content).toEqual({ id: 'rec1', name: 'New Name', industry: 'Tech' });
    expect(result.patchCount).toBe(1);
  });

  it('writes a new file when the patch has no existing base', async () => {
    const { service, commitCalls } = buildService({
      patches: [
        {
          path: 'Posts/rec_new.json',
          patch: { id: 'rec_new', title: 'Hello' },
        },
      ],
    });

    await service.applyAndPublish(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    expect(JSON.parse(commitCalls[0].files[0].content)).toEqual({ id: 'rec_new', title: 'Hello' });
  });

  it('routes patch=null to deleteFilesFromBranch and skips the commit', async () => {
    const { service, commitCalls, deleteCalls } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: null }],
    });

    await service.applyAndPublish(defaultArgs());

    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].paths).toEqual(['Companies/rec1.json']);
  });

  it('drops a key from the existing content when the patch sets it to null', async () => {
    const { service, commitCalls } = buildService(
      {
        patches: [
          {
            path: 'Companies/rec1.json',
            patch: { website: null },
          },
        ],
      },
      {
        existingContent: {
          'Companies/rec1.json': JSON.stringify({ id: 'rec1', name: 'Acme', website: 'old.example' }),
        },
      },
    );

    await service.applyAndPublish(defaultArgs());

    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    expect(content).toEqual({ id: 'rec1', name: 'Acme' });
  });

  it('rejects path traversal before writing anything', async () => {
    const { service, commitCalls, deleteCalls } = buildService({
      patches: [{ path: '../etc/passwd', patch: { evil: true } }],
    });

    await expect(service.applyAndPublish(defaultArgs())).rejects.toThrow(/traversal/i);
    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('rejects the WHOLE batch when any path is invalid (all-or-nothing)', async () => {
    // Two valid patches followed by one traversal patch — even though the
    // first two would have succeeded, none should be applied. Locks in the
    // pre-write validation invariant.
    const { service, commitCalls, deleteCalls, planJobCalls } = buildService({
      patches: [
        { path: 'Companies/rec1.json', patch: { name: 'Acme' } },
        { path: 'Posts/rec_new.json', patch: { id: 'rec_new', title: 'Hello' } },
        { path: '../etc/passwd', patch: { evil: true } },
      ],
    });

    await expect(service.applyAndPublish(defaultArgs())).rejects.toThrow(/traversal/i);
    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
    expect(planJobCalls).toHaveLength(0);
  });

  it('handles a mixed batch of writes and deletes in one call', async () => {
    const { service, commitCalls, deleteCalls } = buildService(
      {
        patches: [
          { path: 'Companies/rec1.json', patch: { name: 'New' } },
          { path: 'Posts/rec_new.json', patch: { id: 'rec_new', title: 'Hi' } },
          { path: 'Companies/rec2.json', patch: null },
        ],
      },
      {
        existingContent: {
          'Companies/rec1.json': JSON.stringify({ id: 'rec1', name: 'Old' }),
          'Companies/rec2.json': JSON.stringify({ id: 'rec2', name: 'ToDelete' }),
        },
      },
    );

    await service.applyAndPublish(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0].files).toHaveLength(2);
    const paths = commitCalls[0].files.map((f) => f.path).sort();
    expect(paths).toEqual(['Companies/rec1.json', 'Posts/rec_new.json']);

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].paths).toEqual(['Companies/rec2.json']);
  });

  it('rejects paths outside any known DataFolder', async () => {
    const { service, commitCalls } = buildService({
      patches: [{ path: 'Strangers/rec1.json', patch: { a: 1 } }],
    });

    await expect(service.applyAndPublish(defaultArgs())).rejects.toThrow(/DataFolder/);
    expect(commitCalls).toHaveLength(0);
  });

  it('enqueues a plan pipeline job when patches produce diffs', async () => {
    const { service, planJobCalls, setActiveCalls } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme' } }],
    });

    const result = await service.applyAndPublish(defaultArgs());

    expect(planJobCalls).toHaveLength(1);
    expect(planJobCalls[0].runAfterPlan).toBe(true);
    expect(setActiveCalls).toHaveLength(1);
    expect(result.pipelineId).toBe('pipe_1');
    expect(result.publishJobId).toBe('job_1');
  });

  it('skips publish when no diff vs main results from the patches', async () => {
    const { service, planJobCalls } = buildService(
      { patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme' } }] },
      { hasDiffs: false },
    );

    const result = await service.applyAndPublish(defaultArgs());

    expect(planJobCalls).toHaveLength(0);
    expect(result.pipelineId).toBeNull();
    expect(result.publishJobId).toBeNull();
  });

  it('emits progress callbacks before and after dispatch', async () => {
    const { service } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme' } }],
    });

    const progressEvents: Array<{ processedCount: number; pipelineId?: string }> = [];
    await service.applyAndPublish({
      ...defaultArgs(),
      onProgress: (p) => {
        progressEvents.push({ processedCount: p.processedCount, pipelineId: p.pipelineId });
        return Promise.resolve();
      },
    });

    expect(progressEvents[0]).toEqual({ processedCount: 0, pipelineId: undefined });
    expect(progressEvents[progressEvents.length - 1].pipelineId).toBe('pipe_1');
  });
});
