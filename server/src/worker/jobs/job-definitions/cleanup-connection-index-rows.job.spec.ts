import { JobType, type WorkbookId } from '@spinner/shared-types';
import { DbService } from '../../../db/db.service';
import { FileIndexService } from '../../../publish-plan/file-index.service';
import { FileReferenceService } from '../../../publish-plan/file-reference.service';
import {
  CleanupConnectionIndexRowsJobDefinition,
  CleanupConnectionIndexRowsJobHandler,
} from './cleanup-connection-index-rows.job';

describe('CleanupConnectionIndexRowsJobHandler', () => {
  const WORKBOOK_ID = 'wkb_1' as WorkbookId;

  function setup(liveFolderPaths: string[]) {
    const deleteForConnection = jest.fn().mockResolvedValue(undefined);
    const deleteForFolderExcludingLiveChildren = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn().mockResolvedValue(liveFolderPaths.map((path) => ({ path })));
    const fileIndexService = { deleteForConnection } as unknown as FileIndexService;
    const fileReferenceService = { deleteForFolderExcludingLiveChildren } as unknown as FileReferenceService;
    const db = { client: { dataFolder: { findMany } } } as unknown as DbService;
    const handler = new CleanupConnectionIndexRowsJobHandler(fileIndexService, fileReferenceService, db);
    return { handler, deleteForConnection, deleteForFolderExcludingLiveChildren };
  }

  function run(handler: CleanupConnectionIndexRowsJobHandler, connectionFolderPaths: string[]) {
    const data: CleanupConnectionIndexRowsJobDefinition['data'] = {
      type: JobType.CleanupConnectionIndexRows,
      workbookId: WORKBOOK_ID,
      userId: 'usr_1',
      connectorAccountId: 'coa_dead',
      connectionFolderPaths,
    };
    return handler.run({
      jobId: 'job_1',
      data,
      progress: { publicProgress: { status: 'active' }, jobProgress: {}, connectorProgress: {}, timestamp: 0 },
      abortSignal: new AbortController().signal,
      checkpoint: jest.fn().mockResolvedValue(undefined),
    });
  }

  it('deletes FileIndex by connection and FileReference for every abandoned path', async () => {
    const { handler, deleteForConnection, deleteForFolderExcludingLiveChildren } = setup([]);

    await run(handler, ['/Contacts', '/Companies']);

    expect(deleteForConnection).toHaveBeenCalledWith(WORKBOOK_ID, 'coa_dead');
    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledWith(WORKBOOK_ID, 'Contacts', []);
    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledWith(WORKBOOK_ID, 'Companies', []);
    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledTimes(2);
  });

  it('skips a path a live DataFolder has reclaimed at-or-above it (common reconnect)', async () => {
    // A reconnect of the same service recreated a DataFolder at /Contacts before this job drained.
    const { handler, deleteForConnection, deleteForFolderExcludingLiveChildren } = setup(['/Contacts']);

    await run(handler, ['/Contacts', '/Companies']);

    // FileIndex is always safe — scoped by the now-dead connectorAccountId.
    expect(deleteForConnection).toHaveBeenCalledWith(WORKBOOK_ID, 'coa_dead');
    // The reconnected Contacts folder's fresh refs are preserved; only Companies is swept.
    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledWith(WORKBOOK_ID, 'Companies', []);
    expect(deleteForFolderExcludingLiveChildren).not.toHaveBeenCalledWith(WORKBOOK_ID, 'Contacts', expect.anything());
    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledTimes(1);
  });

  it('excludes a live DataFolder recreated strictly UNDER a deleted path (descendant reclaim)', async () => {
    // A reconnect recreated the nested locale child but not its parent collection: live
    // /Webflow/Collections/Blog/fr with no live /Webflow/Collections/Blog. Sweeping the
    // parent must exclude the live child's subtree so its fresh refs survive.
    const { handler, deleteForFolderExcludingLiveChildren } = setup(['/Webflow/Collections/Blog/fr']);

    await run(handler, ['/Webflow/Collections/Blog']);

    expect(deleteForFolderExcludingLiveChildren).toHaveBeenCalledWith(WORKBOOK_ID, 'Webflow/Collections/Blog', [
      'Webflow/Collections/Blog/fr',
    ]);
  });
});
