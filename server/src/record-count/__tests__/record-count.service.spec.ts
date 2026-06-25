import type { PrismaClient } from '@prisma/client';
import type { DataFolderId, WorkbookEvent, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { RecordCountService, recomputeRecordCountsForWorkbook } from '../record-count.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;

type FolderRow = { id: string; path: string | null; connectorAccountId: string | null; recordCount: number };

// Reduce the prisma `dataFolder.update` mock calls to { folderId: newRecordCount }.
function recordCountUpdatesById(update: jest.Mock): Record<string, number> {
  const result: Record<string, number> = {};
  const calls = update.mock.calls as Array<[{ where: { id: string }; data: { recordCount: number } }]>;
  for (const [arg] of calls) {
    result[arg.where.id] = arg.data.recordCount;
  }
  return result;
}

function makeDeps(params: { folders: FolderRow[]; countsByRepo: Record<string, Map<string, number> | 'not-found'> }) {
  const update = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue(params.folders);
  const prisma = { dataFolder: { findMany, update } } as unknown as PrismaClient;

  // Each connector account maps to a repo id of the same name for the test.
  const resolveConnectionRepoPath = jest.fn((connectorAccountId: string) =>
    Promise.resolve(`repo-${connectorAccountId}`),
  );
  // Folder-aware resolver (DEV-10424): connector folders → repo-<ca>, scratch (null) → scratch-<wb>.
  const resolveRepoPathForFolder = jest.fn((connectorAccountId: string | null, workbookId: string) =>
    Promise.resolve(connectorAccountId ? `repo-${connectorAccountId}` : `scratch-${workbookId}`),
  );
  const countRecordFilesByFolder = jest.fn((repoId: string) => {
    const entry = params.countsByRepo[repoId];
    if (entry === undefined || entry === 'not-found') {
      return Promise.reject(new ScratchGitNotFoundError(`/count-by-folder/${repoId}`, 'repo not found'));
    }
    return Promise.resolve(entry);
  });
  const scratchGit = {
    resolveConnectionRepoPath,
    resolveRepoPathForFolder,
    countRecordFilesByFolder,
  } as unknown as ScratchGitService;

  const sendWorkbookEvent = jest.fn();
  const events = { sendWorkbookEvent } as unknown as WorkbookEventService;

  return { prisma, scratchGit, events, update, findMany, sendWorkbookEvent, resolveConnectionRepoPath };
}

describe('recomputeRecordCountsForWorkbook', () => {
  it('updates only folders whose count changed and emits one event', async () => {
    const deps = makeDeps({
      folders: [
        { id: 'f1', path: '/A', connectorAccountId: 'ca1', recordCount: 2 }, // unchanged
        { id: 'f2', path: '/A/B', connectorAccountId: 'ca1', recordCount: 0 }, // 0 -> 3
      ],
      countsByRepo: {
        'repo-ca1': new Map([
          ['A', 2],
          ['A/B', 3],
        ]),
      },
    });

    const result = await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(recordCountUpdatesById(deps.update)).toEqual({ f2: 3 });
    expect(result.changedFolderIds).toEqual(['f2']);
    expect(deps.sendWorkbookEvent).toHaveBeenCalledTimes(1);
    const [eventWorkbookId, event] = deps.sendWorkbookEvent.mock.calls[0] as [WorkbookId, WorkbookEvent];
    expect(eventWorkbookId).toBe(WORKBOOK_ID);
    expect(event.type).toBe('folder-updated');
    expect(event.data.source).toBe('job');
    expect(event.data.changedFolderIds).toEqual(['f2']);
  });

  it('is idempotent: a second run with unchanged git makes no updates and emits nothing', async () => {
    const deps = makeDeps({
      folders: [{ id: 'f1', path: '/A', connectorAccountId: 'ca1', recordCount: 5 }],
      countsByRepo: { 'repo-ca1': new Map([['A', 5]]) },
    });

    const result = await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.sendWorkbookEvent).not.toHaveBeenCalled();
    expect(result.changedFolderIds).toEqual([]);
  });

  it('maps the leading slash off DataFolder.path and treats root "/" as ""', async () => {
    const deps = makeDeps({
      folders: [
        { id: 'fRoot', path: '/', connectorAccountId: 'ca1', recordCount: 0 }, // "" -> 5
        { id: 'fNested', path: '/Deep/Folder', connectorAccountId: 'ca1', recordCount: 0 }, // -> 7
      ],
      countsByRepo: {
        'repo-ca1': new Map([
          ['', 5],
          ['Deep/Folder', 7],
        ]),
      },
    });

    await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(recordCountUpdatesById(deps.update)).toEqual({ fRoot: 5, fNested: 7 });
  });

  it('treats a folder absent from the git count map as 0', async () => {
    const deps = makeDeps({
      folders: [{ id: 'fEmpty', path: '/Empty', connectorAccountId: 'ca1', recordCount: 4 }], // 4 -> 0
      countsByRepo: { 'repo-ca1': new Map() },
    });

    await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(recordCountUpdatesById(deps.update)).toEqual({ fEmpty: 0 });
  });

  it('tolerates a missing repo: its folders go to 0 and other repos still process', async () => {
    const deps = makeDeps({
      folders: [
        { id: 'fOk', path: '/A', connectorAccountId: 'ca1', recordCount: 0 }, // -> 2
        { id: 'fMissing', path: '/B', connectorAccountId: 'ca2', recordCount: 9 }, // repo missing -> 0
      ],
      countsByRepo: {
        'repo-ca1': new Map([['A', 2]]),
        'repo-ca2': 'not-found',
      },
    });

    const result = await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(recordCountUpdatesById(deps.update)).toEqual({ fOk: 2, fMissing: 0 });
    expect(result.changedFolderIds.sort()).toEqual(['fMissing', 'fOk']);
  });

  it('counts folders with no connector account or null path as 0 without a repo lookup', async () => {
    const deps = makeDeps({
      folders: [
        { id: 'fNoAccount', path: '/X', connectorAccountId: null, recordCount: 3 }, // -> 0
        { id: 'fNullPath', path: null, connectorAccountId: 'ca1', recordCount: 1 }, // -> 0
      ],
      countsByRepo: { 'repo-ca1': new Map([['X', 99]]) },
    });

    await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID);

    expect(recordCountUpdatesById(deps.update)).toEqual({ fNoAccount: 0, fNullPath: 0 });
    // The null-connector-account folder must not trigger a repo resolution — only ca1 (for
    // fNullPath, which has a connector account but a null path) is resolved.
    expect(deps.resolveConnectionRepoPath).toHaveBeenCalledTimes(1);
    expect(deps.resolveConnectionRepoPath).toHaveBeenCalledWith('ca1');
  });

  it('suppresses the event when emitEvent is false', async () => {
    const deps = makeDeps({
      folders: [{ id: 'f1', path: '/A', connectorAccountId: 'ca1', recordCount: 0 }],
      countsByRepo: { 'repo-ca1': new Map([['A', 2]]) },
    });

    await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID, { emitEvent: false });

    expect(recordCountUpdatesById(deps.update)).toEqual({ f1: 2 });
    expect(deps.sendWorkbookEvent).not.toHaveBeenCalled();
  });

  it('scopes the folder query to a connector account when given', async () => {
    const deps = makeDeps({
      folders: [{ id: 'f1', path: '/A', connectorAccountId: 'ca1', recordCount: 2 }],
      countsByRepo: { 'repo-ca1': new Map([['A', 2]]) },
    });

    await recomputeRecordCountsForWorkbook(deps, WORKBOOK_ID, { connectorAccountId: 'ca1' });

    expect(deps.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workbookId: WORKBOOK_ID, connectorAccountId: 'ca1' } }),
    );
  });
});

