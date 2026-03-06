/* eslint-disable @typescript-eslint/unbound-method */
import { NotFoundException } from '@nestjs/common';
import type { ConnectorAccount } from '@prisma/client';
import type { ConnectorAccountId, WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { OAuthService } from 'src/oauth/oauth.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { ConnectorAccountService } from '../connector-account.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const ACCOUNT_ID = 'ca_test' as ConnectorAccountId;
const ACTOR: Actor = {
  userId: 'usr_test',
  organizationId: 'org_test',
  authType: 'jwt',
  authSource: 'user',
};

function createMockAccount(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    id: ACCOUNT_ID,
    workbookId: WORKBOOK_ID,
    service: 'AIRTABLE',
    displayName: 'Test Connection',
    authType: 'USER_PROVIDED_PARAMS',
    repoPath: 'org_test--wkb_test--ca_test',
    encryptedCredentials: {},
    healthStatus: null,
    healthStatusLastCheckedAt: null,
    healthStatusMessage: null,
    userId: 'usr_test',
    modifier: null,
    extras: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as ConnectorAccount;
}

describe('ConnectorAccountService', () => {
  let service: ConnectorAccountService;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let posthogService: jest.Mocked<PostHogService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let credentialEncryptionService: jest.Mocked<CredentialEncryptionService>;
  let workbookEventService: jest.Mocked<WorkbookEventService>;

  beforeEach(() => {
    dbService = {
      client: {
        connectorAccount: {
          findUnique: jest.fn(),
          delete: jest.fn().mockResolvedValue({}),
        },
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        schedule: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        publishPlan: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        workbook: {
          findUnique: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      deleteRepo: jest.fn().mockResolvedValue(undefined),
      removeDataFolder: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    posthogService = {
      trackRemoveDataSource: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    workbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    const connectorsService = {} as jest.Mocked<ConnectorsService>;
    const oauthService = {} as jest.Mocked<OAuthService>;

    service = new ConnectorAccountService(
      dbService,
      connectorsService,
      oauthService,
      posthogService,
      auditLogService,
      credentialEncryptionService,
      scratchGitService,
      workbookEventService,
    );
  });

  describe('remove', () => {
    it('V2 workbook — cleans up all associated data and deletes git repo', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'df_1', path: '/folder1' },
        { id: 'df_2', path: '/folder2' },
      ]);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ version: 2 });

      await service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // Schedules deleted for folder IDs
      expect(dbService.client.schedule.deleteMany).toHaveBeenCalledWith({
        where: { entityId: { in: ['df_1', 'df_2'] } },
      });
      // Publish plans deleted
      expect(dbService.client.publishPlan.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, connectorAccountId: ACCOUNT_ID },
      });
      // DataFolders deleted
      expect(dbService.client.dataFolder.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, connectorAccountId: ACCOUNT_ID },
      });
      // V2 git repo deleted using repoPath directly
      expect(scratchGitService.deleteRepo).toHaveBeenCalledWith('org_test--wkb_test--ca_test');
      expect(scratchGitService.removeDataFolder).not.toHaveBeenCalled();
      // ConnectorAccount deleted
      expect(dbService.client.connectorAccount.delete).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID, workbookId: WORKBOOK_ID },
      });
    });

    it('V2 workbook — no data folders still deletes git repo and account', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([]);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ version: 2 });

      await service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // No schedules to delete
      expect(dbService.client.schedule.deleteMany).not.toHaveBeenCalled();
      // Publish plans still deleted (may exist without folders)
      expect(dbService.client.publishPlan.deleteMany).toHaveBeenCalled();
      // DataFolders deleteMany still called (no-op)
      expect(dbService.client.dataFolder.deleteMany).toHaveBeenCalled();
      // Git repo still deleted
      expect(scratchGitService.deleteRepo).toHaveBeenCalledWith('org_test--wkb_test--ca_test');
      // Account deleted
      expect(dbService.client.connectorAccount.delete).toHaveBeenCalled();
    });

    it('continues DB cleanup when git deletion fails', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([{ id: 'df_1', path: '/folder1' }]);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ version: 2 });
      (scratchGitService.deleteRepo as jest.Mock).mockRejectedValue(new Error('git error'));

      await service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // DB cleanup still proceeds
      expect(dbService.client.connectorAccount.delete).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID, workbookId: WORKBOOK_ID },
      });
      expect(posthogService.trackRemoveDataSource).toHaveBeenCalled();
      expect(auditLogService.logEvent).toHaveBeenCalled();
    });

    it('throws NotFoundException when account is not found', async () => {
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR)).rejects.toThrow(NotFoundException);

      // No cleanup attempted
      expect(dbService.client.dataFolder.findMany).not.toHaveBeenCalled();
      expect(dbService.client.connectorAccount.delete).not.toHaveBeenCalled();
    });

    it('tracks removal in PostHog and audit log with correct arguments', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ version: 2 });

      await service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(posthogService.trackRemoveDataSource).toHaveBeenCalledWith(
        ACTOR,
        expect.objectContaining({ id: ACCOUNT_ID }),
      );
      expect(auditLogService.logEvent).toHaveBeenCalledWith({
        actor: ACTOR,
        eventType: 'delete',
        message: 'Deleted connection Test Connection',
        entityId: ACCOUNT_ID,
      });
    });
  });
});
