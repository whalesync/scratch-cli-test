import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { ScratchGitNotFoundError } from '../../scratch-git/scratch-git.client';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { PublishPlanDiffService } from '../publish-plan-diff.service';

/**
 * Coverage for the publish-diff read endpoints (DEV-11427): the list of files
 * that differ between two anchors of a publish, and the content of one file at
 * those anchors. Both are pure reads over the PublishPlan row's three recorded
 * SHAs and the git service's commit compare / file-at-commit reads, so
 * everything below is mocked at that boundary.
 */
describe('PublishPlanDiffService', () => {
  const PRE_MAIN_SHA = 'a'.repeat(40);
  const PRE_DIRTY_SHA = 'd'.repeat(40);
  const POST_MAIN_SHA = 'b'.repeat(40);

  let publishPlanFindFirst: jest.Mock;
  let compareCommits: jest.Mock;
  let getRepoFile: jest.Mock;
  let getBranchHead: jest.Mock;
  let service: PublishPlanDiffService;

  const completedPlanRow = {
    id: 'plan1',
    status: 'completed',
    connectorAccountId: 'ca1',
    preMainCommitSha: PRE_MAIN_SHA,
    preDirtyCommitSha: PRE_DIRTY_SHA,
    postMainCommitSha: POST_MAIN_SHA,
  };

  beforeEach(() => {
    publishPlanFindFirst = jest.fn().mockResolvedValue(completedPlanRow);
    compareCommits = jest.fn().mockResolvedValue([
      { path: 'Companies/rec_new.json', status: 'added' },
      { path: 'Companies/rec_edit.json', status: 'modified' },
      { path: 'Contacts/rec_gone.json', status: 'deleted' },
      { path: 'Companies/rec_also_edit.json', status: 'modified' },
    ]);
    getRepoFile = jest.fn();
    getBranchHead = jest.fn().mockResolvedValue(null);

    const db = { client: { publishPlan: { findFirst: publishPlanFindFirst } } } as unknown as DbService;
    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org_1/wkb_1/coa_1'),
      compareCommits,
      getRepoFile,
      getBranchHead,
    } as unknown as ScratchGitService;
    service = new PublishPlanDiffService(db, scratchGitService);
  });

  describe('listChangedFilesForPublishPlan', () => {
    it('defaults to pre-main → post-main and returns workbook paths sorted by path', async () => {
      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1');

      expect(publishPlanFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'plan1', workbookId: 'wb1' } }),
      );
      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_MAIN_SHA, POST_MAIN_SHA);
      expect(result).toEqual({
        planId: 'plan1',
        connectorAccountId: 'ca1',
        from: 'pre-main',
        to: 'post-main',
        baseCommitSha: PRE_MAIN_SHA,
        headCommitSha: POST_MAIN_SHA,
        data: [
          { path: '/Companies/rec_also_edit.json', status: 'modified' },
          { path: '/Companies/rec_edit.json', status: 'modified' },
          { path: '/Companies/rec_new.json', status: 'added' },
          { path: '/Contacts/rec_gone.json', status: 'deleted' },
        ],
        total: 4,
        page: 1,
        pageSize: 100,
        counts: { added: 1, modified: 2, deleted: 1 },
      });
    });

    it('compares pre-main → pre-dirty (what was staged) when asked', async () => {
      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', {
        from: 'pre-main',
        to: 'pre-dirty',
      });

      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_MAIN_SHA, PRE_DIRTY_SHA);
      expect(result).toMatchObject({
        from: 'pre-main',
        to: 'pre-dirty',
        baseCommitSha: PRE_MAIN_SHA,
        headCommitSha: PRE_DIRTY_SHA,
      });
    });

    it('compares pre-dirty → post-main (what the connector changed) when asked', async () => {
      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', {
        from: 'pre-dirty',
        to: 'post-main',
      });

      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_DIRTY_SHA, POST_MAIN_SHA);
      expect(result).toMatchObject({
        from: 'pre-dirty',
        to: 'post-main',
        baseCommitSha: PRE_DIRTY_SHA,
        headCommitSha: POST_MAIN_SHA,
      });
    });

    it('rejects an unknown anchor, identical anchors, and an unknown status filter', async () => {
      await expect(service.listChangedFilesForPublishPlan('wb1', 'plan1', { from: 'main' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.listChangedFilesForPublishPlan('wb1', 'plan1', { from: 'post-main', to: 'post-main' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.listChangedFilesForPublishPlan('wb1', 'plan1', { status: 'changed' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(compareCommits).not.toHaveBeenCalled();
    });

    it('filters by folder and status while keeping whole-comparison counts, and paginates the filtered list', async () => {
      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', {
        folderPath: '/Companies',
        status: 'modified',
        page: 2,
        pageSize: 1,
      });

      expect(result.data).toEqual([{ path: '/Companies/rec_edit.json', status: 'modified' }]);
      expect(result).toMatchObject({ total: 2, page: 2, pageSize: 1, counts: { added: 1, modified: 2, deleted: 1 } });
    });

    it('caps the page size at 1000', async () => {
      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', { pageSize: 5000 });
      expect(result.pageSize).toBe(1000);
    });

    it('falls back to the main_pre_plan / dirty_plan / main_plan tags when the row has no SHAs recorded', async () => {
      publishPlanFindFirst.mockResolvedValue({
        ...completedPlanRow,
        preMainCommitSha: null,
        preDirtyCommitSha: null,
        postMainCommitSha: null,
      });
      const tagShas: Record<string, string> = {
        main_pre_plan_plan1: PRE_MAIN_SHA,
        dirty_plan_plan1: PRE_DIRTY_SHA,
        main_plan_plan1: POST_MAIN_SHA,
      };
      getBranchHead.mockImplementation((_repoId: string, ref: string) => Promise.resolve(tagShas[ref] ?? null));

      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', {
        from: 'pre-dirty',
        to: 'post-main',
      });

      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_DIRTY_SHA, POST_MAIN_SHA);
      expect(result).toMatchObject({ baseCommitSha: PRE_DIRTY_SHA, headCommitSha: POST_MAIN_SHA });
    });

    it('compares against the empty tree when no pre-main commit exists at all', async () => {
      publishPlanFindFirst.mockResolvedValue({ ...completedPlanRow, preMainCommitSha: null });

      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1');

      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', null, POST_MAIN_SHA);
      expect(result.baseCommitSha).toBeNull();
    });

    it('rejects a missing pre-dirty commit rather than treating it as the empty tree', async () => {
      publishPlanFindFirst.mockResolvedValue({ ...completedPlanRow, preDirtyCommitSha: null });

      await expect(
        service.listChangedFilesForPublishPlan('wb1', 'plan1', { from: 'pre-dirty', to: 'post-main' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(compareCommits).not.toHaveBeenCalled();
    });

    it('rejects post-main on a plan that has not completed a run yet', async () => {
      publishPlanFindFirst.mockResolvedValue({ ...completedPlanRow, status: 'planned', postMainCommitSha: null });

      await expect(service.listChangedFilesForPublishPlan('wb1', 'plan1')).rejects.toBeInstanceOf(BadRequestException);
      expect(compareCommits).not.toHaveBeenCalled();
    });

    it('still serves pre-main → pre-dirty on a plan that has not completed a run yet', async () => {
      publishPlanFindFirst.mockResolvedValue({ ...completedPlanRow, status: 'edits-running', postMainCommitSha: null });

      const result = await service.listChangedFilesForPublishPlan('wb1', 'plan1', { to: 'pre-dirty' });

      expect(compareCommits).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_MAIN_SHA, PRE_DIRTY_SHA);
      expect(result).toMatchObject({ from: 'pre-main', to: 'pre-dirty' });
    });

    it('404s when the plan does not belong to the workbook', async () => {
      publishPlanFindFirst.mockResolvedValue(null);
      await expect(service.listChangedFilesForPublishPlan('wb-other', 'plan1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('maps a missing commit in the repo to a 404 instead of a 500', async () => {
      compareCommits.mockRejectedValue(new ScratchGitNotFoundError('/compare', 'Commit not found'));
      await expect(service.listChangedFilesForPublishPlan('wb1', 'plan1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getFileDiffForPublishPlan', () => {
    it('reads the file at both default anchors and returns a sparse field-level diff for a modified record', async () => {
      const before = JSON.stringify({ id: 'rec_1', name: 'Acme', address: { city: 'Oslo', zip: '0150' }, tags: ['a'] });
      const after = JSON.stringify({
        id: 'rec_1',
        name: 'Acme Inc',
        address: { city: 'Oslo', zip: '0151' },
        tags: ['a'],
      });
      getRepoFile.mockImplementation((_repoId: string, sha: string) =>
        Promise.resolve({ content: sha === PRE_MAIN_SHA ? before : after }),
      );

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/rec_1.json');

      expect(getRepoFile).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_MAIN_SHA, 'Companies/rec_1.json');
      expect(getRepoFile).toHaveBeenCalledWith('org_1/wkb_1/coa_1', POST_MAIN_SHA, 'Companies/rec_1.json');
      expect(result).toEqual({
        planId: 'plan1',
        path: '/Companies/rec_1.json',
        from: 'pre-main',
        to: 'post-main',
        status: 'modified',
        baseCommitSha: PRE_MAIN_SHA,
        headCommitSha: POST_MAIN_SHA,
        before,
        after,
        changedFields: { name: 'Acme Inc', address: { zip: '0151' } },
      });
    });

    it('diffs pre-dirty → post-main to show what the connector changed relative to what was sent', async () => {
      const staged = JSON.stringify({ id: 'rec_1', amount: '-99.5' });
      const landed = JSON.stringify({ id: 'rec_1', amount: '-99.500000', updatedAt: '2026-09-01T22:49:51.485Z' });
      getRepoFile.mockImplementation((_repoId: string, sha: string) =>
        Promise.resolve({ content: sha === PRE_DIRTY_SHA ? staged : landed }),
      );

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/rec_1.json', {
        from: 'pre-dirty',
        to: 'post-main',
      });

      expect(getRepoFile).toHaveBeenCalledWith('org_1/wkb_1/coa_1', PRE_DIRTY_SHA, 'Companies/rec_1.json');
      expect(getRepoFile).toHaveBeenCalledWith('org_1/wkb_1/coa_1', POST_MAIN_SHA, 'Companies/rec_1.json');
      expect(result).toMatchObject({
        from: 'pre-dirty',
        to: 'post-main',
        status: 'modified',
        baseCommitSha: PRE_DIRTY_SHA,
        headCommitSha: POST_MAIN_SHA,
        changedFields: { amount: '-99.500000', updatedAt: '2026-09-01T22:49:51.485Z' },
      });
    });

    it('rejects an unknown anchor before touching git', async () => {
      await expect(
        service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/rec_1.json', { to: 'dirty' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(getRepoFile).not.toHaveBeenCalled();
    });

    it('reports a created record as added with no field diff', async () => {
      getRepoFile.mockImplementation((_repoId: string, sha: string) =>
        Promise.resolve(sha === POST_MAIN_SHA ? { content: '{"id":"rec_new"}' } : null),
      );

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', 'Companies/rec_new.json');

      expect(result).toMatchObject({
        path: '/Companies/rec_new.json',
        status: 'added',
        before: null,
        after: '{"id":"rec_new"}',
        changedFields: null,
      });
    });

    it('reports a removed record as deleted', async () => {
      getRepoFile.mockImplementation((_repoId: string, sha: string) =>
        Promise.resolve(sha === PRE_MAIN_SHA ? { content: '{"id":"rec_gone"}' } : null),
      );

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', '/Contacts/rec_gone.json');

      expect(result).toMatchObject({
        status: 'deleted',
        before: '{"id":"rec_gone"}',
        after: null,
        changedFields: null,
      });
    });

    it('reports identical content as unchanged with an empty field diff', async () => {
      getRepoFile.mockResolvedValue({ content: '{"id":"rec_same"}' });

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/rec_same.json');

      expect(result).toMatchObject({ status: 'unchanged', changedFields: {} });
    });

    it('skips the pre-main read when there is no base commit', async () => {
      publishPlanFindFirst.mockResolvedValue({ ...completedPlanRow, preMainCommitSha: null });
      getRepoFile.mockResolvedValue({ content: '{}' });

      const result = await service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/rec_1.json');

      expect(getRepoFile).toHaveBeenCalledTimes(1);
      expect(getRepoFile).toHaveBeenCalledWith('org_1/wkb_1/coa_1', POST_MAIN_SHA, 'Companies/rec_1.json');
      expect(result).toMatchObject({ status: 'added', baseCommitSha: null });
    });

    it('404s when the file exists at neither anchor', async () => {
      getRepoFile.mockResolvedValue(null);
      await expect(service.getFileDiffForPublishPlan('wb1', 'plan1', '/Companies/nope.json')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('400s when no path is given', async () => {
      await expect(service.getFileDiffForPublishPlan('wb1', 'plan1', '')).rejects.toBeInstanceOf(BadRequestException);
      expect(getRepoFile).not.toHaveBeenCalled();
    });
  });
});
