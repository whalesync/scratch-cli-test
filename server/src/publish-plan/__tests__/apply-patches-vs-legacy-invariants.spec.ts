/**
 * ApplyPatchesService invariants — measured against a hand-modeled baseline
 * of what the legacy `run-from-git` path would have produced for the same
 * user intent.
 *
 * ⚠ Honest scope note. This is NOT a true parity test. Plan T6's wording —
 * "same dispatched operations + same final main SHA" — is an integration-
 * level assertion that requires actually running both code paths against a
 * real DB + scratch-git + connector. That coverage belongs to the e2e smoke
 * (`upload-patch.e2e.spec.ts`).
 *
 * What THIS file does: for each scenario (single-field edit, multi-field
 * edit, key delete, record create, record delete, mixed batch), it computes
 * the dirty-branch state two ways:
 *   - Hand-simulation of the legacy contract (the CLI commits final intended
 *     content to dirty; server reads phase files and acts).
 *   - A real run of ApplyPatchesService against in-memory mocks of
 *     ScratchGitService + ObjectStorageService.
 * It asserts the two end states agree.
 *
 * What this catches: regressions in the RFC 7396 merge patch math and the
 * service's commit/delete dispatch — i.e. that the new path produces
 * dirty-branch state semantically equivalent to the legacy path for
 * already-known scenarios.
 *
 * What this does NOT catch: divergence in actual connector dispatch (that's
 * downstream of dirty in publish-v2 plan-run), or any mismatch between the
 * hand-simulated baseline and what the legacy CLI plan-builder actually
 * produces. If my mental model of the legacy path is wrong, this test
 * passes anyway.
 *
 * The plan deletes this file in Phase 7 alongside `run-from-git`. The
 * e2e smoke survives as the regression backstop.
 */
import { UploadPatchPayload, WorkbookId } from '@spinner/shared-types';
import { Readable } from 'stream';
import { ApplyPatchesService } from '../apply-patches.service';

interface DirtyFile {
  path: string;
  content: Record<string, unknown>;
}

