import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { ConnectionRepoIndexController } from '../connection-repo-index.controller';
import { DataFolderTableSpecStoreService } from '../data-folder-table-spec-store.service';

jest.mock('src/users/types', () => ({ userToActor: jest.fn(() => ({ userId: 'usr_1', organizationId: 'org_1' })) }));
jest.mock('src/users/permissions', () => ({ checkWorkspacePermissions: jest.fn() }));

const WORKBOOK_ID = 'wkb_1' as WorkbookId;
const CONNECTOR_ACCOUNT_ID = 'coa_1';
const REPO_ID = 'org_1/wkb_1/coa_1';
const REQUEST = { user: {} } as unknown as RequestWithUser;

describe('ConnectionRepoIndexController — POST /scratch-git/:id/index/build (DEV-12616)', () => {
  let resolveConnectionRepoPathScopedToWorkbook: jest.Mock;
  let rebuildConnectionRepoIndexWithStoredTableSpecs: jest.Mock;
  let controller: ConnectionRepoIndexController;

  beforeEach(() => {
    resolveConnectionRepoPathScopedToWorkbook = jest.fn().mockResolvedValue(REPO_ID);
    rebuildConnectionRepoIndexWithStoredTableSpecs = jest.fn().mockResolvedValue({ count: 42 });
    controller = new ConnectionRepoIndexController(
      { resolveConnectionRepoPathScopedToWorkbook } as unknown as ScratchGitService,
      { rebuildConnectionRepoIndexWithStoredTableSpecs } as unknown as DataFolderTableSpecStoreService,
    );
    (checkWorkspacePermissions as jest.Mock).mockReset();
  });

  it('rebuilds the index with the stored table specs, for a connection resolved within the workbook', async () => {
    await expect(controller.buildIndex(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID, REQUEST)).resolves.toEqual({ count: 42 });
    expect(resolveConnectionRepoPathScopedToWorkbook).toHaveBeenCalledWith(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
    expect(rebuildConnectionRepoIndexWithStoredTableSpecs).toHaveBeenCalledWith(CONNECTOR_ACCOUNT_ID, REPO_ID);
  });

  it('requires a connectorAccountId', async () => {
    await expect(controller.buildIndex(WORKBOOK_ID, undefined, REQUEST)).rejects.toBeInstanceOf(BadRequestException);
    expect(rebuildConnectionRepoIndexWithStoredTableSpecs).not.toHaveBeenCalled();
  });

  it('checks workspace permissions before touching the repo', async () => {
    (checkWorkspacePermissions as jest.Mock).mockImplementation(() => {
      throw new ForbiddenException('no access');
    });
    await expect(controller.buildIndex(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID, REQUEST)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(resolveConnectionRepoPathScopedToWorkbook).not.toHaveBeenCalled();
  });
});
