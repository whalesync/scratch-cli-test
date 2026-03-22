import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConnectorAccount, Prisma } from '@prisma/client';
import {
  ConnectorPullOptions,
  createDataFolderId,
  DataFolderGroup,
  DataFolderId,
  Service,
  ValidatedCreateDataFolderDto,
  ValidatedUpdateDataFolderDto,
  WorkbookId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DataFolderCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { DecryptedCredentials } from 'src/remote-service/connector-account/types/encrypted-credentials.interface';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { Actor } from 'src/users/types';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { RunContext } from 'src/worker/jobs/base-types';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { ASSET_TABLE } from '../remote-service/connectors/json-schema';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { DIRTY_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { DataFolderEntity, DataFolderGroupEntity } from './entities/data-folder.entity';
import { FilesService } from './files.service';
import { WorkbookEventService } from './workbook-event.service';
import { WorkbookService } from './workbook.service';

const PAGINATED_FILE_BATCH_SIZE = 1000;

@Injectable()
export class DataFolderService {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly db: DbService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly connectorService: ConnectorsService,
    private readonly configService: ScratchConfigService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly auditLogService: AuditLogService,
    private readonly posthogService: PostHogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly filesService: FilesService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  /**
   * Lists all data folders in a workbook as a flat list.
   */
  async listAll(workbookId: WorkbookId, actor: Actor): Promise<DataFolderEntity[]> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId },
      include: DataFolderCluster._validator.include,
      orderBy: { name: 'asc' },
    });

    const schedulesByEntityId = await this.workbookService.fetchSchedulesByEntityId(workbookId);
    return dataFolders.map((f) => new DataFolderEntity(f, schedulesByEntityId.get(f.id) ?? []));
  }

  async listGroupedByConnectorBases(workbookId: WorkbookId, actor: Actor): Promise<DataFolderGroup[]> {
    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Fetch all data folders for the workbook with connector account info
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: {
        workbookId,
      },
      include: DataFolderCluster._validator.include,
      orderBy: {
        name: 'asc',
      },
    });

    const schedulesByEntityId = await this.workbookService.fetchSchedulesByEntityId(workbookId);

    // Group data folders by connector account
    const scratchFolders: DataFolderCluster.DataFolder[] = [];
    const connectorAccountGroups = new Map<
      string,
      {
        name: string;
        connectorAccount: DataFolderCluster.DataFolder['connectorAccount'];
        folders: DataFolderCluster.DataFolder[];
      }
    >();

    for (const folder of dataFolders) {
      if (!folder.connectorAccountId || !folder.connectorAccount) {
        scratchFolders.push(folder);
      } else {
        const accountId = folder.connectorAccountId;
        if (!connectorAccountGroups.has(accountId)) {
          connectorAccountGroups.set(accountId, {
            name: folder.connectorAccount.displayName,
            connectorAccount: folder.connectorAccount,
            folders: [],
          });
        }
        connectorAccountGroups.get(accountId)!.folders.push(folder);
      }
    }

    // Build the result array with Scratch group first
    const groups: DataFolderGroupEntity[] = [];

    // Add Scratch group first (if there are any scratch folders)
    if (scratchFolders.length > 0) {
      groups.push(
        new DataFolderGroupEntity(
          'Scratch',
          null,
          scratchFolders.map((f) => new DataFolderEntity(f, schedulesByEntityId.get(f.id) ?? [])),
        ),
      );
    }

    // Add connector account groups
    for (const [, group] of connectorAccountGroups) {
      groups.push(
        new DataFolderGroupEntity(
          group.name,
          group.connectorAccount,
          group.folders.map((f) => new DataFolderEntity(f, schedulesByEntityId.get(f.id) ?? [])),
        ),
      );
    }

    return groups;
  }

  async findOne(id: DataFolderId, actor: Actor): Promise<DataFolderEntity> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Data folder not found');
    }

    const schedules = await this.db.client.schedule.findMany({ where: { entityId: id } });
    return new DataFolderEntity(dataFolder, schedules);
  }

  async createFolder(
    dto: ValidatedCreateDataFolderDto,
    actor: Actor,
    runContext: RunContext,
  ): Promise<DataFolderEntity> {
    const { name, workbookId, connectorAccountId, filter } = dto;
    const parentFolderId = (dto as { parentFolderId?: string }).parentFolderId;

    // Get the workbook (already verified in controller, but need the data)
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Load parent folder if specified to build the path
    let parentFolder: DataFolderCluster.DataFolder | null = null;
    if (parentFolderId) {
      parentFolder = await this.db.client.dataFolder.findUnique({
        where: { id: parentFolderId },
        include: DataFolderCluster._validator.include,
      });
      if (!parentFolder) {
        throw new NotFoundException('Parent folder not found');
      }
      // Verify parent folder belongs to the same workbook
      if (parentFolder.workbookId !== workbookId) {
        throw new NotFoundException('Parent folder does not belong this workbook');
      }
    }

    const dataFolderId = createDataFolderId();

    if (connectorAccountId && dto.tableId && dto.tableId.length > 0) {
      // Case 1: Connected folder with connector account and table IDs
      const connectorAccount = await this.connectorAccountService.findOneById(connectorAccountId, actor);
      if (!connectorAccount) {
        throw new NotFoundException('Connector account not found');
      }

      const service = connectorAccount.service;

      // Get connector and fetch table spec
      const connector = await this.connectorService.getConnector({
        service,
        connectorAccount: connectorAccount as ConnectorAccount,
        decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
      });

      // Validate filter support
      if (filter && !connector.supportsFilters()) {
        throw new BadRequestException('This connector does not support filters');
      }

      // Fetch table spec for the first tableId
      let tableSpec: BaseJsonTableSpec;
      try {
        tableSpec = await connector.fetchJsonTableSpec({ wsId: dto.tableId[0], remoteId: dto.tableId });
      } catch (error) {
        throw exceptionForConnectorError(error, connector);
      }

      // Apply user field overrides to the schema
      const { idFieldOverride, nameFieldOverride } = dto;
      if (idFieldOverride || nameFieldOverride) {
        const schemaProps = (tableSpec.schema as Record<string, unknown>)?.properties as
          | Record<string, unknown>
          | undefined;
        if (idFieldOverride) {
          if (!schemaProps?.[idFieldOverride]) {
            throw new BadRequestException(`ID field "${idFieldOverride}" does not exist in the table schema`);
          }
          tableSpec.idColumnRemoteId = idFieldOverride;
        }
        if (nameFieldOverride) {
          if (!schemaProps?.[nameFieldOverride]) {
            throw new BadRequestException(`Name field "${nameFieldOverride}" does not exist in the table schema`);
          }
          tableSpec.titleColumnRemoteId = [nameFieldOverride];
        }
      }

      // Build path from connector display name, base path, and table name
      let folderPath = this.buildConnectorFolderPath(
        connectorAccount.displayName,
        tableSpec,
        parentFolder?.path ?? undefined,
      );

      // Ensure path is unique within the workbook
      folderPath = await this.ensureUniquePath(workbookId, folderPath, dataFolderId);

      // Create the DataFolder
      const isAssetTable = Boolean(tableSpec.schema[ASSET_TABLE]);
      const createdDataFolder = await this.db.client.dataFolder.create({
        data: {
          id: dataFolderId,
          name,
          workbookId,
          connectorAccountId,
          connectorService: service,
          parentId: parentFolderId ?? null,
          path: folderPath,
          lock: 'pull',
          lastSchemaRefreshAt: new Date(),
          version: 1,
          tableId: dto.tableId,
          isAssetTable,
          options: {
            ...(dto.options ?? {}),
            ...(filter ? { filter } : {}),
            ...(idFieldOverride ? { idFieldOverride } : {}),
            ...(nameFieldOverride ? { nameFieldOverride } : {}),
          } as Prisma.InputJsonValue,
        },
        include: DataFolderCluster._validator.include,
      });

      // Write schema to git repo
      try {
        const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
        await this.scratchGitService.writeSchemaToGit(repoId, folderPath, tableSpec);
      } catch (error) {
        WSLogger.error({
          source: 'DataFolderService.createFolder',
          message: 'Failed to write schema to git',
          error,
          workbookId,
          dataFolderId,
        });
      }

      this.workbookEventService.sendWorkbookEvent(workbookId, {
        type: 'folder-created',
        data: { source: 'user', entityId: dataFolderId, message: 'Folder created' },
      });

      // Trigger pull job (defaults to true if not specified)
      if (dto.triggerPull !== false) {
        try {
          await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
            workbookId,
            actor,
            [dataFolderId],
            {
              totalFiles: 0,
              folderCount: 1,
              connectionName: createdDataFolder.connectorAccount?.displayName ?? 'Unknown connection',
              folderId: dataFolderId,
              folderName: createdDataFolder.name,
              connector: createdDataFolder.connectorService ?? 'unknown',
              filter: (createdDataFolder.options as unknown as ConnectorPullOptions)?.filter ?? null,
              status: 'pending',
              createdPaths: [],
              updatedPaths: [],
              deletedPaths: [],
            },
            runContext,
          );
          WSLogger.info({
            source: 'DataFolderService.createFolder',
            message: 'Started pulling files for newly created data folder',
            workbookId,
            dataFolderId,
          });
        } catch (error) {
          WSLogger.error({
            source: 'DataFolderService.createFolder',
            message: 'Failed to start pull job for newly created data folder',
            error,
            workbookId,
            dataFolderId,
          });
        }
      } else {
        WSLogger.info({
          source: 'DataFolderService.createFolder',
          message: 'Skipped pull job for newly created data folder (triggerPull=false)',
          workbookId,
          dataFolderId,
        });
      }

      // Log audit event
      await this.auditLogService.logEvent({
        actor,
        eventType: 'create',
        message: `Created linked data folder ${name} in workbook ${workbook.name}`,
        entityId: dataFolderId,
        organizationId: workbook.organizationId,
        context: {
          workbookId,
          connectorAccountId,
          service,
          tableSpec: tableSpec?.name,
          ...(idFieldOverride ? { idFieldOverride } : {}),
          ...(nameFieldOverride ? { nameFieldOverride } : {}),
        },
      });

      this.posthogService.trackAddDataFolder(actor, createdDataFolder);
      return new DataFolderEntity(createdDataFolder);
    } else {
      // Case 2: Scratch folder with no connector
      let folderPath = parentFolder ? `${parentFolder.path}/${name}` : '/' + name;

      // Ensure path is unique within the workbook
      folderPath = await this.ensureUniquePath(workbookId, folderPath, dataFolderId);

      const createdDataFolder = await this.db.client.dataFolder.create({
        data: {
          id: dataFolderId,
          name,
          workbookId,
          connectorAccountId: null,
          connectorService: null,
          parentId: parentFolderId ?? null,
          path: folderPath,
          lastSchemaRefreshAt: new Date(),
          version: 1,
          options: { ...(dto.options ?? {}), ...(filter ? { filter } : {}) } as Prisma.InputJsonValue,
        },
        include: DataFolderCluster._validator.include,
      });

      // Log audit event
      await this.auditLogService.logEvent({
        actor,
        eventType: 'create',
        message: `Created scratch data folder ${name} in workbook ${workbook.name}`,
        entityId: dataFolderId,
        organizationId: workbook.organizationId,
        context: {
          workbookId,
          parentFolderId: parentFolderId ?? null,
        },
      });

      this.posthogService.trackAddDataFolder(actor, createdDataFolder);
      return new DataFolderEntity(createdDataFolder);
    }
  }

  async deleteFolder(id: DataFolderId, actor: Actor): Promise<void> {
    // Fetch the data folder
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Verify user has access to the workbook
    checkWorkspacePermissions(actor, dataFolder.workbookId as WorkbookId);

    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Delete folder in git from both branches to avoid orphaned files in git status
    // Note: dataFolder.path includes leading slash, which is handled by service
    if (dataFolder.path) {
      await this.scratchGitService.removeDataFolder(dataFolder.workbookId as WorkbookId, dataFolder.path);
    }

    // Delete associated pull/publish schedules (no FK cascade exists for Schedule.entityId)
    await this.db.client.schedule.deleteMany({
      where: { entityId: id, action: { in: ['PULL', 'PUBLISH'] } },
    });

    // Delete the data folder (cascades to children due to schema relation)
    await this.db.client.dataFolder.delete({
      where: { id },
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-deleted',
      data: { source: 'user', entityId: id, message: 'Folder deleted' },
    });

    this.posthogService.trackRemoveDataFolder(actor, dataFolder);
    // Log audit event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted data folder ${dataFolder.name} from workbook ${workbook.name}`,
      entityId: id,
      organizationId: workbook.organizationId,
      context: {
        workbookId: dataFolder.workbookId,
        folderName: dataFolder.name,
      },
    });
  }

  async renameFolder(id: DataFolderId, newName: string, actor: Actor): Promise<DataFolderEntity> {
    // Fetch the data folder
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Only scratch folders can be renamed
    if (dataFolder.connectorAccountId) {
      throw new BadRequestException('Only scratch folders can be renamed');
    }

    // Verify user has access to the workbook
    checkWorkspacePermissions(actor, dataFolder.workbookId as WorkbookId);
    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Build the new path
    const parentPath = dataFolder.parentId ? dataFolder.path?.substring(0, dataFolder.path.lastIndexOf('/')) || '' : '';
    const newPath = parentPath ? `${parentPath}/${newName}` : '/' + newName;

    // Update the folder name and path
    const updatedDataFolder = await this.db.client.dataFolder.update({
      where: { id },
      data: {
        name: newName,
        path: newPath,
      },
      include: DataFolderCluster._validator.include,
    });

    // Update paths of all children recursively
    await this.updateChildrenPaths(id, newPath);

    // Log audit event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Renamed data folder from ${dataFolder.name} to ${newName} in workbook ${workbook.name}`,
      entityId: id,
      organizationId: workbook.organizationId,
      context: {
        workbookId: dataFolder.workbookId,
        oldName: dataFolder.name,
        newName,
      },
    });

    return new DataFolderEntity(updatedDataFolder);
  }

  async moveFolder(id: DataFolderId, newParentFolderId: string | null, actor: Actor): Promise<DataFolderEntity> {
    // Fetch the data folder
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Only scratch folders can be moved
    if (dataFolder.connectorAccountId) {
      throw new BadRequestException('Only scratch folders can be moved');
    }

    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    checkWorkspacePermissions(actor, dataFolder.workbookId as WorkbookId);

    // Load new parent folder if specified
    let newParentFolder: DataFolderCluster.DataFolder | null = null;
    if (newParentFolderId) {
      newParentFolder = await this.db.client.dataFolder.findUnique({
        where: { id: newParentFolderId },
        include: DataFolderCluster._validator.include,
      });
      if (!newParentFolder) {
        throw new NotFoundException('Parent folder not found');
      }
      // Verify parent folder belongs to the same workbook
      if (newParentFolder.workbookId !== dataFolder.workbookId) {
        throw new BadRequestException('Parent folder does not belong to the same workbook');
      }
      // Prevent moving a folder into itself or its descendants
      if (newParentFolderId === id || newParentFolder.path?.startsWith(dataFolder.path + '/')) {
        throw new BadRequestException('Cannot move a folder into itself or its descendants');
      }
    }

    // Build the new path
    const newPath = newParentFolder ? `${newParentFolder.path}/${dataFolder.name}` : '/' + dataFolder.name;

    // Update the folder
    const updatedDataFolder = await this.db.client.dataFolder.update({
      where: { id },
      data: {
        parentId: newParentFolderId,
        path: newPath,
      },
      include: DataFolderCluster._validator.include,
    });

    // Update paths of all children recursively
    await this.updateChildrenPaths(id, newPath);

    // Log audit event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Moved data folder ${dataFolder.name} in workbook ${workbook.name}`,
      entityId: id,
      organizationId: workbook.organizationId,
      context: {
        workbookId: dataFolder.workbookId,
        oldParentId: dataFolder.parentId,
        newParentId: newParentFolderId,
        oldPath: dataFolder.path,
        newPath,
      },
    });

    return new DataFolderEntity(updatedDataFolder);
  }

  async updateFolder(id: DataFolderId, dto: ValidatedUpdateDataFolderDto, actor: Actor): Promise<DataFolderEntity> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Data folder not found');
    }

    checkWorkspacePermissions(actor, dataFolder.workbookId as WorkbookId);

    // When setting a filter, verify the connector supports filters
    if (dto.filter && dataFolder.connectorAccountId) {
      const connectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, actor);
      if (!connectorAccount) {
        throw new NotFoundException('Connector account not found');
      }

      const connector = await this.connectorService.getConnector({
        service: dataFolder.connectorService as Service,
        connectorAccount: connectorAccount as ConnectorAccount,
        decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
      });

      if (!connector.supportsFilters()) {
        throw new BadRequestException('This connector does not support filters');
      }
    }

    const mergedOptions = {
      ...(dto.options ?? (dataFolder.options as Record<string, unknown>) ?? {}),
      ...(dto.filter !== undefined ? { filter: dto.filter?.trim() || undefined } : {}),
    };

    const updatedDataFolder = await this.db.client.dataFolder.update({
      where: { id },
      data: {
        options: mergedOptions as Prisma.InputJsonValue,
      },
      include: DataFolderCluster._validator.include,
    });

    return new DataFolderEntity(updatedDataFolder);
  }

  /**
   * Checks whether `path` is already used by another DataFolder in the same workbook.
   * If it is, appends `-{last 5 chars of dataFolderId}` to make the path unique.
   * This is to prevent conflicts when creating data folders with the same name in the same workbook.
   * @param workbookId - The ID of the workbook
   * @param path - The path to check
   * @param dataFolderId - The ID of the data folder
   * @returns The unique path to use for the new data folder
   */
  private async ensureUniquePath(workbookId: WorkbookId, path: string, dataFolderId: DataFolderId): Promise<string> {
    const existing = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path },
      select: { id: true },
    });

    if (existing) {
      return `${path}-${dataFolderId.slice(-5)}`;
    }

    return path;
  }

  private async updateChildrenPaths(parentId: string, parentPath: string): Promise<void> {
    const children = await this.db.client.dataFolder.findMany({
      where: { parentId },
    });

    for (const child of children) {
      const childPath = `${parentPath}/${child.name}`;
      await this.db.client.dataFolder.update({
        where: { id: child.id },
        data: { path: childPath },
      });
      // Recursively update grandchildren
      await this.updateChildrenPaths(child.id, childPath);
    }
  }

  async getNewFileTemplate(id: DataFolderId, actor: Actor): Promise<Record<string, unknown>> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(dataFolder.workbookId as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Data folder not found');
    }

    checkWorkspacePermissions(actor, dataFolder.workbookId as WorkbookId);

    if (dataFolder.connectorAccountId && dataFolder.connectorService) {
      const connectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, actor);
      if (!connectorAccount) {
        throw new NotFoundException('Connector account not found');
      }

      const connector = await this.connectorService.getConnector({
        service: dataFolder.connectorService,
        connectorAccount: connectorAccount as ConnectorAccount,
        decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
      });

      const schema = await this.readSchema(
        dataFolder.workbookId as WorkbookId,
        dataFolder.connectorAccountId,
        dataFolder.path,
      );

      if (!schema) {
        // Fallback if no schema is present (shouldn't happen for valid connected folders but safe to handle)
        return {};
      }

      return await connector.getNewFile(schema);
    }

    // Default for scratch folders or if no connector logic applies
    return {};
  }

  async createFile(
    workbookId: WorkbookId,
    id: DataFolderId,
    dto: { name: string; useTemplate?: boolean },
    actor: Actor,
  ) {
    let content = '{}';

    if (dto.useTemplate) {
      try {
        const template = await this.getNewFileTemplate(id, actor);
        content = JSON.stringify(template, null, 2);
      } catch (e) {
        WSLogger.warn({
          source: 'DataFolderService.createFile',
          message: 'Failed to fetch template for new file',
          error: e,
        });
      }
    }

    const file = await this.filesService.createFile(
      workbookId,
      {
        name: dto.name,
        parentFolderId: id,
        content,
      },
      actor,
    );

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'folder-contents-changed',
      data: { source: 'user', entityId: id, message: 'File created', path: file.path },
    });

    return file;
  }

  /**
   * Get all file contents for a data folder using paginated reads.
   * Returns an array of objects containing the folder ID, file path, and content.
   */
  async getAllFileContentsByFolderId(
    workbookId: WorkbookId,
    folderId: DataFolderId,
    actor: Actor,
    branch: string = DIRTY_BRANCH,
  ): Promise<{ folderId: DataFolderId; path: string; content: string }[]> {
    const folder = await this.findOne(folderId, actor);

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths
    const allFiles: { folderId: DataFolderId; path: string; content: string }[] = [];
    let cursor: string | undefined;

    const repoId = await this.scratchGitService.resolveRepoId(workbookId, folder.connectorAccountId ?? undefined);

    do {
      const page = await this.scratchGitService.getRepoFilesPaginated(
        repoId,
        branch,
        folderPath,
        PAGINATED_FILE_BATCH_SIZE,
        cursor,
      );

      for (const file of page.files) {
        // Skip dotfiles (e.g. .schema.json) — they are metadata, not data records
        if (file.name.startsWith('.')) continue;
        allFiles.push({
          folderId,
          path: `${folderPath}/${file.name}`,
          content: file.content,
        });
      }

      cursor = page.nextCursor;
    } while (cursor);

    return allFiles;
  }

  /**
   * Get a single page of file contents for a data folder.
   * Returns the files in this page and a nextCursor for fetching the next page.
   */
  async getFileContentsByFolderIdPaginated(
    workbookId: WorkbookId,
    folderId: DataFolderId,
    actor: Actor,
    branch: string = DIRTY_BRANCH,
    cursor?: string,
  ): Promise<{ files: { folderId: DataFolderId; path: string; content: string }[]; nextCursor?: string }> {
    const folder = await this.findOne(folderId, actor);

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths

    const repoId = await this.scratchGitService.resolveRepoId(workbookId, folder.connectorAccountId ?? undefined);
    const page = await this.scratchGitService.getRepoFilesPaginated(
      repoId,
      branch,
      folderPath,
      PAGINATED_FILE_BATCH_SIZE,
      cursor,
    );

    const files = page.files
      .filter((file) => !file.name.startsWith('.')) // Skip dotfiles (e.g. .schema.json)
      .map((file) => ({
        folderId,
        path: `${folderPath}/${file.name}`,
        content: file.content,
      }));

    return { files, nextCursor: page.nextCursor };
  }

  /**
   * Builds the folder path for a DataFolder linked to a connector account.
   * Path parts: [parentFolderPath] / basePath[0..n] / tableName (no connection name prefix).
   */
  buildConnectorFolderPath(
    _connectorDisplayName: string,
    tableSpec: BaseJsonTableSpec,
    parentFolderPath?: string,
  ): string {
    const escape = (s: string) =>
      Array.from(s)
        .map((c) => (c === '\t' ? ' ' : c)) // convert tabs to spaces
        .filter((c) => c.charCodeAt(0) > 31) // strip other control characters
        .join('')
        .replace(/[/*?"<>|]/g, ' ') // replace filesystem-unsafe chars
        .replace(/ {2,}/g, ' ') // collapse consecutive spaces
        .replace(/^[\s]+|[\s.]+$/g, ''); // trim leading whitespace; trim trailing whitespace and dots
    const parts: string[] = [];

    if (parentFolderPath) {
      // parentFolderPath already includes leading slash, strip it for joining
      parts.push(parentFolderPath.replace(/^\//, ''));
    }

    if (tableSpec.basePath && tableSpec.basePath.length > 0) {
      parts.push(...tableSpec.basePath.filter(Boolean).map(escape));
    }

    parts.push(escape(tableSpec.name));

    return '/' + parts.join('/');
  }

  /**
   * Reads schema from git.
   */
  async readSchema(
    workbookId: WorkbookId,
    connectorAccountId: string | null | undefined,
    folderPath: string | null,
  ): Promise<BaseJsonTableSpec | null> {
    if (!folderPath) return null;
    try {
      const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId ?? undefined);
      const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
      if (gitSchema) return gitSchema;
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.readSchema',
        message: 'Failed to read schema from git',
        error,
        workbookId,
        folderPath,
      });
    }
    return null;
  }

  /**
   * Returns the schema already stored in the DB for a data folder, without calling the connector.
   */
  async getStoredSchema(id: DataFolderId, actor: Actor): Promise<Record<string, unknown> | null> {
    const folder = await this.findOne(id, actor);
    return await this.readSchema(folder.workbookId, folder.connectorAccountId, folder.path);
  }

  /**
   * Fetches the full JSON Table Spec from the connector for a data folder.
   */
  async fetchSchemaSpec(id: DataFolderId, actor: Actor): Promise<BaseJsonTableSpec | null> {
    const folder = await this.findOne(id, actor);

    if (!folder.connectorAccountId || !folder.tableId || folder.tableId.length === 0) {
      return null;
    }

    const connectorAccount = await this.connectorAccountService.findOneById(folder.connectorAccountId, actor);
    if (!connectorAccount) {
      return null;
    }

    const connector = await this.connectorService.getConnector({
      service: folder.connectorService!,
      connectorAccount: connectorAccount as ConnectorAccount,
      decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
    });

    try {
      const tableSpec = await connector.fetchJsonTableSpec({
        wsId: folder.tableId[0],
        remoteId: folder.tableId,
      });

      // Re-apply user field overrides from options
      const options =
        folder.options && typeof folder.options === 'object' && !Array.isArray(folder.options) ? folder.options : {};
      const idOverride = 'idFieldOverride' in options ? options.idFieldOverride : undefined;
      const nameOverride = 'nameFieldOverride' in options ? options.nameFieldOverride : undefined;
      if (typeof idOverride === 'string') {
        tableSpec.idColumnRemoteId = idOverride;
      }
      if (typeof nameOverride === 'string') {
        tableSpec.titleColumnRemoteId = [nameOverride];
      }

      // Persist refreshed schema with overrides
      await this.db.client.dataFolder.update({
        where: { id },
        data: { lastSchemaRefreshAt: new Date() },
      });

      // Write schema to git repo
      try {
        const repoId = await this.scratchGitService.resolveRepoId(
          folder.workbookId,
          folder.connectorAccountId ?? undefined,
        );
        await this.scratchGitService.writeSchemaToGit(repoId, folder.path!, tableSpec);
      } catch (error) {
        WSLogger.error({
          source: 'DataFolderService.fetchSchemaSpec',
          message: 'Failed to write schema to git',
          error,
          dataFolderId: id,
        });
      }

      return tableSpec;
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.fetchSchemaSpec',
        message: 'Failed to fetch schema from connector',
        error,
        dataFolderId: id,
      });
      return null;
    }
  }

  /**
   * Returns schema paths (dot notation) for a data folder.
   * Tries to read the schema from the git repo first, falling back to the connector.
   */
  async getSchemaPaths(id: DataFolderId, actor: Actor): Promise<SchemaField[]> {
    let spec = (await this.getStoredSchema(id, actor)) as BaseJsonTableSpec | null;
    if (!spec || !spec.schema) {
      WSLogger.warn({
        source: 'DataFolderService.getSchemaPaths',
        message: 'Schema missing from git, fetching from connector',
        dataFolderId: id,
      });
      spec = await this.fetchSchemaSpec(id, actor);
    }
    if (!spec || !spec.schema) {
      return [];
    }
    return extractSchemaFields(spec.schema);
  }
}
