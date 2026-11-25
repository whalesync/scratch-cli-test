import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { PostHogService } from 'src/posthog/posthog.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import {
  DataFolderTableSpecStoreService,
  type StoredTableSpecsForCliCacheRefreshConnection,
} from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { CliTableSpecsController } from '../cli-table-specs.controller';

const WORKBOOK_ID = 'wkb_test123';
const CONNECTOR_ACCOUNT_ID = 'coa_conn1';
const STORED_TABLE_SPEC_CONTENT = '{\n  "name": "Café"\n}\n';

function makeRequest(userAgent: string): RequestWithUser & Request {
  return {
    user: {
      id: 'usr_abc',
      organizationId: 'org_1',
      authType: 'api-token',
      authSource: 'user',
      workspacePermissions: [{ id: 'wsp_1', workbookId: WORKBOOK_ID, role: 'editor' }],
    },
    get: (header: string) => (header.toLowerCase() === 'user-agent' ? userAgent : undefined),
  } as unknown as RequestWithUser & Request;
}

describe('CliTableSpecsController', () => {
  let workbookService: { assertReadableWorkbook: jest.Mock };
  let dataFolderTableSpecStore: { readTableSpecsAndDefaultViewsForCliCacheRefresh: jest.Mock };
  let posthogService: { trackCliListWorkbookTableSpecs: jest.Mock };
  let controller: CliTableSpecsController;

  const storedListing: StoredTableSpecsForCliCacheRefreshConnection[] = [
    {
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
      dataFolders: [
        {
          dataFolderId: 'dfd_1',
          folderPath: '/Posts',
          storedRowUpdatedAt: new Date('2026-11-23T18:02:11.123Z'),
          tableSpec: { status: 'present', sha256: 'aa', content: STORED_TABLE_SPEC_CONTENT },
          defaultView: { status: 'absent' },
        },
        {
          dataFolderId: 'dfd_2',
          folderPath: '/',
          storedRowUpdatedAt: null,
          tableSpec: { status: 'unreadable', reason: 'stored-content-not-a-json-object' },
          defaultView: { status: 'absent' },
        },
      ],
    },
    { connectorAccountId: 'coa_conn2', dataFolders: [] },
  ];

  beforeEach(() => {
    workbookService = { assertReadableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }) };
    dataFolderTableSpecStore = {
      readTableSpecsAndDefaultViewsForCliCacheRefresh: jest.fn().mockResolvedValue(storedListing),
    };
    posthogService = { trackCliListWorkbookTableSpecs: jest.fn() };
    controller = new CliTableSpecsController(
      workbookService as unknown as WorkbookService,
      dataFolderTableSpecStore as unknown as DataFolderTableSpecStoreService,
      posthogService as unknown as PostHogService,
    );
  });

  it('is guarded by the API auth and the per-user rate limit', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CliTableSpecsController)).toEqual([
      ScratchAuthGuard,
      ApiRateLimitGuard,
    ]);
  });

  it('checks the workbook, then serves the stored listing in the wire shape', async () => {
    const response = await controller.listWorkbookTableSpecs(
      makeRequest('Scratch-cli/1.0 scratchmd/0.4.2'),
      WORKBOOK_ID,
      {},
    );

    expect(workbookService.assertReadableWorkbook).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_abc' }),
      WORKBOOK_ID,
    );
    expect(dataFolderTableSpecStore.readTableSpecsAndDefaultViewsForCliCacheRefresh).toHaveBeenCalledWith(WORKBOOK_ID, {
      connectorAccountId: undefined,
      includeContent: true,
    });
    expect(response).toEqual({
      formatVersion: 1,
      workbookId: WORKBOOK_ID,
      connectorAccounts: [
        {
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          dataFolders: [
            {
              dataFolderId: 'dfd_1',
              path: '/Posts',
              storedRowUpdatedAt: '2026-11-23T18:02:11.123Z',
              tableSpec: { status: 'present', sha256: 'aa', content: STORED_TABLE_SPEC_CONTENT },
              defaultView: { status: 'absent' },
            },
            {
              dataFolderId: 'dfd_2',
              path: '/',
              storedRowUpdatedAt: null,
              tableSpec: { status: 'unreadable', reason: 'stored-content-not-a-json-object' },
              defaultView: { status: 'absent' },
            },
          ],
        },
        { connectorAccountId: 'coa_conn2', dataFolders: [] },
      ],
    });
  });

  it('passes the connection scope and metadata-only mode to the store, and tracks the listing', async () => {
    await controller.listWorkbookTableSpecs(makeRequest('Scratch-cli/1.0'), WORKBOOK_ID, {
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
      metadataOnly: true,
    });

    expect(dataFolderTableSpecStore.readTableSpecsAndDefaultViewsForCliCacheRefresh).toHaveBeenCalledWith(WORKBOOK_ID, {
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
      includeContent: false,
    });
    expect(posthogService.trackCliListWorkbookTableSpecs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_abc' }),
      WORKBOOK_ID,
      {
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        metadataOnly: true,
        connectionCount: 2,
        folderCount: 2,
        presentFileCount: 1,
        absentFileCount: 2,
        unreadableFileCount: 1,
        // Counted from the listing the store returned; "Café" has a two-byte character.
        contentBytes: Buffer.byteLength(STORED_TABLE_SPEC_CONTENT, 'utf8'),
        scratchmdClient: { scratchmdClientKind: 'legacy-scratchmd' },
      },
    );
  });

  it("doesn't read the store for a workbook the caller can't read", async () => {
    workbookService.assertReadableWorkbook.mockRejectedValue(new NotFoundException('Workbook not found'));

    await expect(
      controller.listWorkbookTableSpecs(makeRequest('Scratch-cli/1.0'), 'wkb_other_tenant', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(dataFolderTableSpecStore.readTableSpecsAndDefaultViewsForCliCacheRefresh).not.toHaveBeenCalled();
    expect(posthogService.trackCliListWorkbookTableSpecs).not.toHaveBeenCalled();
  });
});
