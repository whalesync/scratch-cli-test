import { NotFoundException } from '@nestjs/common';
import type { DataFolderId, TableView } from '@spinner/shared-types';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DataFolderController } from '../data-folder.controller';
import { DataFolderService } from '../data-folder.service';
import { WorkbookService } from '../workbook.service';

const DATA_FOLDER_ID = 'dfd_posts' as DataFolderId;

function makeRequest(): RequestWithUser {
  return {
    user: {
      id: 'usr_abc',
      organizationId: 'org_1',
      authType: 'jwt',
      authSource: 'user',
    },
  } as unknown as RequestWithUser;
}

describe('DataFolderController.getDataFolderDefaultView', () => {
  let dataFolderService: { getStoredView: jest.Mock };
  let controller: DataFolderController;

  beforeEach(() => {
    dataFolderService = { getStoredView: jest.fn() };
    controller = new DataFolderController(
      dataFolderService as unknown as DataFolderService,
      {} as WorkbookService,
      {} as BullEnqueuerService,
      {} as PostHogService,
      {} as ScratchGitService,
      {} as DbService,
    );
  });

  it("returns the folder's stored default view for the requesting user", async () => {
    const storedDefaultView: TableView = { name: 'default', cols: [{ kind: 'col', path: 'title' }] };
    dataFolderService.getStoredView.mockResolvedValue(storedDefaultView);

    const response = await controller.getDataFolderDefaultView(DATA_FOLDER_ID, makeRequest());

    expect(response).toEqual(storedDefaultView);
    expect(dataFolderService.getStoredView).toHaveBeenCalledWith(
      DATA_FOLDER_ID,
      expect.objectContaining({ userId: 'usr_abc' }),
    );
  });

  it('returns 404 when the folder has no stored default view', async () => {
    dataFolderService.getStoredView.mockResolvedValue(null);

    await expect(controller.getDataFolderDefaultView(DATA_FOLDER_ID, makeRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
