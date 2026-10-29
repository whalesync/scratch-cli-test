import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { RoutineDefinition as PrismaRoutineDefinition } from '@prisma/client';
import { ScratchPlanType } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { RoutineDefinitionStoreService } from 'src/routine/routine-definition-store.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { badRequestError, ok } from 'src/types/results';
import type { Actor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { DevToolsService, WorkbookExportJson } from './dev-tools.service';

/**
 * Unit tests for the admin "grant a free trial" dev tool. The eligibility rule ("never had a
 * subscription") and the trial length live inside `StripePaymentService.createTrialSubscription`, so
 * here we only assert that `startTrialForUser` resolves the target user, delegates to that method with
 * the right plan, and surfaces its failure as a `BadRequestException`.
 */
describe('DevToolsService.startTrialForUser', () => {
  let service: DevToolsService;
  let usersService: { findOne: jest.Mock };
  let stripePaymentService: { createTrialSubscription: jest.Mock };

  function makeUser(): UserCluster.User {
    return { id: 'usr_target', organizationId: 'org_1' } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    usersService = { findOne: jest.fn() };
    stripePaymentService = { createTrialSubscription: jest.fn() };

    service = new DevToolsService(
      {} as never, // dbService — unused by startTrialForUser
      usersService as unknown as UsersService,
      stripePaymentService as unknown as StripePaymentService,
      {} as never, // subscriptionService — unused
      {} as never, // credentialEncryptionService — unused
      {} as never, // scratchGitService — unused
      {} as never, // workbookService — unused
      {} as never, // auditLogService — unused
      {} as never, // posthogService — unused
      {} as never, // routineDefinitionStoreService — unused
    );
  });

  it('throws NotFoundException when the target user does not exist', async () => {
    usersService.findOne.mockResolvedValue(null);

    await expect(service.startTrialForUser('usr_missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(stripePaymentService.createTrialSubscription).not.toHaveBeenCalled();
  });

  it('defaults to the Pro plan and resolves when the trial is created', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(ok('success'));

    await expect(service.startTrialForUser('usr_target')).resolves.toBeUndefined();
    expect(stripePaymentService.createTrialSubscription).toHaveBeenCalledWith(user, ScratchPlanType.PRO_PLAN);
  });

  it('forwards an explicit plan type', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(ok('success'));

    await service.startTrialForUser('usr_target', ScratchPlanType.MAX_PLAN);

    expect(stripePaymentService.createTrialSubscription).toHaveBeenCalledWith(user, ScratchPlanType.MAX_PLAN);
  });

  it('surfaces a createTrialSubscription failure as a BadRequestException carrying the message', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(
      badRequestError('User already has a subscription; cannot start a trial'),
    );

    await expect(service.startTrialForUser('usr_target')).rejects.toThrow('User already has a subscription');
    await expect(service.startTrialForUser('usr_target')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Unit tests for the admin hard-delete-a-user dev tool. Asserts the two membership branches (sole
 * member of the org → org cleaned up too; not sole member → user only), the workbook teardown, and the
 * self-delete / missing-user guards. The actual row/repo teardown lives in the collaborating services,
 * so here we assert the orchestration wires them together correctly.
 */
describe('DevToolsService.hardDeleteUser', () => {
  let service: DevToolsService;
  let usersService: {
    findOne: jest.Mock;
    isSoleMemberOfOrganization: jest.Mock;
    revokeWhalesyncSessionTokens: jest.Mock;
    deleteShadowUserAndOrganization: jest.Mock;
  };
  let workbookService: { findAllForUser: jest.Mock; executeHardDeleteWorkbook: jest.Mock };
  let auditLogService: { logEvent: jest.Mock };
  let posthogService: { trackHardDeleteUser: jest.Mock };
  let workbookFindMany: jest.Mock;

  const actingAdmin: Actor = { userId: 'usr_admin', organizationId: 'org_admin' };

  function makeTargetUser(): UserCluster.User {
    return {
      id: 'usr_target',
      email: 'target@example.com',
      organizationId: 'org_target',
    } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    workbookFindMany = jest.fn();
    const dbService = {
      client: { workbook: { findMany: workbookFindMany } },
    };
    usersService = {
      findOne: jest.fn(),
      isSoleMemberOfOrganization: jest.fn().mockResolvedValue(false),
      revokeWhalesyncSessionTokens: jest.fn().mockResolvedValue(0),
      deleteShadowUserAndOrganization: jest.fn().mockResolvedValue(undefined),
    };
    workbookService = {
      findAllForUser: jest.fn().mockResolvedValue([]),
      executeHardDeleteWorkbook: jest.fn().mockResolvedValue(undefined),
    };
    auditLogService = { logEvent: jest.fn().mockResolvedValue(undefined) };
    posthogService = { trackHardDeleteUser: jest.fn() };

    service = new DevToolsService(
      dbService as unknown as DbService,
      usersService as unknown as UsersService,
      {} as never, // stripePaymentService — unused
      {} as never, // subscriptionService — unused
      {} as never, // credentialEncryptionService — unused
      {} as never, // scratchGitService — unused
      workbookService as unknown as WorkbookService,
      auditLogService as unknown as AuditLogService,
      posthogService as unknown as PostHogService,
      {} as never, // routineDefinitionStoreService — unused
    );
  });

  it('throws NotFoundException when the target user does not exist', async () => {
    usersService.findOne.mockResolvedValue(null);

    await expect(service.hardDeleteUser('usr_missing', actingAdmin)).rejects.toBeInstanceOf(NotFoundException);
    expect(usersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
  });

  it('refuses to let an admin delete their own account', async () => {
    const selfActor: Actor = { userId: 'usr_target', organizationId: 'org_target' };
    usersService.findOne.mockResolvedValue(makeTargetUser());

    await expect(service.hardDeleteUser('usr_target', selfActor)).rejects.toBeInstanceOf(BadRequestException);
    expect(workbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
    expect(usersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
  });

  it('sole member: tears down every org workbook and deletes the organization too', async () => {
    usersService.findOne.mockResolvedValue(makeTargetUser());
    usersService.isSoleMemberOfOrganization.mockResolvedValue(true); // the target is the only member
    workbookFindMany.mockResolvedValue([{ id: 'wkb_1' }, { id: 'wkb_2' }]);

    const result = await service.hardDeleteUser('usr_target', actingAdmin);

    expect(workbookFindMany).toHaveBeenCalledWith({ where: { organizationId: 'org_target' }, select: { id: true } });
    expect(workbookService.findAllForUser).not.toHaveBeenCalled();
    expect(workbookService.executeHardDeleteWorkbook).toHaveBeenCalledTimes(2);
    expect(workbookService.executeHardDeleteWorkbook).toHaveBeenCalledWith('wkb_1', { actor: actingAdmin });
    expect(usersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_target', 'org_target');
    expect(result).toEqual({ deletedWorkbookCount: 2, organizationDeleted: true });
    expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    expect(posthogService.trackHardDeleteUser).toHaveBeenCalledTimes(1);
  });

  it('not sole member: deletes no workbooks and preserves the organization', async () => {
    usersService.findOne.mockResolvedValue(makeTargetUser());
    usersService.isSoleMemberOfOrganization.mockResolvedValue(false); // another member remains

    const result = await service.hardDeleteUser('usr_target', actingAdmin);

    // Org-owned workbooks (including any the user could reach via WorkspacePermission) are left intact.
    expect(workbookFindMany).not.toHaveBeenCalled();
    expect(workbookService.findAllForUser).not.toHaveBeenCalled();
    expect(workbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
    // organizationId omitted → the org and its workbooks are left intact.
    expect(usersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_target', undefined);
    expect(result).toEqual({ deletedWorkbookCount: 0, organizationDeleted: false });
  });
});

/**
 * Unit tests for carrying routine definitions through the dev-tools workbook export/import
 * (DEV-12621). Export must read through the definition store; import must recreate the rows on the
 * new workbook inside the import transaction, rewriting the connection/folder/sync ids the YAML
 * references to the imported workbook's new ids while leaving the rest of the text verbatim.
 */
describe('DevToolsService workbook export/import — routine definitions', () => {
  let service: DevToolsService;
  let workbookFindUnique: jest.Mock;
  let routineDefinitionStoreService: { listDefinitions: jest.Mock };
  type CreateRowWithIdMock = jest.Mock<Promise<void>, [{ data: { id: string } }]>;
  let tx: {
    workbook: { create: CreateRowWithIdMock };
    workspacePermission: { create: CreateRowWithIdMock };
    connectorAccount: { create: CreateRowWithIdMock };
    dataFolder: { create: CreateRowWithIdMock };
    sync: { create: CreateRowWithIdMock };
    syncTablePair: { create: CreateRowWithIdMock };
    schedule: { create: CreateRowWithIdMock };
    routineDefinition: { createMany: jest.Mock<Promise<{ count: number }>, [{ data: { content: string }[] }]> };
  };

  const OLD_CONNECTOR_ACCOUNT_ID = 'coa_OLDconnect';
  const OLD_DATA_FOLDER_ID = 'dfd_OLDfolder1';
  const OLD_SYNC_ID = 'syn_OLDsync001';
  const SYNC_ID_NOT_IN_EXPORT = 'syn_NOTexport';

  function makeExportJson(overrides: Partial<WorkbookExportJson> = {}): WorkbookExportJson {
    return {
      version: 1,
      exportedAt: '2026-10-29T00:00:00.000Z',
      workbook: { name: 'Blog', version: 1 },
      connectorAccounts: {
        [OLD_CONNECTOR_ACCOUNT_ID]: {
          service: 'AIRTABLE',
          displayName: 'Airtable',
          authType: 'USER_PROVIDED_PARAMS',
          credentials: {},
          isOAuth: false,
          modifier: null,
          extras: null,
        },
      },
      dataFolders: {
        [OLD_DATA_FOLDER_ID]: {
          name: 'posts',
          connectorAccountId: OLD_CONNECTOR_ACCOUNT_ID,
          connectorService: 'AIRTABLE',
          path: '/blog/posts',
          version: 1,
          tableId: ['tbl1'],
          isAssetTable: false,
          options: null,
        },
      },
      syncs: {
        [OLD_SYNC_ID]: {
          displayName: 'Posts sync',
          displayOrder: 0,
          mappings: null,
          syncState: 'OFF',
          publishAfterSync: false,
          tablePairs: {},
        },
      },
      schedules: {},
      ...overrides,
    };
  }

  function makeRoutineYaml(ids: { connectorAccountId: string; dataFolderId: string; syncId: string }): string {
    return [
      '# Nightly refresh — keep this comment',
      'name: Nightly',
      'steps:',
      '  - action: pull',
      '    folders:',
      `      - ${ids.dataFolderId}`,
      '      - /blog/posts',
      `    connection: ${ids.connectorAccountId}`,
      '  - action: sync',
      `    sync: ${ids.syncId}`,
      '  - action: publish',
      `    folder: ${ids.dataFolderId} # trailing comment`,
      '',
    ].join('\n');
  }

  beforeEach(() => {
    workbookFindUnique = jest.fn();
    const createRowWithIdMock = (): CreateRowWithIdMock =>
      jest.fn<Promise<void>, [{ data: { id: string } }]>().mockResolvedValue(undefined);
    tx = {
      workbook: { create: createRowWithIdMock() },
      workspacePermission: { create: createRowWithIdMock() },
      connectorAccount: { create: createRowWithIdMock() },
      dataFolder: { create: createRowWithIdMock() },
      sync: { create: createRowWithIdMock() },
      syncTablePair: { create: createRowWithIdMock() },
      schedule: { create: createRowWithIdMock() },
      routineDefinition: {
        createMany: jest
          .fn<Promise<{ count: number }>, [{ data: { content: string }[] }]>()
          .mockResolvedValue({ count: 1 }),
      },
    };
    const dbService = {
      client: {
        workbook: { findUnique: workbookFindUnique },
        $transaction: jest.fn((callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx)),
      },
    };
    routineDefinitionStoreService = { listDefinitions: jest.fn().mockResolvedValue([]) };
    const credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
      encryptCredentials: jest.fn().mockResolvedValue({ encrypted: true }),
    };
    const scratchGitService = { initRepo: jest.fn().mockResolvedValue(undefined) };

    service = new DevToolsService(
      dbService as unknown as DbService,
      {} as never, // usersService — unused
      {} as never, // stripePaymentService — unused
      {} as never, // subscriptionService — unused
      credentialEncryptionService as unknown as CredentialEncryptionService,
      scratchGitService as unknown as ScratchGitService,
      {} as never, // workbookService — unused
      {} as never, // auditLogService — unused
      {} as never, // posthogService — unused
      routineDefinitionStoreService as unknown as RoutineDefinitionStoreService,
    );
  });

  it('export includes every routine definition read through the store, keyed by row id', async () => {
    workbookFindUnique.mockResolvedValue({
      id: 'wkb_source',
      name: 'Blog',
      version: 3,
      connectorAccounts: [],
      dataFolders: [],
      syncs: [],
      schedules: [],
    });
    routineDefinitionStoreService.listDefinitions.mockResolvedValue([
      {
        id: 'rdf_nightly01',
        workbookId: 'wkb_source',
        filePath: 'routines/nightly.yaml',
        content: 'name: Nightly\n',
        version: 4,
        source: 'cli',
        updatedByUserId: 'usr_someone',
      } as PrismaRoutineDefinition,
    ]);

    const exported = await service.exportWorkbook('wkb_source');

    expect(routineDefinitionStoreService.listDefinitions).toHaveBeenCalledWith('wkb_source');
    expect(exported.routineDefinitions).toEqual({
      rdf_nightly01: { filePath: 'routines/nightly.yaml', content: 'name: Nightly\n', version: 4, source: 'cli' },
    });
  });

  it('import recreates routine definitions on the new workbook with entity ids remapped and text otherwise verbatim', async () => {
    const oldIds = {
      connectorAccountId: OLD_CONNECTOR_ACCOUNT_ID,
      dataFolderId: OLD_DATA_FOLDER_ID,
      syncId: OLD_SYNC_ID,
    };
    const exportJson = makeExportJson({
      routineDefinitions: {
        rdf_nightly01: {
          filePath: 'routines/nightly.yaml',
          content: makeRoutineYaml(oldIds),
          version: 4,
          source: 'generated',
        },
      },
    });

    const { workbookId: newWorkbookId } = await service.importWorkbook(exportJson, 'usr_importer', 'org_importer');

    const newIds = {
      connectorAccountId: tx.connectorAccount.create.mock.calls[0][0].data.id,
      dataFolderId: tx.dataFolder.create.mock.calls[0][0].data.id,
      syncId: tx.sync.create.mock.calls[0][0].data.id,
    };
    expect(newIds.connectorAccountId).not.toBe(OLD_CONNECTOR_ACCOUNT_ID);
    expect(newIds.dataFolderId).not.toBe(OLD_DATA_FOLDER_ID);
    expect(newIds.syncId).not.toBe(OLD_SYNC_ID);

    expect(tx.routineDefinition.createMany).toHaveBeenCalledTimes(1);
    expect(tx.routineDefinition.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: expect.stringMatching(/^rdf_/) as unknown as string,
          workbookId: newWorkbookId,
          filePath: 'routines/nightly.yaml',
          content: makeRoutineYaml(newIds),
          version: 4,
          source: 'generated',
          updatedByUserId: null,
        },
      ],
    });
  });

  it('import leaves an id that is not part of the export untouched', async () => {
    const exportJson = makeExportJson({
      routineDefinitions: {
        rdf_nightly01: {
          filePath: 'routines/nightly.yaml',
          content: `name: Nightly\nsteps:\n  - action: sync\n    sync: ${SYNC_ID_NOT_IN_EXPORT}\n`,
          version: 1,
          source: 'web',
        },
      },
    });

    await service.importWorkbook(exportJson, 'usr_importer', 'org_importer');

    expect(tx.routineDefinition.createMany.mock.calls[0][0].data[0].content).toBe(
      `name: Nightly\nsteps:\n  - action: sync\n    sync: ${SYNC_ID_NOT_IN_EXPORT}\n`,
    );
  });

  it('import of an export made before routine definitions were carried creates no routine rows', async () => {
    const exportJsonWithoutRoutineDefinitions = makeExportJson();
    delete exportJsonWithoutRoutineDefinitions.routineDefinitions;

    await expect(
      service.importWorkbook(exportJsonWithoutRoutineDefinitions, 'usr_importer', 'org_importer'),
    ).resolves.toEqual({ workbookId: expect.stringMatching(/^wkb_/) as unknown as string });
    expect(tx.routineDefinition.createMany).not.toHaveBeenCalled();
  });

  it('import rejects a routine definition whose file path escapes routines/', async () => {
    const exportJson = makeExportJson({
      routineDefinitions: {
        rdf_escaping1: { filePath: 'routines/../secrets.yaml', content: 'name: x\n', version: 1, source: 'web' },
      },
    });

    await expect(service.importWorkbook(exportJson, 'usr_importer', 'org_importer')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.routineDefinition.createMany).not.toHaveBeenCalled();
  });
});