describe('RecordCountService.recomputeRecordCountForFolder', () => {
  function makeService(folder: (FolderRow & { workbookId: string }) | null, count: number | 'not-found') {
    const update = jest.fn().mockResolvedValue(undefined);
    const findUnique = jest.fn().mockResolvedValue(folder);
    const db = { client: { dataFolder: { findUnique, update } } } as unknown as DbService;

    const resolveConnectionRepoPath = jest.fn((id: string) => Promise.resolve(`repo-${id}`));
    const resolveRepoPathForFolder = jest.fn((connectorAccountId: string | null, workbookId: string) =>
      Promise.resolve(connectorAccountId ? `repo-${connectorAccountId}` : `scratch-${workbookId}`),
    );
    const countRecordFilesInFolder = jest.fn(() =>
      count === 'not-found'
        ? Promise.reject(new ScratchGitNotFoundError('/count-folder', 'repo not found'))
        : Promise.resolve(count),
    );
    const scratchGit = {
      resolveConnectionRepoPath,
      resolveRepoPathForFolder,
      countRecordFilesInFolder,
    } as unknown as ScratchGitService;

    const sendWorkbookEvent = jest.fn();
    const events = { sendWorkbookEvent } as unknown as WorkbookEventService;

    return { service: new RecordCountService(db, scratchGit, events), update, sendWorkbookEvent };
  }

  it('updates and emits when the count changed', async () => {
    const { service, update, sendWorkbookEvent } = makeService(
      { id: 'f1', workbookId: WORKBOOK_ID, path: '/A', connectorAccountId: 'ca1', recordCount: 1 },
      4,
    );

    await service.recomputeRecordCountForFolder('f1' as DataFolderId);

    expect(recordCountUpdatesById(update)).toEqual({ f1: 4 });
    expect(sendWorkbookEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the count is unchanged', async () => {
    const { service, update, sendWorkbookEvent } = makeService(
      { id: 'f1', workbookId: WORKBOOK_ID, path: '/A', connectorAccountId: 'ca1', recordCount: 4 },
      4,
    );

    await service.recomputeRecordCountForFolder('f1' as DataFolderId);

    expect(update).not.toHaveBeenCalled();
    expect(sendWorkbookEvent).not.toHaveBeenCalled();
  });

  it('treats a missing repo as 0', async () => {
    const { service, update } = makeService(
      { id: 'f1', workbookId: WORKBOOK_ID, path: '/A', connectorAccountId: 'ca1', recordCount: 5 },
      'not-found',
    );

    await service.recomputeRecordCountForFolder('f1' as DataFolderId);

    expect(recordCountUpdatesById(update)).toEqual({ f1: 0 });
  });
});
