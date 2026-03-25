import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthType, ScheduleAction, SyncState } from '@prisma/client';
import type { DecryptedCredentials } from '@spinner/shared-types';
import {
  createConnectorAccountId,
  createDataFolderId,
  createScheduleId,
  createSyncId,
  createSyncTablePairId,
  createWorkbookId,
  createWorkspacePermissionId,
} from '@spinner/shared-types';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { getDefaultRepoPath, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SubscriptionService } from 'src/users/subscription.service';
import { UsersService } from 'src/users/users.service';
import type { EncryptedData } from 'src/utils/encryption';

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

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      workbook: { name: workbook.name ?? 'Untitled', version: workbook.version },
      connectorAccounts,
      dataFolders,
      syncs,
      schedules,
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

      // 5. Create Schedules — remap entityId using ID prefix
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
}
