/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConnectorAccount } from '@prisma/client';
import {
  TableDiscoveryMode,
  type ConnectorAccountId,
  type DecryptedCredentials,
  type WorkbookId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { OAuthService } from 'src/oauth/oauth.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import type { AuthParser } from '../../connectors/connector';
import { ConnectorsService } from '../../connectors/connectors.service';
import { MySqlAuthParser } from '../../connectors/library/mysql/mysql-auth-parser';
import { MySqlCredentialsInvalidError } from '../../connectors/library/mysql/mysql-credential-errors';
import { ConnectorAccountService } from '../connector-account.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const ACCOUNT_ID = 'ca_test' as ConnectorAccountId;
const ACTOR: Actor = {
  userId: 'usr_test',
  organizationId: 'org_test',
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
  let connectorsService: jest.Mocked<ConnectorsService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let posthogService: jest.Mocked<PostHogService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let credentialEncryptionService: jest.Mocked<CredentialEncryptionService>;
  let workbookEventService: jest.Mocked<WorkbookEventService>;
  let experimentsService: jest.Mocked<ExperimentsService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;

  beforeEach(() => {
    dbService = {
      client: {
        connectorAccount: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
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
        // Per-(workbook, account) auxiliary tables cleaned up by
        // removeConnectionData when a connector is removed without
        // deleting the workbook itself. Stubs here so the cleanup path
        // doesn't trip on undefined methods.
        uploadPatchMeta: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        recreatedIdMap: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        // FileIndex/FileReference orphan cleanup (DEV-10885). remove() defers this to
        // an async job, but resetConnection cleans them inline via these deleteManys.
        fileIndex: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        fileReference: {
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
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org_test--wkb_test--ca_test'),
      initRepo: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    posthogService = {
      trackRemoveDataSource: jest.fn(),
      trackUpdateDataSource: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
      encryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    workbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    connectorsService = {
      getConnector: jest.fn(),
      getAuthParser: jest.fn(),
    } as unknown as jest.Mocked<ConnectorsService>;
    const oauthService = {} as jest.Mocked<OAuthService>;

    experimentsService = {} as jest.Mocked<ExperimentsService>;

    bullEnqueuerService = {
      enqueueCleanupConnectionIndexRowsJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    service = new ConnectorAccountService(
      dbService,
      connectorsService,
      oauthService,
      posthogService,
      auditLogService,
      credentialEncryptionService,
      scratchGitService,
      workbookEventService,
      experimentsService,
      bullEnqueuerService,
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

      // Schedules deleted for folder IDs and the connection-wide schedule (account id)
      expect(dbService.client.schedule.deleteMany).toHaveBeenCalledWith({
        where: { entityId: { in: ['df_1', 'df_2', ACCOUNT_ID] } },
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
      // Orphan FileIndex/FileReference cleanup deferred to a background job (DEV-10885),
      // scoped to this connection and carrying its folder paths for FileReference cleanup.
      expect(bullEnqueuerService.enqueueCleanupConnectionIndexRowsJob).toHaveBeenCalledWith(
        {
          workbookId: WORKBOOK_ID,
          connectorAccountId: ACCOUNT_ID,
          connectionFolderPaths: ['/folder1', '/folder2'],
        },
        ACTOR,
      );
    });

    it('V2 workbook — no data folders still deletes git repo and account', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([]);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ version: 2 });

      await service.remove(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // No per-table schedules, but the connection-wide schedule (account id) is still cleaned up
      expect(dbService.client.schedule.deleteMany).toHaveBeenCalledWith({
        where: { entityId: { in: [ACCOUNT_ID] } },
      });
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

  describe('update', () => {
    const STORED_MYSQL_CREDENTIALS: DecryptedCredentials = {
      databaseHost: 'old.example.com',
      databasePort: '3306',
      databaseName: 'old_db',
      username: 'old_user',
      password: 'old-secret',
      sslMode: 'VERIFY_CA',
    };

    function mockStoredAccount(service: string, storedCredentials: DecryptedCredentials): void {
      const account = createMockAccount({ service } as Partial<ConnectorAccount>);
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (dbService.client.connectorAccount.update as jest.Mock).mockResolvedValue(account);
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org_test' });
      // The first decrypt reads the stored credentials; the one after the write builds the response.
      credentialEncryptionService.decryptCredentials.mockResolvedValueOnce({ ...storedCredentials });
    }

    function credentialsPassedToEncryption(): unknown {
      return credentialEncryptionService.encryptCredentials.mock.calls[0][0];
    }

    beforeEach(() => {
      connectorsService.getAuthParser.mockImplementation(({ service: requestedService }) =>
        requestedService === 'MYSQL' ? new MySqlAuthParser() : undefined,
      );
    });

    it('MySQL: a connection string replaces the stored host, port, database, username and password, and is never stored', async () => {
      mockStoredAccount('MYSQL', STORED_MYSQL_CREDENTIALS);

      await service.update(
        WORKBOOK_ID,
        ACCOUNT_ID,
        { userProvidedParams: { connectionString: 'mysql://new_user:new-secret@new.example.com:3307/new_db' } },
        ACTOR,
      );

      expect(credentialsPassedToEncryption()).toEqual({
        databaseHost: 'new.example.com',
        databasePort: '3307',
        databaseName: 'new_db',
        username: 'new_user',
        password: 'new-secret',
        // Inherited: the connection string has no SSL option.
        sslMode: 'VERIFY_CA',
      });
    });

    it('MySQL: a password-only edit keeps every other stored setting', async () => {
      mockStoredAccount('MYSQL', STORED_MYSQL_CREDENTIALS);

      await service.update(WORKBOOK_ID, ACCOUNT_ID, { userProvidedParams: { password: 'rotated-secret' } }, ACTOR);

      expect(credentialsPassedToEncryption()).toEqual({ ...STORED_MYSQL_CREDENTIALS, password: 'rotated-secret' });
    });

    it('MySQL: an edit purges a connection string left in the stored credentials', async () => {
      mockStoredAccount('MYSQL', {
        ...STORED_MYSQL_CREDENTIALS,
        connectionString: 'mysql://old_user:old-secret@old.example.com:3306/old_db',
      });

      await service.update(WORKBOOK_ID, ACCOUNT_ID, { userProvidedParams: { password: 'rotated-secret' } }, ACTOR);

      expect(credentialsPassedToEncryption()).toEqual({ ...STORED_MYSQL_CREDENTIALS, password: 'rotated-secret' });
    });

    it('MySQL: a rejected edit throws before anything is written', async () => {
      mockStoredAccount('MYSQL', STORED_MYSQL_CREDENTIALS);

      await expect(
        service.update(
          WORKBOOK_ID,
          ACCOUNT_ID,
          { userProvidedParams: { connectionString: 'postgres://user:secret@db.example.com:5432/app' } },
          ACTOR,
        ),
      ).rejects.toThrow(MySqlCredentialsInvalidError);
      expect(credentialEncryptionService.encryptCredentials).not.toHaveBeenCalled();
      expect(dbService.client.connectorAccount.update).not.toHaveBeenCalled();
    });

    it('a parser that does not handle edits is skipped, and the edit is merged into the stored credentials', async () => {
      const parserThatOnlyHandlesCreate = {
        service: 'WORDPRESS',
        parsesCredentialEditsAgainstStoredCredentials: false,
        parseUserProvidedParams: jest.fn(),
      } as unknown as AuthParser;
      connectorsService.getAuthParser.mockReturnValue(parserThatOnlyHandlesCreate);
      mockStoredAccount('WORDPRESS', { username: 'editor', password: 'old-app-password', endpoint: 'https://a.test' });

      await service.update(WORKBOOK_ID, ACCOUNT_ID, { userProvidedParams: { password: 'new-app-password' } }, ACTOR);

      expect(parserThatOnlyHandlesCreate.parseUserProvidedParams).not.toHaveBeenCalled();
      expect(credentialsPassedToEncryption()).toEqual({
        username: 'editor',
        password: 'new-app-password',
        endpoint: 'https://a.test',
      });
    });
  });

  describe('resetConnection', () => {
    it('cleans FileIndex/FileReference inline and escapes LIKE wildcards in the folder-path prefix', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({
        id: WORKBOOK_ID,
        organizationId: 'org_test',
        version: 2,
      });
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(createMockAccount());
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([{ path: '/product_variants' }]);

      await service.resetConnection(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // FileIndex scoped delete (covers nested sub-paths for free).
      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, connectorAccountId: ACCOUNT_ID },
      });
      // FileReference prefix delete with the `_` escaped so LIKE can't over-match another folder.
      expect(dbService.client.fileReference.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, sourceFilePath: { startsWith: 'product\\_variants/' } },
      });
    });
  });

  describe('listCreateDestinations', () => {
    it('returns the connector destinations sorted alphabetically by name', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      const mockConnector = {
        listCreateDestinations: jest.fn().mockResolvedValue([
          { id: 'app_z', name: 'Zebra base' },
          { id: 'app_a', name: 'Apple base' },
        ]),
      };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result).toEqual({
        destinations: [
          { id: 'app_a', name: 'Apple base' },
          { id: 'app_z', name: 'Zebra base' },
        ],
      });
      expect(mockConnector.listCreateDestinations).toHaveBeenCalledTimes(1);
    });

    it('puts a not-yet-created destination first, ahead of the alphabetical existing ones (DEV-11396)', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      // "New schema" would sort between "analytics" and "public" alphabetically;
      // it leads because it is the one a client defaults to.
      const mockConnector = {
        listCreateDestinations: jest.fn().mockResolvedValue([
          { id: 'ref/public', name: 'public', created: true },
          { id: 'ref/analytics', name: 'analytics', created: true },
          { id: 'ref/scratch-new-schema', name: 'New schema', created: false },
        ]),
      };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.destinations.map((destination) => destination.name)).toEqual(['New schema', 'analytics', 'public']);
      // The picker is TOLD what to preselect rather than inferring it from the order.
      expect(result.defaultDestinationId).toBe('ref/scratch-new-schema');
    });

    it('has no default when every destination already exists (nothing to steer toward)', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      (connectorsService.getConnector as jest.Mock).mockResolvedValue({
        listCreateDestinations: jest.fn().mockResolvedValue([
          { id: 'app_a', name: 'Apple base', created: true },
          { id: 'app_z', name: 'Zebra base', created: true },
        ]),
      });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.defaultDestinationId).toBeUndefined();
    });

    it('has no default when several destinations are uncreated, rather than silently picking a project', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      // A multi-project Supabase OAuth connection: one "New schema" per project.
      // Choosing between them is the user's decision, not ours.
      (connectorsService.getConnector as jest.Mock).mockResolvedValue({
        listCreateDestinations: jest.fn().mockResolvedValue([
          { id: 'prod/new', name: 'Prod / New schema', created: false },
          { id: 'prod/public', name: 'Prod / public', created: true },
          { id: 'staging/new', name: 'Staging / New schema', created: false },
        ]),
      });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.destinations).toHaveLength(3);
      expect(result.defaultDestinationId).toBeUndefined();
    });

    it('throws BadRequestException when the connector does not implement listCreateDestinations', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      // A connector without the optional method (e.g. a read-only connector).
      (connectorsService.getConnector as jest.Mock).mockResolvedValue({});

      await expect(service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the account is not found', async () => {
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR)).rejects.toThrow(NotFoundException);

      expect(connectorsService.getConnector).not.toHaveBeenCalled();
    });
  });

  /**
   * The URL is stamped here rather than by each connector so a connector builds
   * it once instead of at each of its `{ id, name }` construction sites. These
   * cover every path a destination can leave the service by — including the two
   * in-process fallbacks, where a missed decoration would silently ship a picker
   * that links but a saved-selection refresh that doesn't.
   */
  describe('create-destination remoteWebUrl stamping', () => {
    const DESTINATION = { id: 'app_a', name: 'Apple base', created: true };

    function mockConnectorReturning(overrides: Record<string, unknown>) {
      const mockConnector = {
        buildCreateDestinationRemoteWebUrl: jest.fn((id: string) => `https://example.test/${id}`),
        ...overrides,
      };
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
      return mockConnector;
    }

    it('stamps the link on listed destinations', async () => {
      mockConnectorReturning({ listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]) });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.destinations).toEqual([{ ...DESTINATION, remoteWebUrl: 'https://example.test/app_a' }]);
    });

    it('leaves the key ABSENT when the connector has no link for the id', async () => {
      mockConnectorReturning({
        listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]),
        buildCreateDestinationRemoteWebUrl: jest.fn().mockReturnValue(undefined),
      });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      // toEqual, not toMatchObject: an explicit `remoteWebUrl: undefined` would
      // change the wire shape for every existing consumer.
      expect(result.destinations).toEqual([DESTINATION]);
    });

    it('passes a connector without the hook through untouched', async () => {
      mockConnectorReturning({
        listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]),
        buildCreateDestinationRemoteWebUrl: undefined,
      });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.destinations).toEqual([DESTINATION]);
    });

    it('does not fail the request when a connectorhook throws', async () => {
      mockConnectorReturning({
        listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]),
        buildCreateDestinationRemoteWebUrl: jest.fn(() => {
          throw new Error('bad id');
        }),
      });

      const result = await service.listCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result.destinations).toEqual([DESTINATION]);
    });

    it('stamps on the connector search path', async () => {
      mockConnectorReturning({
        searchCreateDestinations: jest.fn().mockResolvedValue({ destinations: [DESTINATION], hasMore: false }),
      });

      const result = await service.searchCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, 'app', ACTOR);

      expect(result.destinations).toEqual([{ ...DESTINATION, remoteWebUrl: 'https://example.test/app_a' }]);
    });

    it('stamps on the in-process search fallback', async () => {
      // No searchCreateDestinations — the service filters the full list itself.
      mockConnectorReturning({ listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]) });

      const result = await service.searchCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, 'apple', ACTOR);

      expect(result.destinations).toEqual([{ ...DESTINATION, remoteWebUrl: 'https://example.test/app_a' }]);
    });

    it('keeps the order a connector search returns (best matches first), rather than sorting by name', async () => {
      const ranked = [
        { id: 'p2', name: 'Zebra: Attio export', created: true },
        { id: 'p1', name: 'Attio CRM', created: true },
        { id: 'p3', name: 'Action items', created: true },
      ];
      mockConnectorReturning({
        searchCreateDestinations: jest.fn().mockResolvedValue({ destinations: ranked, hasMore: true }),
      });

      const result = await service.searchCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, 'Attio', ACTOR);

      expect(result.destinations.map((destination) => destination.id)).toEqual(['p2', 'p1', 'p3']);
      expect(result.hasMore).toBe(true);
    });

    it('sorts the in-process fallback by name before applying the cap', async () => {
      // 51 matches named zz_00 … zz_50 plus one 'aa' — the alphabetical first must survive the cap of 50.
      const many = Array.from({ length: 51 }, (_, i) => ({
        id: `z${i}`,
        name: `zz_${String(i).padStart(2, '0')} base`,
        created: true,
      }));
      mockConnectorReturning({
        listCreateDestinations: jest.fn().mockResolvedValue([...many, { id: 'a', name: 'aa base', created: true }]),
      });

      const result = await service.searchCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, 'base', ACTOR);

      expect(result.destinations).toHaveLength(50);
      expect(result.destinations[0].id).toBe('a');
      expect(result.destinations[1].id).toBe('z0');
      expect(result.hasMore).toBe(true);
    });

    it('keeps a not-yet-created destination at the head of the in-process fallback, so the cap can never cut it', async () => {
      // 60 existing bases whose names all sort before "New base" — without the
      // created-first rule the default destination would fall off the 50-cap.
      const many = Array.from({ length: 60 }, (_, i) => ({
        id: `a${i}`,
        name: `aa_${String(i).padStart(2, '0')} base`,
        created: true,
      }));
      mockConnectorReturning({
        listCreateDestinations: jest.fn().mockResolvedValue([...many, { id: 'new', name: 'New base', created: false }]),
      });

      const result = await service.searchCreateDestinations(WORKBOOK_ID, ACCOUNT_ID, 'base', ACTOR);

      expect(result.destinations[0].id).toBe('new');
      expect(result.destinations).toHaveLength(50);
      expect(result.hasMore).toBe(true);
    });

    it('stamps on the connector lookup path', async () => {
      mockConnectorReturning({ lookupCreateDestination: jest.fn().mockResolvedValue(DESTINATION) });

      const result = await service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, 'app_a', ACTOR);

      expect(result.destination).toEqual({ ...DESTINATION, remoteWebUrl: 'https://example.test/app_a' });
    });

    it('stamps on the list-scan lookup fallback', async () => {
      // No lookupCreateDestination — the service scans the full list itself.
      mockConnectorReturning({ listCreateDestinations: jest.fn().mockResolvedValue([DESTINATION]) });

      const result = await service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, 'app_a', ACTOR);

      expect(result.destination).toEqual({ ...DESTINATION, remoteWebUrl: 'https://example.test/app_a' });
    });

    it('leaves a stale lookup null rather than decorating it', async () => {
      mockConnectorReturning({ lookupCreateDestination: jest.fn().mockResolvedValue(null) });

      const result = await service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, 'gone', ACTOR);

      expect(result.destination).toBeNull();
    });

    // DEV-11402: materialize pins a provisioned parent in connector-native segments (Supabase's
    // [projectRef, schema]) that a client can't look up. The lookup endpoint folds those segments
    // back into an id via `createDestinationIdForParent` before resolving.
    it('folds parent segments back into an id through createDestinationIdForParent', async () => {
      const createDestinationIdForParent = jest.fn((segments: string[]) => segments.join('/'));
      const lookupCreateDestination = jest.fn().mockResolvedValue({ ...DESTINATION, id: 'ref/my_schema' });
      mockConnectorReturning({ createDestinationIdForParent, lookupCreateDestination });

      const result = await service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, ['ref', 'my_schema'], ACTOR);

      expect(createDestinationIdForParent).toHaveBeenCalledWith(['ref', 'my_schema']);
      expect(lookupCreateDestination).toHaveBeenCalledWith('ref/my_schema');
      expect(result.destination?.id).toBe('ref/my_schema');
    });

    it('treats a single-segment parent as the id when the connector has no fold hook', async () => {
      const lookupCreateDestination = jest.fn().mockResolvedValue(DESTINATION);
      mockConnectorReturning({ lookupCreateDestination });

      const result = await service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, ['app_a'], ACTOR);

      expect(lookupCreateDestination).toHaveBeenCalledWith('app_a');
      expect(result.destination?.id).toBe('app_a');
    });

    it('400s when the connector cannot address the parent (undefined fold), not { destination: null }', async () => {
      mockConnectorReturning({
        createDestinationIdForParent: jest.fn().mockReturnValue(undefined),
        lookupCreateDestination: jest.fn().mockResolvedValue(DESTINATION),
      });

      await expect(
        service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, ['ref', 'my_schema'], ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s on a multi-segment parent when the connector has no fold hook', async () => {
      mockConnectorReturning({ lookupCreateDestination: jest.fn().mockResolvedValue(DESTINATION) });

      await expect(
        service.lookupCreateDestination(WORKBOOK_ID, ACCOUNT_ID, ['ref', 'my_schema'], ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // DEV-11167: every connection endpoint reachable over HTTP takes its `connectorAccountId` straight
  // from the caller. The controller's `checkWorkspacePermissions` only proves the caller may access
  // the workbook they NAMED — so without scoping the lookup on `{ id, workbookId }` too, a caller
  // could pair their own workbook id with another tenant's connector account id and have the server
  // decrypt that tenant's credentials and call their external service on the caller's behalf.
  //
  // Each case below asserts BOTH halves of the fix:
  //   1. the query was scoped to the requested workbook (so a foreign row is never returned), and
  //   2. `getConnector` was never called — i.e. we never reached anyone's external service with
  //      credentials that weren't ours. (2) is the assertion that actually encodes the security
  //      property; (1) alone would still pass if we loaded and decrypted the row before rejecting it.
  describe('cross-workbook scoping (DEV-11167)', () => {
    /** An account that exists, but in a workbook other than the one the caller named. */
    const OTHER_WORKBOOK_ACCOUNT_ID = 'ca_belonging_to_another_workbook' as ConnectorAccountId;

    beforeEach(() => {
      // Prisma's `findUnique({ where: { id, workbookId } })` returns null when the row exists but the
      // non-unique filter doesn't match — exactly the cross-workbook case we're guarding against.
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(null);
      // Present but unused: if any method regressed to an unscoped lookup, it would find the foreign
      // account here and the "never constructed the connector" assertion would fail loudly.
      (dbService.client.connectorAccount.findFirst as jest.Mock).mockResolvedValue(
        createMockAccount({ id: OTHER_WORKBOOK_ACCOUNT_ID, workbookId: 'wkb_someone_else' }),
      );
      // A connector that would happily answer every one of these calls. Never reached while the
      // lookup stays scoped — it exists so a regression fails as "promise resolved instead of
      // rejected" (i.e. the caller got the other tenant's data) rather than as an incidental
      // TypeError from a half-mocked connector.
      (connectorsService.getConnector as jest.Mock).mockResolvedValue({
        tableDiscoveryMode: TableDiscoveryMode.SEARCH,
        supportsFilters: () => false,
        supportsFieldSelection: () => false,
        listTables: jest.fn().mockResolvedValue([]),
        searchTables: jest.fn().mockResolvedValue({ tables: [], hasMore: false }),
        listCreateDestinations: jest.fn().mockResolvedValue([]),
        searchCreateDestinations: jest.fn().mockResolvedValue({ destinations: [], hasMore: false }),
        lookupCreateDestination: jest.fn().mockResolvedValue(null),
        fetchJsonTableSpec: jest.fn().mockResolvedValue({}),
      });
    });

    function expectScopedToRequestedWorkbook(): void {
      expect(dbService.client.connectorAccount.findUnique).toHaveBeenCalledWith({
        where: { id: OTHER_WORKBOOK_ACCOUNT_ID, workbookId: WORKBOOK_ID },
      });
      expect(connectorsService.getConnector).not.toHaveBeenCalled();
      expect(credentialEncryptionService.decryptCredentials).not.toHaveBeenCalled();
    }

    it('listTables does not serve a connector account from another workbook', async () => {
      await expect(service.listTables(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expectScopedToRequestedWorkbook();
    });

    it('listCreateDestinations does not serve a connector account from another workbook', async () => {
      await expect(service.listCreateDestinations(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expectScopedToRequestedWorkbook();
    });

    it('searchCreateDestinations does not serve a connector account from another workbook', async () => {
      await expect(
        service.searchCreateDestinations(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, 'anything', ACTOR),
      ).rejects.toThrow(NotFoundException);

      expectScopedToRequestedWorkbook();
    });

    it('lookupCreateDestination does not serve a connector account from another workbook', async () => {
      await expect(
        service.lookupCreateDestination(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, 'dest_1', ACTOR),
      ).rejects.toThrow(NotFoundException);

      expectScopedToRequestedWorkbook();
    });

    it('searchTables does not serve a connector account from another workbook', async () => {
      await expect(service.searchTables(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, 'anything', ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expectScopedToRequestedWorkbook();
    });

    it('getTableSchema does not serve a connector account from another workbook', async () => {
      // Already scoped before DEV-11167; covered here so the whole endpoint family is pinned by
      // one suite and a future refactor can't quietly unscope it.
      await expect(service.getTableSchema(WORKBOOK_ID, OTHER_WORKBOOK_ACCOUNT_ID, ['tbl_1'], ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expectScopedToRequestedWorkbook();
    });
  });

  describe('getApiQuota', () => {
    it('returns supported: true with quota when connector provides quota data', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      const mockQuota = { rate: { api_key_per_minute: { limit: 900, remaining: 850, used: 50, reset: 30 } } };
      const mockConnector = { getApiQuota: jest.fn().mockResolvedValue({ quota: mockQuota }) };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      const result = await service.getApiQuota(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result).toEqual({ supported: true, quota: mockQuota });
      expect(mockConnector.getApiQuota).toHaveBeenCalledTimes(1);
    });

    it('returns supported: false with dashboardUrl when connector provides a dashboard link', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      const mockConnector = {
        getApiQuota: jest.fn().mockResolvedValue({ dashboardUrl: 'https://example.com/billing' }),
      };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      const result = await service.getApiQuota(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result).toEqual({ supported: false, dashboardUrl: 'https://example.com/billing' });
    });

    it('returns supported: false when connector returns null', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      const mockConnector = { getApiQuota: jest.fn().mockResolvedValue(null) };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      const result = await service.getApiQuota(WORKBOOK_ID, ACCOUNT_ID, ACTOR);

      expect(result).toEqual({ supported: false });
    });

    it('throws NotFoundException when account is not found', async () => {
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getApiQuota(WORKBOOK_ID, ACCOUNT_ID, ACTOR)).rejects.toThrow(NotFoundException);

      expect(connectorsService.getConnector).not.toHaveBeenCalled();
    });

    it('propagates errors from the connector', async () => {
      const account = createMockAccount();
      (dbService.client.connectorAccount.findUnique as jest.Mock).mockResolvedValue(account);
      (credentialEncryptionService.decryptCredentials as jest.Mock).mockResolvedValue({});

      const mockConnector = { getApiQuota: jest.fn().mockRejectedValue(new Error('API key expired')) };
      (connectorsService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      await expect(service.getApiQuota(WORKBOOK_ID, ACCOUNT_ID, ACTOR)).rejects.toThrow('API key expired');
    });
  });
});
