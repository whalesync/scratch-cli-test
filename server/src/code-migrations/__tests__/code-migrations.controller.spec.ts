/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { OAuthService } from 'src/oauth/oauth.service';
import { NotionApiClient } from 'src/remote-service/connectors/library/notion/notion-api-client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { CodeMigrationsController } from '../code-migrations.controller';
import { ConnectionDrainTimeoutError, ConnectionQuiesceService } from '../connection-quiesce.service';

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
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let connectionQuiesceService: jest.Mocked<ConnectionQuiesceService>;
  let metricsService: jest.Mocked<CustomMetricsService>;

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
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        sync: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        fileIndex: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        fileReference: {
          count: jest.fn().mockResolvedValue(0),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('repo-1'),
      moveFolder: jest.fn().mockResolvedValue({ moved: true }),
    } as unknown as jest.Mocked<ScratchGitService>;

    connectionQuiesceService = {
      quiesceConnection: jest.fn().mockResolvedValue({ cancelledPublishPlans: 0, cancelledJobs: 0 }),
      unquiesceConnection: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionQuiesceService>;

    metricsService = {
      logValue: jest.fn(),
      withLoggedExecTime: jest.fn(),
      withLoggedExecTimeForConnector: jest.fn(),
    } as unknown as jest.Mocked<CustomMetricsService>;

    controller = new CodeMigrationsController(
      dbService,
      workbookRepoService,
      credentialEncryptionService,
      oauthService,
      auditLogService,
      scratchGitService,
      connectionQuiesceService,
      metricsService,
    );
  });

  describe('getAvailableMigrations', () => {
    it('returns init-workbook-repos with a description', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      const descriptor = result.migrations.find((m) => m.name === 'init-workbook-repos');
      expect(descriptor).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(descriptor!.description.length).toBeGreaterThan(0);
    });

    it('returns notion-data-source-backfill with a description', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      const descriptor = result.migrations.find((m) => m.name === 'notion-data-source-backfill');
      expect(descriptor).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(descriptor!.description.length).toBeGreaterThan(0);
    });

    it('returns sync-mapping-v2-backfill with a description', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      const descriptor = result.migrations.find((m) => m.name === 'sync-mapping-v2-backfill');
      expect(descriptor).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(descriptor!.description.length).toBeGreaterThan(0);
    });

    it('flags only the webflow folder migrations as dry-run capable', () => {
      const { migrations } = controller.getAvailableMigrations(makeReqWithUser());
      const supportsDryRun = (name: string) => migrations.find((m) => m.name === name)?.supportsDryRun;

      expect(supportsDryRun('webflow-folder-restructure')).toBe(true);
      expect(supportsDryRun('webflow-folder-restructure-inverse')).toBe(true);
      expect(supportsDryRun('init-workbook-repos')).toBe(false);
      expect(supportsDryRun('notion-data-source-backfill')).toBe(false);
      expect(supportsDryRun('sync-mapping-v2-backfill')).toBe(false);
    });

    it('rejects non-admin users', () => {
      expect(() => controller.getAvailableMigrations(makeReqWithUser(false))).toThrow(UnauthorizedException);
    });
  });

  // A dry-run must only be accepted for a migration that actually honors it —
  // otherwise a user could believe they dry-ran a migration that wrote for real.
  describe('runMigration - dry-run gating', () => {
    it('rejects dryRun for a migration that does not support it', async () => {
      await expect(
        controller.runMigration(makeReqWithUser(), {
          migration: 'init-workbook-repos',
          ids: ['wkb_1'],
          dryRun: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('runMigration - fileindex-filereference-orphan-gc (DEV-10885 Phase B)', () => {
    it('deletes only orphan folderPaths (no live owner) and their refs, preserving live rows', async () => {
      // /Contacts is live; DeadConn/Issues has no live DataFolder → orphan.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([{ path: '/Contacts' }]);
      dbService.client.fileIndex.findMany = jest
        .fn()
        // 1st call = pass 1 (distinct folderPaths); 2nd = pass 2 (slash-bearing recordIds, none here)
        .mockResolvedValueOnce([{ folderPath: 'Contacts' }, { folderPath: 'DeadConn/Issues' }])
        .mockResolvedValue([]);
      dbService.client.fileIndex.deleteMany = jest.fn().mockResolvedValue({ count: 5 });
      dbService.client.fileReference.deleteMany = jest.fn().mockResolvedValue({ count: 3 });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: 'wkb_1', folderPath: { in: ['DeadConn/Issues'] } },
      });
      expect(dbService.client.fileReference.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: 'wkb_1', sourceFilePath: { startsWith: 'DeadConn/Issues/' } },
      });
      expect(result.dryRun).toBe(false);
      expect(result.summary).toEqual([
        { label: 'FileIndex orphan rows deleted', count: 5 },
        { label: 'FileReference orphan rows deleted', count: 3 },
        { label: 'DEV-11015 split-recordId artifact rows deleted', count: 0 },
        { label: 'Orphan folderPaths (no live DataFolder owner)', count: 1 },
        { label: 'Workbooks processed', count: 1 },
      ]);
    });

    it('deletes FileReference before FileIndex so a partially-failed live run stays resumable', async () => {
      // The orphan set is derived solely from FileIndex.folderPath and the deletes are not one
      // transaction, so the FileIndex delete has to come LAST: if it went first, a crash partway
      // through the (much larger) FileReference pass would leave orphan refs that a retry could no
      // longer identify, because the folderPaths naming them are gone from FileIndex.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]); // no live folders
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ folderPath: 'DeadConn/Issues' }])
        .mockResolvedValue([]);

      const deleteCallOrderByTable: string[] = [];
      dbService.client.fileIndex.deleteMany = jest.fn().mockImplementation(() => {
        deleteCallOrderByTable.push('fileIndex');
        return Promise.resolve({ count: 5 });
      });
      dbService.client.fileReference.deleteMany = jest.fn().mockImplementation(() => {
        deleteCallOrderByTable.push('fileReference');
        return Promise.resolve({ count: 3 });
      });

      await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
      });

      expect(deleteCallOrderByTable).toEqual(['fileReference', 'fileIndex']);
    });

    it('deletes DEV-11015 split-recordId artifact rows that pass 1 cannot reach', async () => {
      // /Product Media is LIVE, so the orphan rule owns (and spares) everything beneath it —
      // including the artifact row, which is why pass 2 has to be row-level.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([{ path: '/Product Media' }]);
      dbService.client.fileIndex.findMany = jest
        .fn()
        // pass 1: distinct folderPaths — both have a live owner, so nothing is an orphan
        .mockResolvedValueOnce([
          { folderPath: 'Product Media' },
          { folderPath: 'Product Media/gid://shopify/MediaImage' },
        ])
        // pass 2: the workbook's slash-bearing-recordId rows
        .mockResolvedValueOnce([
          {
            id: 'fi_artifact',
            folderPath: 'Product Media/gid://shopify/MediaImage',
            filename: '38012599304435.json',
            recordId: 'gid://shopify/MediaImage/38012599304435',
          },
          {
            id: 'fi_live',
            folderPath: 'Product Media',
            filename: 'gid-shopify-MediaImage-38012599304435.json',
            recordId: 'gid://shopify/MediaImage/38012599304435',
          },
        ]);
      dbService.client.fileIndex.deleteMany = jest.fn().mockResolvedValue({ count: 1 });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
      });

      // Only the artifact row's id is deleted — the correctly-indexed live row is spared,
      // and pass 1 found no orphan folderPaths to delete at all.
      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledTimes(1);
      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['fi_artifact'] } },
      });
      expect(result.summary).toContainEqual({
        label: 'DEV-11015 split-recordId artifact rows deleted',
        count: 1,
      });
    });

    it('does not double-count a row that is BOTH an orphan and a split-recordId artifact', async () => {
      // A deleted Shopify connection: its folder is an orphan AND holds artifact rows.
      // On a dry-run nothing is deleted, so without the pass-1 exclusion pass 2 would
      // flag the same row again and the pre-flight total would read 2 for 1 real row —
      // disagreeing with the live run, where pass 1's delete lands first.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]); // no live folders
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ folderPath: 'Shop/Product Media/gid://shopify/MediaImage' }])
        .mockResolvedValueOnce([
          {
            id: 'fi_both',
            folderPath: 'Shop/Product Media/gid://shopify/MediaImage',
            filename: '123.json',
            recordId: 'gid://shopify/MediaImage/123',
          },
        ]);
      dbService.client.fileIndex.count = jest.fn().mockResolvedValue(1);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
        dryRun: true,
      });

      // Counted once, by pass 1 only — and remainingCount (both passes) agrees.
      expect(result.summary).toContainEqual({ label: 'FileIndex orphan rows that would be deleted', count: 1 });
      expect(result.summary).toContainEqual({
        label: 'DEV-11015 split-recordId artifact rows that would be deleted',
        count: 0,
      });
      expect(result.remainingCount).toBe(1);
    });

    it('writes nothing on a dry-run and reports the would-delete totals', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([{ path: '/Contacts' }]);
      dbService.client.fileIndex.findMany = jest
        .fn()
        // 1st call = pass 1 (distinct folderPaths); 2nd = pass 2 (slash-bearing recordIds, none here)
        .mockResolvedValueOnce([{ folderPath: 'Contacts' }, { folderPath: 'DeadConn/Issues' }])
        .mockResolvedValue([]);
      dbService.client.fileIndex.count = jest.fn().mockResolvedValue(5);
      dbService.client.fileReference.count = jest.fn().mockResolvedValue(3);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
        dryRun: true,
      });

      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(dbService.client.fileReference.deleteMany).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
      expect(result.remainingCount).toBe(5); // would-delete FileIndex total, since nothing was written
      expect(result.summary?.[0]).toEqual({ label: 'FileIndex orphan rows that would be deleted', count: 5 });
    });

    it('does not double-count FileReference on a dry-run when orphan folderPaths are nested', async () => {
      // Dead Shopify connection: both the folder and its slash-bearing GID sub-path are orphans.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]); // no live folders
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValueOnce([
          { folderPath: 'Shop/Product Variants' },
          { folderPath: 'Shop/Product Variants/gid://x' },
        ])
        .mockResolvedValue([]);
      dbService.client.fileReference.count = jest.fn().mockResolvedValue(4);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
        dryRun: true,
      });

      // Only the ROOT folder's subtree is counted (once); the nested orphan is covered by it, so the
      // would-delete total is 4 — not 8 — matching what a live run would actually delete.
      expect(dbService.client.fileReference.count).toHaveBeenCalledTimes(1);
      expect(dbService.client.fileReference.count).toHaveBeenCalledWith({
        where: { workbookId: 'wkb_1', sourceFilePath: { startsWith: 'Shop/Product Variants/' } },
      });
      expect(result.summary?.[1]).toEqual({ label: 'FileReference orphan rows that would be deleted', count: 4 });
    });

    it('escapes SQL LIKE wildcards in an orphan folderPath so a `_` cannot over-match refs', async () => {
      // snake_case folder name: the `_` must be escaped or LIKE would treat it as a wildcard.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]); // no live folders
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ folderPath: 'DeadConn/product_variants' }])
        .mockResolvedValue([]);
      dbService.client.fileReference.deleteMany = jest.fn().mockResolvedValue({ count: 2 });

      await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileReference.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: 'wkb_1', sourceFilePath: { startsWith: 'DeadConn/product\\_variants/' } },
      });
    });

    it('excludes a live child folder nested under an orphan parent from the FileReference delete', async () => {
      // Reconnect recreated the nested child /DeadConn/Issues/fr but not its parent.
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([{ path: '/DeadConn/Issues/fr' }]);
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ folderPath: 'DeadConn/Issues' }, { folderPath: 'DeadConn/Issues/fr' }])
        .mockResolvedValue([]);
      dbService.client.fileIndex.deleteMany = jest.fn().mockResolvedValue({ count: 2 });
      dbService.client.fileReference.deleteMany = jest.fn().mockResolvedValue({ count: 1 });

      await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-filereference-orphan-gc',
        ids: ['wkb_1'],
      });

      // FileIndex: exact-match IN on the orphan parent only — the live child's distinct folderPath is untouched.
      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: 'wkb_1', folderPath: { in: ['DeadConn/Issues'] } },
      });
      // FileReference: prefix delete under the orphan parent, excluding the live child's subtree.
      expect(dbService.client.fileReference.deleteMany).toHaveBeenCalledWith({
        where: {
          workbookId: 'wkb_1',
          sourceFilePath: { startsWith: 'DeadConn/Issues/' },
          AND: [{ NOT: { sourceFilePath: { startsWith: 'DeadConn/Issues/fr/' } } }],
        },
      });
    });
  });

  describe('runMigration - fileindex-unscoped-row-resolve (DEV-11242)', () => {
    // Two connections both expose a `Pages` folder — the case the path-based backfill
    // cannot decide, so ownership comes from which repo actually holds the file.
    const twoConnectionsSharingPages = [
      { path: '/Pages', connectorAccountId: 'coa_shopify' },
      { path: '/Pages', connectorAccountId: 'coa_wordpress' },
    ];

    /** Mock repo listings keyed by `${connectorAccountId}|${branch}`. */
    /**
     * Mock repo listings keyed by `${connectorAccountId}|${branch}`. A ROOT listing
     * (folder === '') is the repo-readability probe, not a folder listing: by default
     * every connection reports the `.scratch` directory there, i.e. "readable". Naming a
     * connection in `unreadableConnections` makes its root list empty — which is how
     * scratch-git reports a missing repo (404, swallowed to []) or an unresolvable branch.
     */
    function mockRepoFilenames(
      filenamesByConnectionAndBranch: Record<string, string[]>,
      options: { unreadableConnections?: string[] } = {},
    ) {
      scratchGitService.resolveConnectionRepoPath = jest
        .fn()
        .mockImplementation((connectorAccountId: string) => Promise.resolve(`repo/${connectorAccountId}`));
      scratchGitService.listRepoFiles = jest
        .fn()
        .mockImplementation((repoId: string, branch: string, folder: string) => {
          const connectorAccountId = repoId.replace('repo/', '');
          if (folder === '') {
            return Promise.resolve(
              options.unreadableConnections?.includes(connectorAccountId)
                ? []
                : [{ name: '.scratch', path: '.scratch', type: 'directory' as const }],
            );
          }
          const filenames = filenamesByConnectionAndBranch[`${connectorAccountId}|${branch}`] ?? [];
          return Promise.resolve(filenames.map((name) => ({ name, path: `${folder}/${name}`, type: 'file' as const })));
        });
    }

    beforeEach(() => {
      dbService.client.fileIndex.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue(twoConnectionsSharingPages);
    });

    it('scopes a row to the one connection whose repo holds the file', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_1', folderPath: 'Pages', filename: 'masthead.json', recordId: '1411' }]);
      dbService.client.fileIndex.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      mockRepoFilenames({ 'coa_wordpress|main': ['masthead.json'], 'coa_shopify|main': ['contact.json'] });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['fi_1'] }, connectorAccountId: null },
        data: { connectorAccountId: 'coa_wordpress' },
      });
      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(result.summary?.[0]).toEqual({
        label: 'Unscoped rows scoped to their owning connection',
        count: 1,
      });
    });

    it('deletes a row only after neither main nor dirty holds the file', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_dead', folderPath: 'Pages', filename: 'gone.json', recordId: '27802' }]);
      dbService.client.fileIndex.deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      mockRepoFilenames({});

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      // Both branches consulted for both claimants before concluding the file is gone.
      const probedBranches = (scratchGitService.listRepoFiles as jest.Mock).mock.calls.map(
        (call: [string, string, string]) => call[1],
      );
      expect(probedBranches).toContain('main');
      expect(probedBranches).toContain('dirty');
      expect(dbService.client.fileIndex.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['fi_dead'] }, connectorAccountId: null },
      });
      expect(result.summary?.[1]).toEqual({
        label: 'Dead rows deleted (file gone from every claimant repo)',
        count: 1,
      });
    });

    // A row under a connector-less (scratch) folder — or under no live folder at all — has
    // no repo to probe, so "no claimant holds it" is meaningless. Deleting it would wipe
    // the one legitimately-NULL population this very change documents, and would poach the
    // orphan GC's rows (47,113 of them on the test DB) without its FileReference sweep.
    it('leaves a row alone when no connector-backed folder owns its path', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]);
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_scratch', folderPath: 'Notes', filename: 'idea.json', recordId: 'rec_1' }]);
      mockRepoFilenames({});

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.updateMany).not.toHaveBeenCalled();
      // No repo was probed at all — there was no connection to probe.
      expect(scratchGitService.listRepoFiles).not.toHaveBeenCalled();
      expect(result.summary?.[3]).toEqual({
        label:
          'Rows left untouched (no connector folder owns the path — scratch folder, or an orphan for the orphan GC)',
        count: 1,
      });
    });

    it('keeps a row a dirty-only file points at, rather than deleting it', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_dirty', folderPath: 'Pages', filename: 'draft.json', recordId: '7' }]);
      dbService.client.fileIndex.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      mockRepoFilenames({ 'coa_shopify|dirty': ['draft.json'] });

      await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['fi_dirty'] }, connectorAccountId: null },
        data: { connectorAccountId: 'coa_shopify' },
      });
    });

    it('scopes a row both connections hold when the two files are identical', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_dup', folderPath: 'Pages', filename: 'same.json', recordId: 'rec_1' }]);
      dbService.client.fileIndex.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      mockRepoFilenames({ 'coa_shopify|main': ['same.json'], 'coa_wordpress|main': ['same.json'] });
      scratchGitService.getRepoFile = jest.fn().mockResolvedValue({ content: '{"id":"rec_1"}' });

      await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      // Lowest connectorAccountId of the two identical candidates.
      expect(dbService.client.fileIndex.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['fi_dup'] }, connectorAccountId: null },
        data: { connectorAccountId: 'coa_shopify' },
      });
    });

    it('leaves a row NULL, and writes nothing, when the two connections hold DIFFERENT files', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_amb', folderPath: 'Pages', filename: 'clash.json', recordId: 'rec_1' }]);
      mockRepoFilenames({ 'coa_shopify|main': ['clash.json'], 'coa_wordpress|main': ['clash.json'] });
      scratchGitService.getRepoFile = jest
        .fn()
        .mockResolvedValueOnce({ content: '{"id":"rec_1"}' })
        .mockResolvedValueOnce({ content: '{"id":"rec_999"}' });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.updateMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(result.summary?.[2]).toEqual({
        label: 'Rows left NULL (several connections hold a DIFFERENT file at that path)',
        count: 1,
      });
    });

    // scratch-git reports a missing repo (404, swallowed to []) and an unresolvable branch
    // (200 with []) as EMPTY listings rather than errors, so nothing throws and the
    // try/catch below can't see them. Without the root-listing readability probe this row
    // would classify as dead and be deleted, even though its repo was never readable.
    it('skips the workbook rather than deleting when a claimant repo lists empty at the root', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_1', folderPath: 'Pages', filename: 'masthead.json', recordId: '1411' }]);
      mockRepoFilenames({}, { unreadableConnections: ['coa_shopify', 'coa_wordpress'] });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.updateMany).not.toHaveBeenCalled();
      expect(result.summary?.[4]).toEqual({
        label: 'Workbooks skipped without changes (could not probe/classify their rows)',
        count: 1,
      });
    });

    // A failed repo read looks exactly like "no claimant holds the file"; treating it that
    // way would delete live rows, so the whole workbook is skipped without any write.
    it('skips the workbook without writing when a connection repo cannot be read', async () => {
      dbService.client.fileIndex.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'fi_1', folderPath: 'Pages', filename: 'masthead.json', recordId: '1411' }]);
      scratchGitService.resolveConnectionRepoPath = jest.fn().mockResolvedValue('repo/coa_wordpress');
      scratchGitService.listRepoFiles = jest.fn().mockRejectedValue(new Error('git service unreachable'));

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
      });

      expect(dbService.client.fileIndex.updateMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(result.migratedIds).toEqual([]);
      expect(result.summary?.[4]).toEqual({
        label: 'Workbooks skipped without changes (could not probe/classify their rows)',
        count: 1,
      });
    });

    it('writes nothing on a dry-run but still reports what it would do', async () => {
      dbService.client.fileIndex.findMany = jest.fn().mockResolvedValue([
        { id: 'fi_1', folderPath: 'Pages', filename: 'masthead.json', recordId: '1411' },
        { id: 'fi_dead', folderPath: 'Pages', filename: 'gone.json', recordId: '27802' },
      ]);
      mockRepoFilenames({ 'coa_wordpress|main': ['masthead.json'] });

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'fileindex-unscoped-row-resolve',
        ids: ['wkb_1'],
        dryRun: true,
      });

      expect(dbService.client.fileIndex.updateMany).not.toHaveBeenCalled();
      expect(dbService.client.fileIndex.deleteMany).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
      expect(result.summary?.[0]).toEqual({
        label: 'Unscoped rows that would be scoped to their owning connection',
        count: 1,
      });
      expect(result.summary?.[1]).toEqual({
        label: 'Dead rows that would be deleted (file gone from every claimant repo)',
        count: 1,
      });
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
      // is intercepted via the api-client spy below.
      dbService.client.connectorAccount.findUnique = jest.fn().mockResolvedValue({
        id: 'cna_a',
        authType: 'USER_PROVIDED_PARAMS',
        encryptedCredentials: {},
      });
      credentialEncryptionService.decryptCredentials = jest.fn().mockResolvedValue({ apiKey: 'ntn_test' });

      // Intercept the api-client's `retrieveDatabase`. Returning a single data
      // source produces the single_source_rewritten branch (the real
      // `isFullDatabase` guard passes on `object: 'database'`).
      const retrieveDatabaseSpy = jest.spyOn(NotionApiClient.prototype, 'retrieveDatabase').mockResolvedValue({
        object: 'database',
        id: 'db_a',
        data_sources: [{ id: 'ds_a', name: 'Source A' }],
      } as unknown as Awaited<ReturnType<NotionApiClient['retrieveDatabase']>>);

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

      retrieveDatabaseSpy.mockRestore();
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

  // The per-row transform/CAS/audit decisions are covered exhaustively in
  // sync-mapping-v2-backfill.spec.ts. These tests cover only the orchestration
  // layer: the candidate query shape, migratedIds composition, remainingCount,
  // and metric emission.
  describe('runMigration - sync-mapping-v2-backfill', () => {
    function makeSyncRow(id: string) {
      return {
        id,
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src',
              destinationDataFolderId: 'dfd_dest',
              columnMappings: [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
            },
          ],
        },
        workbook: { organizationId: 'org_a' },
      };
    }

    it('transforms syncs with mappingsV2 IS NULL and writes via compare-and-set (qty mode)', async () => {
      dbService.client.sync.findMany = jest.fn().mockResolvedValue([makeSyncRow('syn_1'), makeSyncRow('syn_2')]);
      dbService.client.sync.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      dbService.client.sync.count = jest.fn().mockResolvedValue(3);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'sync-mapping-v2-backfill',
        qty: 5,
      });

      // Candidate query: un-migrated rows only, oldest-first, capped at qty.
      expect(dbService.client.sync.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mappingsV2: { equals: Prisma.DbNull } },
          take: 5,
          orderBy: { createdAt: 'asc' },
        }),
      );
      // Compare-and-set write per row, guarded on id + updatedAt + mappingsV2 null.
      expect(dbService.client.sync.updateMany).toHaveBeenCalledTimes(2);
      expect(dbService.client.sync.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'syn_1',
            updatedAt: new Date('2026-05-01T00:00:00.000Z'),
            mappingsV2: { equals: Prisma.DbNull },
          },
        }),
      );
      expect(result.migratedIds).toEqual(['syn_1', 'syn_2']);
      expect(result.remainingCount).toBe(3);
      expect(result.migrationName).toBe('sync-mapping-v2-backfill');
      // One audit per migrated row.
      expect(auditLogService.logEvent).toHaveBeenCalledTimes(2);
      // Metrics: transformed count + remaining gauge.
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL, 2);
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING, 3);
    });

    it('targets specific sync ids (ids mode)', async () => {
      dbService.client.sync.findMany = jest.fn().mockResolvedValue([makeSyncRow('syn_x')]);
      dbService.client.sync.count = jest.fn().mockResolvedValue(0);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'sync-mapping-v2-backfill',
        ids: ['syn_x'],
      });

      expect(dbService.client.sync.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['syn_x'] }, mappingsV2: { equals: Prisma.DbNull } },
        }),
      );
      expect(result.migratedIds).toEqual(['syn_x']);
      expect(result.remainingCount).toBe(0);
    });

    it('does not count a row as migrated when the compare-and-set affects 0 rows', async () => {
      dbService.client.sync.findMany = jest.fn().mockResolvedValue([makeSyncRow('syn_busy')]);
      // A concurrent save / parallel batch populated mappingsV2 first.
      dbService.client.sync.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      dbService.client.sync.count = jest.fn().mockResolvedValue(1);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'sync-mapping-v2-backfill',
        qty: 1,
      });

      expect(result.migratedIds).toEqual([]);
      expect(auditLogService.logEvent).not.toHaveBeenCalled();
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL, 0);
    });

    it('isolates a compare-and-set failure to its row and continues the batch', async () => {
      dbService.client.sync.findMany = jest.fn().mockResolvedValue([makeSyncRow('syn_boom'), makeSyncRow('syn_ok')]);
      // First row's write throws (e.g. a deadlock); second succeeds.
      dbService.client.sync.updateMany = jest
        .fn()
        .mockRejectedValueOnce(new Error('deadlock'))
        .mockResolvedValueOnce({ count: 1 });
      dbService.client.sync.count = jest.fn().mockResolvedValue(1);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'sync-mapping-v2-backfill',
        qty: 5,
      });

      // The throw is caught and isolated to syn_boom; the batch still migrates syn_ok.
      expect(dbService.client.sync.updateMany).toHaveBeenCalledTimes(2);
      expect(result.migratedIds).toEqual(['syn_ok']);
    });

    it('migrates the row even if its audit-log write fails (audit is best-effort)', async () => {
      dbService.client.sync.findMany = jest.fn().mockResolvedValue([makeSyncRow('syn_a')]);
      dbService.client.sync.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      dbService.client.sync.count = jest.fn().mockResolvedValue(0);
      auditLogService.logEvent = jest.fn().mockRejectedValue(new Error('audit DB down'));

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'sync-mapping-v2-backfill',
        qty: 1,
      });

      // The CAS write succeeded, so the row counts as migrated despite the audit failure.
      expect(result.migratedIds).toEqual(['syn_a']);
    });
  });

  // Per-folder decision logic is covered in webflow-folder-restructure-backfill.spec.ts.
  // These cover the orchestration layer's candidate selection — specifically that
  // every run is account-atomic, the property that prevents the qty-batch-split
  // move-ordering wedge for a collection literally named "Collections".
  describe('runMigration - webflow-folder-restructure', () => {
    it('qty mode seeds with qty, then expands to every seeded account in full (no take limit)', async () => {
      const seedRows = [
        { connectorAccountId: 'acct_1' },
        { connectorAccountId: 'acct_2' },
        { connectorAccountId: 'acct_1' },
      ];
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce(seedRows) // seed (select connectorAccountId, take: qty)
        .mockResolvedValue([]); // account expansion + remaining-count

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        qty: 2,
      });

      const findManyCalls = (dbService.client.dataFolder.findMany as jest.Mock).mock.calls as Array<
        [{ where?: Record<string, unknown>; take?: number }]
      >;
      // 1st call is the qty-bounded seed.
      expect(findManyCalls[0][0]).toEqual(expect.objectContaining({ take: 2 }));
      // 2nd call expands to the DISTINCT seeded accounts, with NO take limit.
      const expansionArgs = findManyCalls[1][0];
      expect(expansionArgs.where).toEqual(
        expect.objectContaining({ connectorAccountId: { in: ['acct_1', 'acct_2'] } }),
      );
      expect(expansionArgs.take).toBeUndefined();
      expect(result.migrationName).toBe('webflow-folder-restructure');
    });

    it('ids mode targets whole workbooks with no take limit (accounts never split)', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]);

      await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        ids: ['wkb_1'],
      });

      const candidateArgs = (
        (dbService.client.dataFolder.findMany as jest.Mock).mock.calls as Array<
          [{ where?: Record<string, unknown>; take?: number }]
        >
      )[0][0];
      expect(candidateArgs.where).toEqual(expect.objectContaining({ workbookId: { in: ['wkb_1'] } }));
      expect(candidateArgs.take).toBeUndefined();
    });

    it('counts a folder as migrated even if its audit-log write fails (audit is best-effort)', async () => {
      // A real CMS collection still on the flat layout.
      const folderRow = {
        id: 'fld_blog',
        workbookId: 'wkb_1',
        connectorAccountId: 'acct_1',
        name: 'Blog Posts',
        path: '/My Site/Blog Posts',
        version: 1,
        tableId: ['site-1', 'collection-abc'],
        workbook: { organizationId: 'org_1' },
      };
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([{ connectorAccountId: 'acct_1' }]) // qty seed
        .mockResolvedValueOnce([folderRow]) // account expansion
        .mockResolvedValue([]); // flip count + remaining count
      dbService.client.dataFolder.findFirst = jest.fn().mockResolvedValue(null); // ensureUniquePath: no collision

      // The atomic executor: invoke the $transaction callback with a tx stub that
      // no-ops every write, simulating a successful commit at version 2.
      const txStub = {
        dataFolder: { update: jest.fn().mockResolvedValue(undefined) },
        fileIndex: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        syncTablePair: { findMany: jest.fn().mockResolvedValue([]) },
        recreatedIdMap: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      dbService.client.$transaction = jest
        .fn()
        .mockImplementation((cb: (tx: typeof txStub) => Promise<unknown>) =>
          cb(txStub),
        ) as unknown as typeof dbService.client.$transaction;

      // Audit write fails AFTER the move + path/version rewrite have committed.
      auditLogService.logEvent = jest.fn().mockRejectedValue(new Error('audit DB down'));

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        qty: 1,
      });

      // The folder is fully migrated, so the audit failure must NOT drop it from
      // migratedIds or flip it to errored.
      expect(result.migratedIds).toEqual(['fld_blog']);
      expect(txStub.dataFolder.update).toHaveBeenCalledTimes(1);
    });

    // T4: a non-dry-run wraps each account in a quiesce/release pair and flips the
    // account only after its folders have moved (while still locked).
    function seedOneFlatCollection() {
      const folderRow = {
        id: 'fld_blog',
        workbookId: 'wkb_1',
        connectorAccountId: 'acct_1',
        name: 'Blog Posts',
        path: '/My Site/Blog Posts',
        version: 1,
        tableId: ['site-1', 'collection-abc'],
        workbook: { organizationId: 'org_1' },
      };
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([folderRow]) // ids mode: candidate folders
        .mockResolvedValue([]); // flip count + remaining count → 0 flat left
      dbService.client.dataFolder.findFirst = jest.fn().mockResolvedValue(null);
      dbService.client.connectorAccount.findMany = jest.fn().mockResolvedValue([]); // no stuck accounts
      const txStub = {
        dataFolder: { update: jest.fn().mockResolvedValue(undefined) },
        fileIndex: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        syncTablePair: { findMany: jest.fn().mockResolvedValue([]) },
        recreatedIdMap: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      dbService.client.$transaction = jest
        .fn()
        .mockImplementation((cb: (tx: typeof txStub) => Promise<unknown>) =>
          cb(txStub),
        ) as unknown as typeof dbService.client.$transaction;
    }

    it('quiesces and releases the connection around the migration, then flips it to v2', async () => {
      seedOneFlatCollection();

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        ids: ['wkb_1'],
      });

      expect(connectionQuiesceService.quiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      expect(connectionQuiesceService.unquiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      expect(result.migratedIds).toEqual(['fld_blog']);
      // Flip happens (account had no flat collections left after the move).
      expect(dbService.client.connectorAccount.update).toHaveBeenCalledWith({
        where: { id: 'acct_1' },
        data: { version: 2 },
      });
    });

    it('returns dryRun:false and a per-outcome summary for a real run', async () => {
      seedOneFlatCollection();

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        ids: ['wkb_1'],
      });

      expect(result.dryRun).toBe(false);
      const count = (label: string) => result.summary?.find((row) => row.label === label)?.count;
      expect(count('Migrated to nested layout')).toBe(1);
      expect(count('Accounts flipped to v2 (nested)')).toBe(1);
    });

    it('dry-run reports the would-be move without quiescing, writing, or flipping the account', async () => {
      seedOneFlatCollection();

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        ids: ['wkb_1'],
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      // A dry-run surfaces the would-be moves as `migratedIds` (the folder
      // resolves to `would_migrate`, not `migrated`) but writes nothing.
      expect(result.migratedIds).toEqual(['fld_blog']);
      expect(connectionQuiesceService.quiesceConnection).not.toHaveBeenCalled();
      expect(dbService.client.connectorAccount.update).not.toHaveBeenCalled();
      expect(result.summary?.find((row) => row.label === 'Would migrate to nested layout')?.count).toBe(1);
      // No real-run-only account rows in a dry-run.
      expect(result.summary?.some((row) => row.label.startsWith('Accounts'))).toBe(false);
    });

    it('skips an account whose jobs will not drain in time, releasing it without migrating', async () => {
      seedOneFlatCollection();
      connectionQuiesceService.quiesceConnection = jest
        .fn()
        .mockRejectedValue(new ConnectionDrainTimeoutError('acct_1', 3));

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure',
        ids: ['wkb_1'],
      });

      // The connection is still released (not left locked) ...
      expect(connectionQuiesceService.unquiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      // ... but nothing was migrated or flipped for it this run.
      expect(result.migratedIds).toEqual([]);
      expect(dbService.client.connectorAccount.update).not.toHaveBeenCalled();
    });
  });

  // The inverse / rollback orchestrator (DEV-9698 T6). Per-folder decisions are
  // covered in webflow-folder-restructure-inverse-backfill.spec.ts; these pin the
  // orchestration: nested candidate selection, the quiesce/release wrapper, and the
  // account flip BACK to v1.
  describe('runMigration - webflow-folder-restructure-inverse', () => {
    function seedOneNestedCollection() {
      const folderRow = {
        id: 'fld_blog',
        workbookId: 'wkb_1',
        connectorAccountId: 'acct_1',
        name: 'Blog Posts',
        path: '/My Site/Collections/Blog Posts',
        version: 2,
        tableId: ['site-1', 'collection-abc'],
        workbook: { organizationId: 'org_1' },
      };
      dbService.client.dataFolder.findMany = jest
        .fn()
        .mockResolvedValueOnce([folderRow]) // ids mode: nested candidate folders
        .mockResolvedValue([]); // flip count (nested remaining) + remaining count → 0
      dbService.client.dataFolder.findFirst = jest.fn().mockResolvedValue(null);
      dbService.client.connectorAccount.findMany = jest.fn().mockResolvedValue([]); // no stuck accounts
      const txStub = {
        dataFolder: { update: jest.fn().mockResolvedValue(undefined) },
        fileIndex: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        syncTablePair: { findMany: jest.fn().mockResolvedValue([]) },
        recreatedIdMap: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      dbService.client.$transaction = jest
        .fn()
        .mockImplementation((cb: (tx: typeof txStub) => Promise<unknown>) =>
          cb(txStub),
        ) as unknown as typeof dbService.client.$transaction;
    }

    it('selects nested (version >= 2) folders as candidates in ids mode', async () => {
      dbService.client.dataFolder.findMany = jest.fn().mockResolvedValue([]);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure-inverse',
        ids: ['wkb_1'],
      });

      const candidateArgs = (
        (dbService.client.dataFolder.findMany as jest.Mock).mock.calls as Array<
          [{ where?: Record<string, unknown>; take?: number }]
        >
      )[0][0];
      expect(candidateArgs.where).toEqual(
        expect.objectContaining({ version: { gte: 2 }, workbookId: { in: ['wkb_1'] } }),
      );
      expect(candidateArgs.take).toBeUndefined();
      expect(result.migrationName).toBe('webflow-folder-restructure-inverse');
    });

    it('quiesces and releases the connection around the rollback, then flips it back to v1', async () => {
      seedOneNestedCollection();

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure-inverse',
        ids: ['wkb_1'],
      });

      expect(connectionQuiesceService.quiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      expect(connectionQuiesceService.unquiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      expect(result.migratedIds).toEqual(['fld_blog']);
      // Flip BACK to v1 (account had no nested collections left after the revert).
      expect(dbService.client.connectorAccount.update).toHaveBeenCalledWith({
        where: { id: 'acct_1' },
        data: { version: 1 },
      });
    });

    it('skips an account whose jobs will not drain in time, releasing it without reverting', async () => {
      seedOneNestedCollection();
      connectionQuiesceService.quiesceConnection = jest
        .fn()
        .mockRejectedValue(new ConnectionDrainTimeoutError('acct_1', 3));

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'webflow-folder-restructure-inverse',
        ids: ['wkb_1'],
      });

      expect(connectionQuiesceService.unquiesceConnection).toHaveBeenCalledWith('wkb_1', 'acct_1');
      expect(result.migratedIds).toEqual([]);
      expect(dbService.client.connectorAccount.update).not.toHaveBeenCalled();
    });
  });
});
