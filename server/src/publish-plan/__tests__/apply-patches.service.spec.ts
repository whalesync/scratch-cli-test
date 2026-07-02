import { UploadPatchPayload, WorkbookId } from '@spinner/shared-types';
import { Readable } from 'stream';
import { applyJsonMergePatch, ApplyPatchesService, applyUpdatePatch } from '../apply-patches.service';

describe('applyUpdatePatch (dual-read dialect dispatch)', () => {
  it('routes a 6902 op array through the JSON Patch applier', () => {
    expect(applyUpdatePatch({ a: 1 }, [{ op: 'add', path: '/a', value: null }])).toEqual({ a: null });
  });

  it('routes a 7396 merge-patch object through the merge applier (live mixed-fleet case)', () => {
    // A pre-cutover client still uploads object bodies; the server must keep
    // applying them as merge patches (null deletes, per RFC 7396) by shape.
    expect(applyUpdatePatch({ a: 1, b: 2 }, { a: 9, b: null })).toEqual({ a: 9 });
  });
});

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

describe('ApplyPatchesService.applyPatches', () => {
  const workbookId = 'wkb_test' as WorkbookId;
  const connectorAccountId = 'ca_test';
  const uploadId = 'up_test';

  function buildService(payload: UploadPatchPayload, opts?: { existingContent?: Record<string, string> }) {
    const existingContent = opts?.existingContent ?? {};

    const commitCalls: Array<{ branch: string; files: { path: string; content: string }[]; message: string }> = [];
    const deleteCalls: Array<{ branch: string; paths: string[]; message: string }> = [];

    const db = {
      client: {
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([{ path: '/Companies' }, { path: '/Posts' }]),
        },
        // applyPatches upserts per-path UploadPatchMeta to carry the upload
        // DTO's `revert` flag to plan-build time. Stub accepts any args; the
        // tests in this file don't assert on the persisted metadata.
        uploadPatchMeta: {
          upsert: jest.fn().mockResolvedValue(undefined),
        },
      },
    };

    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org/wkb/ca'),
      // DEV-10630 (non-accumulation): applyPatches force-resets dirty to main
      // before applying, so a publish ships exactly this upload and nothing else
      // that lingered on dirty.
      resetDirtyToMain: jest.fn().mockResolvedValue(undefined),
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
      // DEV-10316: applyPatches snapshots the post-apply dirty HEAD to return as
      // the publish-time TOCTOU token.
      getBranchHead: jest.fn().mockResolvedValue('postapply_head_sha'),
    };

    const objectStorageService = {
      streamObjectFromPatchUpload: jest.fn(() => Readable.from([Buffer.from(JSON.stringify(payload))])),
    };

    const service = new ApplyPatchesService(db as never, scratchGitService as never, objectStorageService as never);

    return {
      service,
      commitCalls,
      deleteCalls,
      mocks: { db, scratchGitService, objectStorageService },
    };
  }

  function defaultArgs(uploadIdOverride?: string) {
    return {
      workbookId,
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

    const result = await service.applyPatches(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0].branch).toBe('dirty');
    expect(commitCalls[0].files).toHaveLength(1);
    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    expect(content).toEqual({ id: 'rec1', name: 'New Name', industry: 'Tech' });
    expect(result.patchCount).toBe(1);
  });

  it('force-resets dirty to main before reading the base or writing (publish verbatim, DEV-10630)', async () => {
    const { service, mocks } = buildService(
      { patches: [{ path: 'Companies/rec1.json', patch: { name: 'New Name' } }] },
      { existingContent: { 'Companies/rec1.json': JSON.stringify({ id: 'rec1', name: 'Old Name' }) } },
    );

    await service.applyPatches(defaultArgs());

    const { resetDirtyToMain, getRepoFile, commitFilesToBranch } = mocks.scratchGitService;
    expect(resetDirtyToMain).toHaveBeenCalledWith('org/wkb/ca');
    // The reset must precede the base read AND the write: dirty is rebuilt from
    // main so the publish plan reflects exactly this upload, never an edit that
    // was staged on dirty earlier and since discarded locally.
    expect(resetDirtyToMain.mock.invocationCallOrder[0]).toBeLessThan(getRepoFile.mock.invocationCallOrder[0]);
    expect(resetDirtyToMain.mock.invocationCallOrder[0]).toBeLessThan(commitFilesToBranch.mock.invocationCallOrder[0]);
  });

  it('resets dirty to main even on a delete-only upload (DEV-10630)', async () => {
    const { service, mocks, deleteCalls } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: null }],
    });

    await service.applyPatches(defaultArgs());

    const { resetDirtyToMain, deleteFilesFromBranch } = mocks.scratchGitService;
    expect(resetDirtyToMain).toHaveBeenCalledWith('org/wkb/ca');
    expect(deleteCalls).toHaveLength(1);
    expect(resetDirtyToMain.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFilesFromBranch.mock.invocationCallOrder[0],
    );
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

    await service.applyPatches(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    expect(JSON.parse(commitCalls[0].files[0].content)).toEqual({ id: 'rec_new', title: 'Hello' });
  });

  it('routes patch=null to deleteFilesFromBranch and skips the commit', async () => {
    const { service, commitCalls, deleteCalls } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: null }],
    });

    await service.applyPatches(defaultArgs());

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

    await service.applyPatches(defaultArgs());

    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    expect(content).toEqual({ id: 'rec1', name: 'Acme' });
  });

  it('applies a 6902 op-array Update onto existing content (dual-read by shape)', async () => {
    const { service, commitCalls } = buildService(
      {
        version: 2,
        patches: [
          {
            path: 'Companies/rec1.json',
            kind: 'update',
            patch: [{ op: 'add', path: '/name', value: 'New Name' }],
          },
        ],
      },
      {
        existingContent: {
          'Companies/rec1.json': JSON.stringify({ id: 'rec1', name: 'Old Name', industry: 'Tech' }),
        },
      },
    );

    await service.applyPatches(defaultArgs());

    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    expect(content).toEqual({ id: 'rec1', name: 'New Name', industry: 'Tech' });
  });

  it('sets a field to null via a 6902 add (DEV-10237 — not a delete)', async () => {
    const { service, commitCalls } = buildService(
      {
        version: 2,
        patches: [
          {
            path: 'Companies/rec1.json',
            kind: 'update',
            patch: [{ op: 'add', path: '/website', value: null }],
          },
        ],
      },
      {
        existingContent: {
          'Companies/rec1.json': JSON.stringify({ id: 'rec1', website: 'old.example' }),
        },
      },
    );

    await service.applyPatches(defaultArgs());

    const content = JSON.parse(commitCalls[0].files[0].content) as Record<string, unknown>;
    // The key is present with an explicit null — under RFC 7396 the merge patch
    // could only have deleted it.
    expect(content).toEqual({ id: 'rec1', website: null });
    expect('website' in content).toBe(true);
  });

  it('routes an explicit kind:"delete" to deleteFilesFromBranch', async () => {
    const { service, commitCalls, deleteCalls } = buildService({
      version: 2,
      patches: [{ path: 'Companies/rec1.json', kind: 'delete', patch: null }],
    });

    await service.applyPatches(defaultArgs());

    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls[0].paths).toEqual(['Companies/rec1.json']);
  });

  it('rejects path traversal before writing anything', async () => {
    const { service, commitCalls, deleteCalls } = buildService({
      patches: [{ path: '../etc/passwd', patch: { evil: true } }],
    });

    await expect(service.applyPatches(defaultArgs())).rejects.toThrow(/traversal/i);
    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('rejects the WHOLE batch when any path is invalid (all-or-nothing)', async () => {
    // Two valid patches followed by one traversal patch — even though the
    // first two would have succeeded, none should be applied. Locks in the
    // pre-write validation invariant.
    const { service, commitCalls, deleteCalls } = buildService({
      patches: [
        { path: 'Companies/rec1.json', patch: { name: 'Acme' } },
        { path: 'Posts/rec_new.json', patch: { id: 'rec_new', title: 'Hello' } },
        { path: '../etc/passwd', patch: { evil: true } },
      ],
    });

    await expect(service.applyPatches(defaultArgs())).rejects.toThrow(/traversal/i);
    expect(commitCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
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

    await service.applyPatches(defaultArgs());

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

    await expect(service.applyPatches(defaultArgs())).rejects.toThrow(/DataFolder/);
    expect(commitCalls).toHaveLength(0);
  });

  it('does NOT enqueue a publish pipeline — callers drive plan-job / run-job separately', async () => {
    // Decoupled in the design after CLI review: /upload-patch/commit is a
    // patch-to-dirty endpoint, no implicit publish. The publish-plan service
    // and bull enqueuer are not even constructor dependencies anymore — this
    // test guards against silent re-coupling by asserting the writes happen
    // (so the patch was applied) without touching publish at all.
    const { service, commitCalls } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme' } }],
    });

    const result = await service.applyPatches(defaultArgs());

    expect(commitCalls).toHaveLength(1);
    // DEV-10316: result now also carries the post-apply dirty HEAD snapshot.
    expect(result).toEqual({ patchCount: 1, postApplyDirtyHead: 'postapply_head_sha' });
  });

  it('emits progress callbacks before and after the patches are applied', async () => {
    const { service } = buildService({
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme' } }],
    });

    const progressEvents: Array<{ processedCount: number; patchCount: number }> = [];
    await service.applyPatches({
      ...defaultArgs(),
      onProgress: (p) => {
        progressEvents.push({ processedCount: p.processedCount, patchCount: p.patchCount });
        return Promise.resolve();
      },
    });

    expect(progressEvents[0]).toEqual({ processedCount: 0, patchCount: 1 });
    expect(progressEvents[progressEvents.length - 1]).toEqual({ processedCount: 1, patchCount: 1 });
  });
});
