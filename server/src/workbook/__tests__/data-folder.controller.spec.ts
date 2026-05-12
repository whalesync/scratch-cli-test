/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException } from '@nestjs/common';
import type { DataFolder, DataFolderId, WorkbookId } from '@spinner/shared-types';
import type { RequestWithUser } from 'src/auth/types';
import type { DbService } from 'src/db/db.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import type { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DataFolderController } from '../data-folder.controller';
import type { DataFolderService } from '../data-folder.service';
import type { WorkbookService } from '../workbook.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const FOLDER_ID = 'dfld_test' as DataFolderId;
const USER_ID = 'usr_test';

function makeReq(): RequestWithUser {
  return {
    user: {
      id: USER_ID,
      organizationId: 'org_test',
      role: 'USER',
      authType: 'jwt',
      authSource: 'user',
    },
  } as unknown as RequestWithUser;
}

function makeFolder(options: Record<string, unknown> | null): DataFolder {
  return {
    id: FOLDER_ID,
    workbookId: WORKBOOK_ID,
    name: 'My Folder',
    path: '/My Folder',
    connectorAccountId: 'coa_test',
    connectorService: 'AIRTABLE',
    tableId: ['tbl_1'],
    lock: null,
    options,
  } as unknown as DataFolder;
}

describe('DataFolderController.publishSingleFolder — read-only enforcement (DEV-9928)', () => {
  let controller: DataFolderController;
  let dataFolderService: jest.Mocked<DataFolderService>;
  let workbookService: jest.Mocked<WorkbookService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let dbService: jest.Mocked<DbService>;

  beforeEach(() => {
    dataFolderService = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<DataFolderService>;

    workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: 'org_test' }),
    } as unknown as jest.Mocked<WorkbookService>;

    bullEnqueuerService = {
      enqueuePublishDataFolderJob: jest.fn().mockResolvedValue({ id: 'job_1' }),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    dbService = {
      client: {
        dataFolder: { update: jest.fn() },
      },
    } as unknown as jest.Mocked<DbService>;

    controller = new DataFolderController(
      dataFolderService,
      workbookService,
      bullEnqueuerService,
      { trackPublishDataFromWorkbook: jest.fn() } as unknown as jest.Mocked<PostHogService>,
      {} as unknown as jest.Mocked<ScratchGitService>,
      dbService,
    );
  });

  it('throws BadRequestException when the folder has options.readOnly === true', async () => {
    dataFolderService.findOne.mockResolvedValue(makeFolder({ readOnly: true }));

    await expect(
      controller.publishSingleFolder(FOLDER_ID, { workbookId: WORKBOOK_ID }, makeReq()),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(bullEnqueuerService.enqueuePublishDataFolderJob).not.toHaveBeenCalled();
    expect(dbService.client.dataFolder.update).not.toHaveBeenCalled();
  });

  it('proceeds normally when the folder is not read-only', async () => {
    dataFolderService.findOne.mockResolvedValue(makeFolder({}));

    const result = await controller.publishSingleFolder(FOLDER_ID, { workbookId: WORKBOOK_ID }, makeReq());

    expect(result).toEqual({ jobId: 'job_1' });
    expect(bullEnqueuerService.enqueuePublishDataFolderJob).toHaveBeenCalledTimes(1);
  });
});
