import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthType, SyncState } from '@prisma/client';
import type { AnyId, DecryptedCredentials, HardDeleteUserResponse, ScheduleAction } from '@spinner/shared-types';
import {
  createConnectorAccountId,
  createDataFolderId,
  createRoutineDefinitionId,
  createScheduleId,
  createSyncId,
  createSyncTablePairId,
  createWorkbookId,
  createWorkspacePermissionId,
  ScratchPlanType,
  WorkbookId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { RoutineDefinitionStoreService } from 'src/routine/routine-definition-store.service';
import { assertValidRoutineFilePath } from 'src/routine/routine-file-path';
import { getDefaultRepoPath, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { isErr } from 'src/types/results';
import { SubscriptionService } from 'src/users/subscription.service';
import type { Actor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import type { EncryptedData } from 'src/utils/encryption';
import { WorkbookService } from 'src/workbook/workbook.service';

export interface WorkbookExportJson {
  version: 1;
  exportedAt: string;
  workbook: { name: string; version: number };
  connectorAccounts: Record<
    string,
    {
      service: string;
      displayName: string;
      authType: string;
      credentials: DecryptedCredentials;
      isOAuth: boolean;
      modifier: string | null;
      extras: unknown;
    }
  >;
  dataFolders: Record<
    string,
    {
      name: string;
      connectorAccountId: string | null;
      connectorService: string | null;
      path: string | null;
      version: number;
      tableId: string[];
      isAssetTable: boolean;
      options: unknown;
    }
  >;
  syncs: Record<
    string,
    {
      displayName: string;
      displayOrder: number;
      mappings: unknown;
      syncState: string;
      publishAfterSync: boolean;
      tablePairs: Record<string, { sourceDataFolderId: string; destinationDataFolderId: string }>;
    }
  >;
  schedules: Record<
    string,
    {
      name: string;
      action: string;
      entityId: string;
      cronExpression: string;
      enabled: boolean;
    }
  >;
  /** Absent in exports made before DEV-12621 — import treats that as no routines. */
  routineDefinitions?: Record<string, { filePath: string; content: string; version: number; source: string }>;
}

@Injectable()
export class DevToolsService {
  constructor(
    private readonly dbService: DbService,
    private readonly usersService: UsersService,
    private readonly stripePaymentService: StripePaymentService,
    private readonly subscriptionService: SubscriptionService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookService: WorkbookService,
    private readonly auditLogService: AuditLogService,
    private readonly posthogService: PostHogService,
    private readonly routineDefinitionStoreService: RoutineDefinitionStoreService,
  ) {}

  async exportWorkbook(workbookId: string): Promise<WorkbookExportJson> {
    const workbook = await this.dbService.client.workbook.findUnique({
      where: { id: workbookId },
      include: {
        connectorAccounts: true,
        dataFolders: true,
        syncs: { include: { syncTablePairs: true } },
        schedules: true,
      },
    });

    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    // Decrypt credentials for each connector account
    const connectorAccounts: WorkbookExportJson['connectorAccounts'] = {};
    for (const ca of workbook.connectorAccounts) {
      const credentials = await this.credentialEncryptionService.decryptCredentials(
        ca.encryptedCredentials as EncryptedData,
      );
      connectorAccounts[ca.id] = {
        service: ca.service,
        displayName: ca.displayName,
        authType: ca.authType,
        credentials,
        isOAuth: ca.authType === 'OAUTH',
        modifier: ca.modifier,
        extras: ca.extras,
      };
    }

    // Build data folders map
    const dataFolders: WorkbookExportJson['dataFolders'] = {};
    for (const df of workbook.dataFolders) {
      dataFolders[df.id] = {
        name: df.name,
        connectorAccountId: df.connectorAccountId,
        connectorService: df.connectorService,
        path: df.path,
        version: df.version,
        tableId: df.tableId,
        isAssetTable: df.isAssetTable,
        options: df.options,
      };
    }

    // Build syncs map
    const syncs: WorkbookExportJson['syncs'] = {};
    for (const sync of workbook.syncs) {
      const tablePairs: Record<string, { sourceDataFolderId: string; destinationDataFolderId: string }> = {};
      for (const tp of sync.syncTablePairs) {
        tablePairs[tp.id] = {
          sourceDataFolderId: tp.sourceDataFolderId,
          destinationDataFolderId: tp.destinationDataFolderId,
        };
      }
      syncs[sync.id] = {
        displayName: sync.displayName,
        displayOrder: sync.displayOrder,
        mappings: sync.mappings,
        syncState: sync.syncState,
        publishAfterSync: sync.publishAfterSync,
        tablePairs,
      };
    }

    // Build schedules map
    const schedules: WorkbookExportJson['schedules'] = {};
    for (const sch of workbook.schedules) {
      schedules[sch.id] = {
        name: sch.name,
        action: sch.action,
        entityId: sch.entityId,
        cronExpression: sch.cronExpression,
        enabled: sch.enabled,
      };
    }

    // Build routine definitions map. Read through the store (not an include) so a workbook still
    // pending its one-time git import exports its git routines instead of none.
    const routineDefinitions: NonNullable<WorkbookExportJson['routineDefinitions']> = {};
    for (const rd of await this.routineDefinitionStoreService.listDefinitions(workbookId as WorkbookId)) {
      routineDefinitions[rd.id] = {
        filePath: rd.filePath,
        content: rd.content,
        version: rd.version,
        source: rd.source,
      };
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      workbook: { name: workbook.name ?? 'Untitled', version: workbook.version },
      connectorAccounts,
      dataFolders,
      syncs,
      schedules,
      routineDefinitions,
    };
  }

  async importWorkbook(
    json: WorkbookExportJson,
    userId: string,
    organizationId: string,
  ): Promise<{ workbookId: string }> {
    if (json.version !== 1) {
      throw new BadRequestException(`Unsupported export version: ${String(json.version)}`);
    }

    return await this.dbService.client.$transaction(async (tx) => {
      // 1. Create Workbook
      const newWorkbookId = createWorkbookId();
      await tx.workbook.create({
        data: {
          id: newWorkbookId,
          name: `${json.workbook.name} (Import)`,
          version: json.workbook.version,
          userId,
          organizationId,
        },
      });

      // Create workspace permission for importing user
      await tx.workspacePermission.create({
        data: {
          id: createWorkspacePermissionId(),
          userId,
          workbookId: newWorkbookId,
          role: 'owner',
        },
      });

      // 2. Create ConnectorAccounts → build ID map
      const connectorAccountIdMap = new Map<string, string>();
      for (const [oldId, ca] of Object.entries(json.connectorAccounts)) {
        const newId = createConnectorAccountId();
        connectorAccountIdMap.set(oldId, newId);

        const isOAuth = ca.isOAuth;
        let encryptedCredentials: unknown = {};
        let healthStatus: 'OK' | 'FAILED' | null = null;

        if (isOAuth) {
          // OAuth accounts: empty credentials, mark as failed so user re-authenticates
          encryptedCredentials = {};
          healthStatus = 'FAILED';
        } else {
          // API key accounts: re-encrypt with local encryption key
          encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(ca.credentials);
          healthStatus = 'OK';
        }

        const repoPath = getDefaultRepoPath(organizationId, newWorkbookId, newId);

        await tx.connectorAccount.create({
          data: {
            id: newId,
            workbookId: newWorkbookId,
            userId,
            service: ca.service,
            displayName: ca.displayName,
            authType: ca.authType as AuthType,
            encryptedCredentials: encryptedCredentials as object,
            healthStatus,
            modifier: ca.modifier,
            extras: ca.extras as object | undefined,
            repoPath,
          },
        });

        // Init git repo for the connection
        try {
          await this.scratchGitService.initRepo(repoPath);
        } catch (err) {
          WSLogger.warn({ source: 'DevToolsService', message: `Failed to init repo for ${repoPath}`, error: err });
        }
      }

      // 3. Create DataFolders
      const dataFolderIdMap = new Map<string, string>();
      const dfEntries = Object.entries(json.dataFolders);

      // Topological sort: process folders whose parent is null or already processed
      const pending = new Map(dfEntries);
      let safety = pending.size + 1;
      while (pending.size > 0 && safety-- > 0) {
        for (const [oldId, df] of pending) {
          const newId = createDataFolderId();
          dataFolderIdMap.set(oldId, newId);

          await tx.dataFolder.create({
            data: {
              id: newId,
              workbookId: newWorkbookId,
              name: df.name,
              connectorAccountId: df.connectorAccountId
                ? (connectorAccountIdMap.get(df.connectorAccountId) ?? null)
                : null,
              connectorService: df.connectorService,
              path: df.path,
              version: df.version,
              tableId: df.tableId,
              isAssetTable: df.isAssetTable,
              options: df.options as object | undefined,
            },
          });

          pending.delete(oldId);
        }
      }

      if (pending.size > 0) {
        throw new BadRequestException('Circular or unresolvable parentId references in dataFolders');
      }

      // 4. Create Syncs + SyncTablePairs
      const syncIdMap = new Map<string, string>();
      for (const [oldId, sync] of Object.entries(json.syncs)) {
        const newSyncId = createSyncId();
        syncIdMap.set(oldId, newSyncId);

        await tx.sync.create({
          data: {
            id: newSyncId,
            workbookId: newWorkbookId,
            displayName: sync.displayName,
            displayOrder: sync.displayOrder,
            mappings: this.remapSyncMappings(sync.mappings, dataFolderIdMap) as object,
            syncState: sync.syncState as SyncState,
            publishAfterSync: sync.publishAfterSync,
          },
        });

        for (const [oldTpId, tp] of Object.entries(sync.tablePairs)) {
          const newTpId = createSyncTablePairId();
          const newSourceId = dataFolderIdMap.get(tp.sourceDataFolderId);
          const newDestId = dataFolderIdMap.get(tp.destinationDataFolderId);

          if (!newSourceId || !newDestId) {
            WSLogger.warn({
              source: 'DevToolsService',
              message: `Skipping SyncTablePair ${oldTpId}: source or destination DataFolder not found in map`,
            });
            continue;
          }

          await tx.syncTablePair.create({
            data: {
              id: newTpId,
              syncId: newSyncId,
              sourceDataFolderId: newSourceId,
              destinationDataFolderId: newDestId,
            },
          });
        }
      }

      // 5. Create RoutineDefinitions — written via tx (not the store) because the store reads the
      // workbook outside this transaction. Entity ids inside the YAML are remapped to the new ones;
      // ROUTINE schedules key on the file path, so they need no remap.
      const routineDefinitionEntries = Object.values(json.routineDefinitions ?? {});
      if (routineDefinitionEntries.length > 0) {
        const oldEntityIdToNewEntityIdMap = new Map([...connectorAccountIdMap, ...dataFolderIdMap, ...syncIdMap]);
        for (const rd of routineDefinitionEntries) {
          assertValidRoutineFilePath(rd.filePath);
        }
        await tx.routineDefinition.createMany({
          data: routineDefinitionEntries.map((rd) => ({
            id: createRoutineDefinitionId(),
            workbookId: newWorkbookId,
            filePath: rd.filePath,
            content: this.remapEntityIdsInRoutineYamlContent(rd.content, oldEntityIdToNewEntityIdMap),
            version: rd.version,
            source: rd.source,
            updatedByUserId: null,
          })),
        });
      }

      // 6. Create Schedules — remap entityId using ID prefix
      for (const [, sch] of Object.entries(json.schedules)) {
        const newScheduleId = createScheduleId();

        let newEntityId = sch.entityId;
        if (sch.entityId.startsWith('dfd_')) {
          newEntityId = dataFolderIdMap.get(sch.entityId) ?? sch.entityId;
        } else if (sch.entityId.startsWith('syn_')) {
          newEntityId = syncIdMap.get(sch.entityId) ?? sch.entityId;
        }

        await tx.schedule.create({
          data: {
            id: newScheduleId,
            workbookId: newWorkbookId,
            organizationId,
            userId,
            name: sch.name,
            action: sch.action as ScheduleAction,
            entityId: newEntityId,
            cronExpression: sch.cronExpression,
            enabled: sch.enabled,
          },
        });
      }

      return { workbookId: newWorkbookId };
    });
  }

  /**
   * Rewrites whole-token coa_/dfd_/syn_ ids in routine YAML text to the imported workbook's ids
   * (routine steps may reference a connection, folder or sync by id). Works on the text, not a
   * parsed copy, so comments and formatting survive; ids not in the map are left untouched.
   */
  private remapEntityIdsInRoutineYamlContent(
    routineYamlContent: string,
    oldEntityIdToNewEntityIdMap: Map<string, string>,
  ): string {
    return routineYamlContent.replace(
      /\b(?:coa|dfd|syn)_[0-9A-Za-z]+/g,
      (oldEntityId) => oldEntityIdToNewEntityIdMap.get(oldEntityId) ?? oldEntityId,
    );
  }

  /**
   * Remap DataFolder IDs inside a SyncMapping JSON structure.
   * Handles tableMappings[].sourceDataFolderId/destinationDataFolderId and
   * transformer options that reference DataFolder IDs (SourceFkToDestFk, LookupField, SourceAssetToDestAsset).
   */
  private remapSyncMappings(mappings: unknown, dataFolderIdMap: Map<string, string>): unknown {
    if (!mappings || typeof mappings !== 'object') return mappings;

    const m = mappings as Record<string, unknown>;
    const tableMappings = m.tableMappings;
    if (!Array.isArray(tableMappings)) return mappings;

    const remapped = tableMappings.map((tm: Record<string, unknown>) => {
      const result = { ...tm };

      // Remap top-level DataFolder references
      if (typeof result.sourceDataFolderId === 'string' && dataFolderIdMap.has(result.sourceDataFolderId)) {
        result.sourceDataFolderId = dataFolderIdMap.get(result.sourceDataFolderId);
      }
      if (typeof result.destinationDataFolderId === 'string' && dataFolderIdMap.has(result.destinationDataFolderId)) {
        result.destinationDataFolderId = dataFolderIdMap.get(result.destinationDataFolderId);
      }

      // Remap DataFolder references inside column mapping transformer options
      if (Array.isArray(result.columnMappings)) {
        result.columnMappings = (result.columnMappings as Record<string, unknown>[]).map((cm) => {
          const colMapping = { ...cm };
          colMapping.transformer = this.remapTransformerOptions(colMapping.transformer, dataFolderIdMap);
          if (Array.isArray(colMapping.transformers)) {
            colMapping.transformers = (colMapping.transformers as unknown[]).map((t) =>
              this.remapTransformerOptions(t, dataFolderIdMap),
            );
          }
          return colMapping;
        });
      }

      return result;
    });

    return { ...m, tableMappings: remapped };
  }

  private remapTransformerOptions(transformer: unknown, dataFolderIdMap: Map<string, string>): unknown {
    if (!transformer || typeof transformer !== 'object') return transformer;

    const t = transformer as Record<string, unknown>;
    if (!t.options || typeof t.options !== 'object') return transformer;

    const opts = { ...(t.options as Record<string, unknown>) };
    let changed = false;

    // SourceFkToDestFk and LookupField: referencedDataFolderId
    if (typeof opts.referencedDataFolderId === 'string' && dataFolderIdMap.has(opts.referencedDataFolderId)) {
      opts.referencedDataFolderId = dataFolderIdMap.get(opts.referencedDataFolderId);
      changed = true;
    }

    // SourceAssetToDestAsset: sourceDataFolderId, destinationDataFolderId
    if (typeof opts.sourceDataFolderId === 'string' && dataFolderIdMap.has(opts.sourceDataFolderId)) {
      opts.sourceDataFolderId = dataFolderIdMap.get(opts.sourceDataFolderId);
      changed = true;
    }
    if (typeof opts.destinationDataFolderId === 'string' && dataFolderIdMap.has(opts.destinationDataFolderId)) {
      opts.destinationDataFolderId = dataFolderIdMap.get(opts.destinationDataFolderId);
      changed = true;
    }

    return changed ? { ...t, options: opts } : transformer;
  }

  /**
   * Change a user's organization. Optionally mark the old organization as deleted
   * if no other users are associated with it.
   */
  async changeUserOrganization(
    userId: string,
    newOrganizationId: string,
    deleteOldOrganization?: boolean,
  ): Promise<void> {
    const user = await this.usersService.findOne(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const newOrganization = await this.dbService.client.organization.findUnique({
      where: { id: newOrganizationId },
    });
    if (!newOrganization) {
      throw new NotFoundException('Organization not found');
    }
    if (newOrganization.deleted) {
      throw new BadRequestException('Target organization is marked for deletion');
    }

    const oldOrganizationId = user.organizationId;

    await this.dbService.client.user.update({
      where: { id: userId },
      data: { organizationId: newOrganizationId },
    });

    if (deleteOldOrganization && oldOrganizationId) {
      const userCountInOldOrg = await this.dbService.client.user.count({
        where: { organizationId: oldOrganizationId },
      });
      if (userCountInOldOrg === 0) {
        await this.dbService.client.organization.update({
          where: { id: oldOrganizationId },
          data: { deleted: true },
        });
      }
    }
  }

  /**
   * Hard-delete a user and clean up all of their associated resources. This is irreversible.
   *
   * Mirrors the Whalesync shadow-user deprovision flow ({@link WhalesyncInternalService.deprovisionWhalesyncUser})
   * but for an admin acting on an arbitrary user:
   *   1. Only when the user is the SOLE member of their organization, tear down every workbook owned by
   *      that organization via {@link WorkbookService.executeHardDeleteWorkbook} — this is what cleans up
   *      the per-connection git repos, jobs, file indices and tables (a bare Prisma cascade does NOT).
   *   2. Delete the user row (cascading its tokens and workspace permissions).
   *   3. Only when the user is the SOLE member of their organization, delete the organization too (which
   *      cascades its remaining org-scoped rows).
   *
   * When the user is NOT the sole member of their org, no workbooks are deleted: the org and all of its
   * workbooks (including any the user could access via WorkspacePermission) belong to the organization and
   * are left intact — only the user's own row and permissions are removed.
   *
   * The teardown and the delete are attributed to the acting admin in the audit log and analytics.
   *
   * @param targetUserId the user to delete
   * @param actingAdmin the admin performing the deletion (for permission-free teardown + audit attribution)
   */
  async hardDeleteUser(targetUserId: string, actingAdmin: Actor): Promise<HardDeleteUserResponse> {
    const targetUser = await this.usersService.findOne(targetUserId);
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }
    if (targetUser.id === actingAdmin.userId) {
      throw new BadRequestException('You cannot hard-delete your own account');
    }

    const organizationId = targetUser.organizationId ?? undefined;

    const isSoleMemberOfOrganization = await this.usersService.isSoleMemberOfOrganization(targetUser);

    // Only tear down workbooks when the user is the sole member of their org: delete every workbook owned
    // by the org (org-scoped) so the subsequent organization delete cascade can't orphan a git repo. When
    // other members remain, we never delete a workbook — those are org-owned and may be shared with the
    // remaining members, even if the target user could reach them via WorkspacePermission.
    let workbookIdsToDelete: WorkbookId[] = [];
    if (isSoleMemberOfOrganization && organizationId) {
      const orgWorkbooks = await this.dbService.client.workbook.findMany({
        where: { organizationId },
        select: { id: true },
      });
      workbookIdsToDelete = orgWorkbooks.map((workbook) => workbook.id as WorkbookId);
    }

    WSLogger.info({
      source: 'DevToolsService',
      message: `Admin ${actingAdmin.userId} hard-deleting user ${targetUserId}: tearing down ${workbookIdsToDelete.length} workbook(s), organizationDeleted=${isSoleMemberOfOrganization}`,
      targetUserId,
      organizationId,
    });

    // executeHardDeleteWorkbook performs no permission check, so the acting admin can tear down a workbook
    // they are not a member of; attributing the teardown to the admin keeps the workbook audit trail honest.
    for (const workbookId of workbookIdsToDelete) {
      await this.workbookService.executeHardDeleteWorkbook(workbookId, { actor: actingAdmin });
    }

    // Tidy up any lingering Whalesync session tokens before the row goes (user delete cascades ApiToken
    // anyway, but this keeps parity with the deprovision flow and is a no-op when there are none).
    await this.usersService.revokeWhalesyncSessionTokens(targetUserId);

    await this.usersService.deleteShadowUserAndOrganization(
      targetUserId,
      isSoleMemberOfOrganization ? organizationId : undefined,
    );

    const result: HardDeleteUserResponse = {
      deletedWorkbookCount: workbookIdsToDelete.length,
      organizationDeleted: isSoleMemberOfOrganization,
    };

    await this.auditLogService.logEvent({
      actor: actingAdmin,
      eventType: 'delete',
      entityId: targetUserId as AnyId,
      organizationId,
      message: `Hard-deleted user ${targetUser.email ?? targetUserId} (${targetUserId}): removed ${
        result.deletedWorkbookCount
      } workbook(s)${result.organizationDeleted ? ' and their organization' : ''}`,
      context: {
        deletedUserId: targetUserId,
        deletedUserEmail: targetUser.email ?? '',
        deletedWorkbookCount: result.deletedWorkbookCount,
        organizationDeleted: result.organizationDeleted,
      },
    });

    this.posthogService.trackHardDeleteUser(actingAdmin, { id: targetUserId, email: targetUser.email }, result);

    return result;
  }

  /**
   * Grant a free trial to a user who has never had a subscription. Creates a REAL Stripe trial via
   * `StripePaymentService.createTrialSubscription` (no card collected; Stripe auto-cancels at trial end
   * if none is added). The "never had a subscription" eligibility rule and the 14-day trial length are
   * enforced inside that method.
   *
   * Unlike the fake-subscription dev endpoints, this is allowed in production — it is how an admin comps
   * a real trial. Defaults to the Pro plan.
   */
  async startTrialForUser(userId: string, planType: ScratchPlanType = ScratchPlanType.PRO_PLAN): Promise<void> {
    const user = await this.usersService.findOne(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const result = await this.stripePaymentService.createTrialSubscription(user, planType);
    if (isErr(result)) {
      throw new BadRequestException(result.error);
    }
  }
}
