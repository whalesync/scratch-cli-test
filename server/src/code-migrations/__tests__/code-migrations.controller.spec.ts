/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { OAuthService } from 'src/oauth/oauth.service';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { CodeMigrationsController } from '../code-migrations.controller';

const makeReqWithUser = (isAdmin = true) =>
  ({
    user: {
      id: 'usr_test',
      organizationId: 'org_test',
      role: isAdmin ? UserRole.ADMIN : UserRole.USER,
      authType: 'jwt',
      authSource: 'user',
    },
  }) as never;

function makeWorkbook(id: string, orgId = 'org_test') {
  return { id, organizationId: orgId };
}

describe('CodeMigrationsController', () => {
  let controller: CodeMigrationsController;
  let dbService: jest.Mocked<DbService>;
  let workbookRepoService: jest.Mocked<WorkbookRepoService>;
  let credentialEncryptionService: jest.Mocked<CredentialEncryptionService>;
  let oauthService: jest.Mocked<OAuthService>;
  let auditLogService: jest.Mocked<AuditLogService>;

  beforeEach(() => {
    dbService = {
      client: {
        workbook: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(undefined),
          create: jest.fn().mockResolvedValue(undefined),
        },
        connectorAccount: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    workbookRepoService = {
      initWorkbookRepo: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkbookRepoService>;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    oauthService = {
      getValidAccessToken: jest.fn().mockResolvedValue(''),
    } as unknown as jest.Mocked<OAuthService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    controller = new CodeMigrationsController(
      dbService,
      workbookRepoService,
      credentialEncryptionService,
      oauthService,
      auditLogService,
    );
  });

  describe('getAvailableMigrations', () => {
    it('returns init-workbook-repos with a description', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      const descriptor = result.migrations.find((m) => m.name === 'init-workbook-repos');
      expect(descriptor).toBeDefined();
      expect(descriptor!.description.length).toBeGreaterThan(0);
    });

    it('returns notion-data-source-backfill with a description', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      const descriptor = result.migrations.find((m) => m.name === 'notion-data-source-backfill');
      expect(descriptor).toBeDefined();
      expect(descriptor!.description.length).toBeGreaterThan(0);
    });

    it('rejects non-admin users', () => {
      expect(() => controller.getAvailableMigrations(makeReqWithUser(false))).toThrow(UnauthorizedException);
    });
  });

  describe('runMigration - init-workbook-repos', () => {
    it('initializes repos for workbooks by qty', async () => {
      const workbooks = [makeWorkbook('wkb_1', 'org_a'), makeWorkbook('wkb_2', 'org_b')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(2);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        qty: 10,
      });

      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledTimes(2);
      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledWith('org_a', 'wkb_1');
      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledWith('org_b', 'wkb_2');
      expect(result.migratedIds).toEqual(['wkb_1', 'wkb_2']);
      expect(result.migrationName).toBe('init-workbook-repos');
    });

    it('initializes repos for specific workbook ids', async () => {
      const workbooks = [makeWorkbook('wkb_specific')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(5);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        ids: ['wkb_specific'],
      });

      expect(dbService.client.workbook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['wkb_specific'] } } }),
      );
      expect(result.migratedIds).toEqual(['wkb_specific']);
      expect(result.remainingCount).toBe(4);
    });

    it('continues on individual failures', async () => {
      const workbooks = [makeWorkbook('wkb_ok'), makeWorkbook('wkb_fail'), makeWorkbook('wkb_ok2')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(3);

      workbookRepoService.initWorkbookRepo = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('git down'))
        .mockResolvedValueOnce(undefined);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        qty: 10,
      });

      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledTimes(3);
      expect(result.migratedIds).toEqual(['wkb_ok', 'wkb_ok2']);
    });

    it('rejects non-admin users', async () => {
      await expect(
        controller.runMigration(makeReqWithUser(false), {
          migration: 'init-workbook-repos',
          qty: 1,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects unknown migration', async () => {
      await expect(
        controller.runMigration(makeReqWithUser(), {
          migration: 'does-not-exist',
          qty: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // The per-folder decision tree is covered exhaustively in
  // notion-data-source-backfill.spec.ts. These tests cover only the orchestration
  // layer: the DB query shape, migratedIds composition, and remainingCount math.
  describe('runMigration - notion-data-source-backfill', () => {
    function makeNotionFolderRow(overrides: {
      id: string;
      tableId: string[];
      connectorAccountId?: string | null;
      organizationId?: string;
    }) {
      // Use `in` rather than `??` so an explicit `null` is preserved (the
      // orphan-folder test case relies on it).
      const connectorAccountId = 'connectorAccountId' in overrides ? overrides.connectorAccountId : 'cna_a';
      return {
        id: overrides.id,
        name: `Folder ${overrides.id}`,
        workbookId: 'wbk_a',
        connectorAccountId,
        connectorService: 'NOTION',
        tableId: overrides.tableId,
        workbook: { organizationId: overrides.organizationId ?? 'org_a' },
      };
    }

    it('queries DataFolders filtered to connectorService = NOTION (qty mode)', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]);

      await controller.runMigration(makeReqWithUser(), { migration: 'notion-data-source-backfill', qty: 5 });

      // First call: fetch folders to process.
      expect(dbService.client.dataFolder.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { connectorService: 'NOTION' },
          take: 5,
        }),
      );
    });

    it('queries DataFolders filtered to workbookId + NOTION when ids supplied', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]);

      await controller.runMigration(makeReqWithUser(), {
        migration: 'notion-data-source-backfill',
        ids: ['wkb_a', 'wkb_b'],
      });

      expect(dbService.client.dataFolder.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { workbookId: { in: ['wkb_a', 'wkb_b'] }, connectorService: 'NOTION' },
        }),
      );
    });

    it('skips folders that already have a 2-element tableId without calling Notion', async () => {
      // Already-backfilled folder — backfillNotionFolder returns
      // `skipped_already_backfilled` before any deps.fetchDataSources call.
      const row = makeNotionFolderRow({ id: 'fld_done', tableId: ['db_a', 'ds_a'] });
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([row]) // processing pass
        .mockResolvedValueOnce([{ tableId: ['db_a', 'ds_a'] }]); // remaining-count pass

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'notion-data-source-backfill',
        ids: ['fld_done'],
      });

      // The already-backfilled folder is not counted as migrated; the connector
      // account is never even looked up (no Notion client built).
      expect(result.migratedIds).toEqual([]);
      expect(dbService.client.connectorAccount.findUnique).not.toHaveBeenCalled();
      expect(dbService.client.dataFolder.update).not.toHaveBeenCalled();
    });

    it('marks folder migrated when single-source rewrite succeeds', async () => {
      const row = makeNotionFolderRow({ id: 'fld_single', tableId: ['db_a'] });
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([{ tableId: ['db_a', 'ds_a'] }]); // post-run state

      // Mock the connector account + Notion fetch. USER_PROVIDED_PARAMS skips
      // the OAuth path; decryptCredentials returns an apiKey; the Notion call
      // is intercepted via the global fetch mock below.
      dbService.client.connectorAccount.findUnique = jest.fn().mockResolvedValue({
        id: 'cna_a',
        authType: 'USER_PROVIDED_PARAMS',
        encryptedCredentials: {},
      });
      credentialEncryptionService.decryptCredentials = jest.fn().mockResolvedValue({ apiKey: 'ntn_test' });

      // Intercept the Notion SDK's underlying fetch. The Client uses global
      // fetch under the hood; returning a single data source produces the
      // single_source_rewritten branch.
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            object: 'database',
            id: 'db_a',
            data_sources: [{ id: 'ds_a', name: 'Source A' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'notion-data-source-backfill',
        ids: ['fld_single'],
      });

      expect(result.migratedIds).toEqual(['fld_single']);
      expect(result.migrationName).toBe('notion-data-source-backfill');
      // The folder was rewritten with the 2-element tableId.
      expect(dbService.client.dataFolder.update).toHaveBeenCalledWith({
        where: { id: 'fld_single' },
        data: { tableId: ['db_a', 'ds_a'] },
      });
      // One audit entry tagged with the backfill marker.
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
      expect(auditLogService.logEvent.mock.calls[0][0].context).toMatchObject({
        marker: 'notion_multisource_backfill',
        action: 'rewrite_tableid',
      });

      fetchSpy.mockRestore();
    });

    it('errors out on folders without a connectorAccountId rather than crashing the run', async () => {
      const row = makeNotionFolderRow({ id: 'fld_orphan', tableId: ['db_a'], connectorAccountId: null });
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'notion-data-source-backfill',
        ids: ['fld_orphan'],
      });

      expect(result.migratedIds).toEqual([]);
      expect(dbService.client.connectorAccount.findUnique).not.toHaveBeenCalled();
    });

    it('computes remainingCount from the post-run filter (tableId.length < 2)', async () => {
      // Returns 3 folders total in the "all NOTION folders" query, 2 of which
      // are still 1-element after the run.
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([]) // processing pass — nothing to do
        .mockResolvedValueOnce([{ tableId: ['x'] }, { tableId: ['y', 'z'] }, { tableId: ['w'] }]);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'notion-data-source-backfill',
        qty: 1,
      });

      expect(result.remainingCount).toBe(2);
    });
  });
});
