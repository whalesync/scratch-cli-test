/* eslint-disable @typescript-eslint/unbound-method */
import { InternalServerErrorException } from '@nestjs/common';
import { WorkbookId, WorkbookManager } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookProvisioningService } from '../workbook-provisioning.service';
import { getWorkbookRepoPath } from '../workbook-repo.service';

const OWNER_USER_ID = 'usr_test';
const ORGANIZATION_ID = 'org_test';

interface CapturedWorkbookCreateData {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  managedBy: WorkbookManager | null;
  version: number;
  workspacePermissions: { create: { userId: string; role: string } };
  usersWithAsDefault?: { connect: { id: string } };
}

describe('WorkbookProvisioningService', () => {
  let service: WorkbookProvisioningService;
  let workbookCreate: jest.Mock;
  let workbookDelete: jest.Mock;
  let scratchGitService: jest.Mocked<ScratchGitService>;

  beforeEach(() => {
    workbookCreate = jest
      .fn()
      .mockImplementation(({ data }: { data: { id: string } }) =>
        Promise.resolve({ id: data.id, organizationId: ORGANIZATION_ID }),
      );
    workbookDelete = jest.fn().mockResolvedValue({});

    const dbService = {
      client: { workbook: { create: workbookCreate, delete: workbookDelete } },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      initRepo: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    service = new WorkbookProvisioningService(dbService, scratchGitService);
  });

  function capturedCreateData(): CapturedWorkbookCreateData {
    const [firstCallArgs] = workbookCreate.mock.calls as [{ data: CapturedWorkbookCreateData }][];
    return firstCallArgs[0].data;
  }

  it('creates the workbook row then inits the config repo at org/workbook/workbook', async () => {
    await service.createWorkbookWithConfigRepo({
      name: 'My Workbook',
      ownerUserId: OWNER_USER_ID,
      organizationId: ORGANIZATION_ID,
    });

    const data = capturedCreateData();
    expect(data).toMatchObject({
      userId: OWNER_USER_ID,
      organizationId: ORGANIZATION_ID,
      name: 'My Workbook',
      managedBy: null,
      version: 2,
    });
    expect(data.workspacePermissions.create).toMatchObject({ userId: OWNER_USER_ID, role: 'editor' });

    // The config repo path uses the workbook id twice — the exact shape the desktop clones.
    expect(scratchGitService.initRepo).toHaveBeenCalledWith(
      getWorkbookRepoPath(ORGANIZATION_ID, data.id as WorkbookId),
    );
  });

  it('rolls back the workbook row and throws when config repo init fails', async () => {
    scratchGitService.initRepo.mockRejectedValue(new Error('git down'));

    await expect(
      service.createWorkbookWithConfigRepo({
        name: 'My Workbook',
        ownerUserId: OWNER_USER_ID,
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(workbookDelete).toHaveBeenCalledWith({ where: { id: capturedCreateData().id } });
  });

  it('links the workbook as the owner default when setAsOwnerDefaultWorkspace is true (signup path)', async () => {
    await service.createWorkbookWithConfigRepo({
      name: 'My Scratch workspace',
      ownerUserId: OWNER_USER_ID,
      organizationId: ORGANIZATION_ID,
      setAsOwnerDefaultWorkspace: true,
    });

    expect(capturedCreateData().usersWithAsDefault).toEqual({ connect: { id: OWNER_USER_ID } });
  });

  it('does not link a default workspace when setAsOwnerDefaultWorkspace is omitted (manual path)', async () => {
    await service.createWorkbookWithConfigRepo({
      name: 'My Workbook',
      ownerUserId: OWNER_USER_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(capturedCreateData().usersWithAsDefault).toBeUndefined();
  });

  it('passes the managing app through to the workbook row (e.g. ws_crm from Whalesync)', async () => {
    await service.createWorkbookWithConfigRepo({
      name: 'CRM Workbook',
      ownerUserId: OWNER_USER_ID,
      organizationId: ORGANIZATION_ID,
      managedByApp: WorkbookManager.WS_CRM,
    });

    expect(capturedCreateData().managedBy).toBe(WorkbookManager.WS_CRM);
  });
});