describe('ApplyPatchesService invariants vs hand-modeled legacy baseline', () => {
  const workbookId = 'wkb_parity' as WorkbookId;
  const connectorAccountId = 'ca_parity';
  const userId = 'usr_parity';
  const organizationId = 'org_parity';

  /**
   * Simulate Path A's effect on dirty: the CLI commits the final intended file
   * content for each edited record (post-dispatch refresh is treated as
   * identity for this test — both paths share the same connector-refresh code
   * downstream in publish-v2 plan-run).
   */
  function simulatePathA(baseline: DirtyFile[], edits: DirtyFile[], deletes: string[]): Map<string, string> {
    const dirty = new Map<string, string>();
    for (const f of baseline) dirty.set(f.path, JSON.stringify(f.content));
    for (const f of edits) dirty.set(f.path, JSON.stringify(f.content));
    for (const p of deletes) dirty.delete(p);
    return dirty;
  }

  /** Run Path B against the same baseline; collect the dirty state. */
  async function simulatePathB(baseline: DirtyFile[], payload: UploadPatchPayload): Promise<Map<string, string>> {
    const dirty = new Map<string, string>();
    for (const f of baseline) dirty.set(f.path, JSON.stringify(f.content));

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
        Promise.resolve(dirty.has(path) ? { content: dirty.get(path) as string } : null),
      ),
      commitFilesToBranch: jest.fn((_repo: string, _branch: string, files: { path: string; content: string }[]) => {
        for (const f of files) dirty.set(f.path, f.content);
        return Promise.resolve();
      }),
      deleteFilesFromBranch: jest.fn((_repo: string, _branch: string, paths: string[]) => {
        for (const p of paths) dirty.delete(p);
        return Promise.resolve();
      }),
    };
    const objectStorageService = {
      streamObjectFromPatchUpload: jest.fn(() => Readable.from([Buffer.from(JSON.stringify(payload))])),
    };
    const publishPlanBuildService = {
      hasDiffs: jest.fn().mockResolvedValue(true),
      createPipeline: jest.fn().mockResolvedValue({ pipelineId: 'pipe', branchName: 'b' }),
      setActiveJob: jest.fn().mockResolvedValue(undefined),
    };
    const bullEnqueuerService = {
      enqueuePlanPipelineJob: jest.fn().mockResolvedValue({ id: 'job' }),
    };

    const service = new ApplyPatchesService(
      db as never,
      scratchGitService as never,
      objectStorageService as never,
      publishPlanBuildService as never,
      bullEnqueuerService as never,
    );

    await service.applyAndPublish({
      workbookId,
      userId,
      organizationId,
      connectorAccountId,
      uploadId: 'up_parity',
    });

    return dirty;
  }

  function compareDirtyStates(a: Map<string, string>, b: Map<string, string>) {
    const keysA = new Set(a.keys());
    const keysB = new Set(b.keys());
    expect([...keysA].sort()).toEqual([...keysB].sort());
    for (const k of keysA) {
      expect(JSON.parse(b.get(k) ?? '')).toEqual(JSON.parse(a.get(k) ?? ''));
    }
  }

  it('produces the same dirty state for a single-field edit', async () => {
    const baseline: DirtyFile[] = [{ path: 'Companies/rec1.json', content: { id: 'rec1', name: 'Old', website: 'x' } }];
    const editedContent = { id: 'rec1', name: 'New', website: 'x' };

    const pathA = simulatePathA(baseline, [{ path: 'Companies/rec1.json', content: editedContent }], []);
    const pathB = await simulatePathB(baseline, {
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'New' } }],
    });

    compareDirtyStates(pathA, pathB);
  });

  it('produces the same dirty state for a multi-field edit', async () => {
    const baseline: DirtyFile[] = [
      { path: 'Companies/rec1.json', content: { id: 'rec1', name: 'Old', industry: 'Tech' } },
    ];
    const editedContent = { id: 'rec1', name: 'Acme', industry: 'Bio' };

    const pathA = simulatePathA(baseline, [{ path: 'Companies/rec1.json', content: editedContent }], []);
    const pathB = await simulatePathB(baseline, {
      patches: [{ path: 'Companies/rec1.json', patch: { name: 'Acme', industry: 'Bio' } }],
    });

    compareDirtyStates(pathA, pathB);
  });

  it('produces the same dirty state for a key deletion', async () => {
    const baseline: DirtyFile[] = [
      { path: 'Companies/rec1.json', content: { id: 'rec1', name: 'Acme', website: 'old' } },
    ];
    const editedContent = { id: 'rec1', name: 'Acme' };

    const pathA = simulatePathA(baseline, [{ path: 'Companies/rec1.json', content: editedContent }], []);
    const pathB = await simulatePathB(baseline, {
      patches: [{ path: 'Companies/rec1.json', patch: { website: null } }],
    });

    compareDirtyStates(pathA, pathB);
  });

  it('produces the same dirty state for a record creation', async () => {
    const baseline: DirtyFile[] = [];
    const created = { id: 'rec_new', name: 'Hello' };

    const pathA = simulatePathA(baseline, [{ path: 'Posts/rec_new.json', content: created }], []);
    const pathB = await simulatePathB(baseline, {
      patches: [{ path: 'Posts/rec_new.json', patch: created }],
    });

    compareDirtyStates(pathA, pathB);
  });

  it('produces the same dirty state for a record deletion', async () => {
    const baseline: DirtyFile[] = [
      { path: 'Companies/rec1.json', content: { id: 'rec1', name: 'Acme' } },
      { path: 'Companies/rec2.json', content: { id: 'rec2', name: 'Beta' } },
    ];

    const pathA = simulatePathA(baseline, [], ['Companies/rec1.json']);
    const pathB = await simulatePathB(baseline, {
      patches: [{ path: 'Companies/rec1.json', patch: null }],
    });

    compareDirtyStates(pathA, pathB);
  });

  it('produces the same dirty state for a mixed edit + create + delete batch', async () => {
    const baseline: DirtyFile[] = [
      { path: 'Companies/rec1.json', content: { id: 'rec1', name: 'Old' } },
      { path: 'Companies/rec2.json', content: { id: 'rec2', name: 'Beta' } },
    ];
    const pathA = simulatePathA(
      baseline,
      [
        { path: 'Companies/rec1.json', content: { id: 'rec1', name: 'New' } },
        { path: 'Posts/rec_new.json', content: { id: 'rec_new', title: 'Hi' } },
      ],
      ['Companies/rec2.json'],
    );
    const pathB = await simulatePathB(baseline, {
      patches: [
        { path: 'Companies/rec1.json', patch: { name: 'New' } },
        { path: 'Posts/rec_new.json', patch: { id: 'rec_new', title: 'Hi' } },
        { path: 'Companies/rec2.json', patch: null },
      ],
    });

    compareDirtyStates(pathA, pathB);
  });
});
