import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ConnectorPullOptions,
  createWorkbookId,
  DataFolderId,
  PullFilesResponseDto,
  UpdateWorkbookDto,
  ValidatedCreateWorkbookDto,
  WorkbookId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { Actor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { WorkbookEventService } from './workbook-event.service';

import { Schedule } from '@prisma/client';
import { FileIndexService } from '../publish-plan/file-index.service';
import { FileReferenceService } from '../publish-plan/file-reference.service';

@Injectable()
export class WorkbookService {
  constructor(
    private readonly db: DbService,
    private readonly configService: ScratchConfigService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly posthogService: PostHogService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly auditLogService: AuditLogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
  ) {}

  async create(createWorkbookDto: ValidatedCreateWorkbookDto, actor: Actor): Promise<WorkbookCluster.Workbook> {
    const { name, version } = createWorkbookDto;

    const workbookId = createWorkbookId();

    const newWorkbook = await this.db.client.workbook.create({
      data: {
        id: workbookId,
        userId: actor.userId,
        organizationId: actor.organizationId,
        name: name ?? `New workbook`,
        ...(version !== undefined ? { version } : { version: 2 }),
      },
      include: WorkbookCluster._validator.include,
    });

    WSLogger.info({
      source: 'WorkbookService.create',
      message: 'Workbook created',
      workbookId: newWorkbook.id,
    });

    this.posthogService.trackCreateWorkbook(actor, newWorkbook);
    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created workbook ${newWorkbook.name}`,
      entityId: newWorkbook.id as WorkbookId,
      context: {},
    });

    // Initialize Git Repo
    try {
      await this.scratchGitService.initRepo(newWorkbook.id as WorkbookId);
    } catch (err) {
      WSLogger.error({
        source: 'WorkbookService.create',
        message: 'Failed to init git repo',
        error: err,
        workbookId: newWorkbook.id,
      });
    }

    return newWorkbook;
  }

  async delete(id: WorkbookId, actor: Actor): Promise<void> {
    const workbook = await this.findOneOrThrow(id, actor); // Permissions

    // Delete Git Repo
    try {
      await this.scratchGitService.deleteRepo(id);
    } catch (err) {
      WSLogger.error({
        source: 'WorkbookService.delete',
        message: 'Failed to delete git repo',
        error: err,
        workbookId: id,
      });
    }

    // Cleanup index and references
    await this.fileIndexService.deleteForWorkbook(id);
    await this.fileReferenceService.deleteForWorkbook(id);

    await this.db.client.workbook.delete({
      where: { id },
    });

    this.posthogService.trackRemoveWorkbook(actor, workbook);
    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted workbook ${workbook.name}`,
      entityId: workbook.id as WorkbookId,
      context: {},
    });
  }

  async discardChanges(workbookId: WorkbookId, actor: Actor, path?: string): Promise<void> {
    const workbook = await this.findOneOrThrow(workbookId, actor);

    if (path) {
      // Resolve the repo for this specific file's folder
      const rawFolder = path.substring(0, path.lastIndexOf('/'));
      const folderPath = rawFolder ? (rawFolder.startsWith('/') ? rawFolder : `/${rawFolder}`) : '/';
      const dataFolder = await this.db.client.dataFolder.findFirst({
        where: { workbookId, path: folderPath },
        select: { connectorAccountId: true },
      });
      const repoId = await this.scratchGitService.resolveRepoId(
        workbookId,
        dataFolder?.connectorAccountId ?? undefined,
      );
      await this.scratchGitService.discardChanges(repoId, path);
    } else if (workbook.version >= 2) {
      // Discard all: reset every per-connection repo
      const connAccounts = await this.db.client.connectorAccount.findMany({
        where: { workbookId },
        select: { id: true },
      });
      await Promise.all(
        connAccounts.map(async (ca) => {
          const repoId = await this.scratchGitService.resolveRepoId(workbookId, ca.id);
          return this.scratchGitService.discardChanges(repoId);
        }),
      );
    } else {
      await this.scratchGitService.discardChanges(workbookId);
    }

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'changes-discarded',
      data: { source: 'user', entityId: workbookId, message: 'Changes discarded', path },
    });

    this.posthogService.trackDiscardWorkbookChanges(actor, workbook, path);

    // Track event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Discarded unpublished changes in workbook${path ? ` for ${path}` : ''}`,
      entityId: workbookId,
    });
  }

  async resetWorkbook(id: WorkbookId, actor: Actor): Promise<void> {
    const workbook = await this.findOneOrThrow(id, actor);

    if (workbook.version >= 2) {
      // V2: one repo per connection — delete & re-init each connection's repo
      const connectorAccounts = await this.db.client.connectorAccount.findMany({
        where: { workbookId: id },
        select: { id: true },
      });
      for (const ca of connectorAccounts) {
        const repoId = await this.scratchGitService.resolveRepoId(id, ca.id);
        try {
          await this.scratchGitService.deleteRepo(repoId);
        } catch (err) {
          WSLogger.error({
            source: 'WorkbookService.resetWorkbook',
            message: 'Failed to delete V2 git repo during reset',
            error: err,
            workbookId: id,
            connectorAccountId: ca.id,
          });
        }
        try {
          await this.scratchGitService.initRepo(repoId);
        } catch (err) {
          WSLogger.error({
            source: 'WorkbookService.resetWorkbook',
            message: 'Failed to re-init V2 git repo during reset',
            error: err,
            workbookId: id,
            connectorAccountId: ca.id,
          });
          throw err;
        }
      }
    } else {
      // V1: single repo per workbook
      try {
        await this.scratchGitService.deleteRepo(id);
      } catch (err) {
        WSLogger.error({
          source: 'WorkbookService.resetWorkbook',
          message: 'Failed to delete git repo during reset',
          error: err,
          workbookId: id,
        });
      }

      try {
        await this.scratchGitService.initRepo(id);
      } catch (err) {
        WSLogger.error({
          source: 'WorkbookService.resetWorkbook',
          message: 'Failed to re-init git repo during reset',
          error: err,
          workbookId: id,
        });
        throw err;
      }
    }

    // Cleanup index and references
    await this.fileIndexService.deleteForWorkbook(id);
    await this.fileReferenceService.deleteForWorkbook(id);

    // Delete all jobs for this workbook
    await this.db.client.dbJob.deleteMany({
      where: { workbookId: id },
    });

    // Delete all data folders
    await this.db.client.dataFolder.deleteMany({
      where: { workbookId: id },
    });

    // Delete all publish pipelines (V2)
    await this.db.client.publishPlan.deleteMany({
      where: { workbookId: id },
    });

    this.posthogService.trackResetWorkbook(actor, workbook);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update', // Using update as "reset" is a form of update to base state
      message: `Reset workbook ${workbook.name}`,
      entityId: workbook.id as WorkbookId,
      context: { action: 'reset_workbook' },
    });
  }

  findAllForConnectorAccount(
    connectorAccountId: string,
    actor: Actor,
    sortBy: 'name' | 'createdAt' | 'updatedAt' = 'createdAt',
    sortOrder: 'asc' | 'desc' = 'desc',
  ): Promise<WorkbookCluster.Workbook[]> {
    return this.db.client.workbook.findMany({
      where: {
        userId: actor.userId,
        dataFolders: {
          some: {
            connectorAccountId,
          },
        },
      },
      orderBy: {
        [sortBy]: sortOrder,
      },
      include: WorkbookCluster._validator.include,
    });
  }

  findAllForUser(
    actor: Actor,
    sortBy: 'name' | 'createdAt' | 'updatedAt' = 'createdAt',
    sortOrder: 'asc' | 'desc' = 'desc',
  ): Promise<WorkbookCluster.Workbook[]> {
    return this.db.client.workbook.findMany({
      where: {
        userId: actor.userId,
      },
      orderBy: {
        [sortBy]: sortOrder,
      },
      include: WorkbookCluster._validator.include,
    });
  }

  findOne(id: WorkbookId, actor: Actor): Promise<WorkbookCluster.Workbook | null> {
    return this.db.client.workbook.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: WorkbookCluster._validator.include,
    });
  }

  private async findOneOrThrow(id: WorkbookId, actor: Actor): Promise<WorkbookCluster.Workbook> {
    const workbook = await this.findOne(id, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }
    return workbook;
  }

  async update(id: WorkbookId, updateWorkbookDto: UpdateWorkbookDto, actor: Actor): Promise<WorkbookCluster.Workbook> {
    // Check that the snapshot exists and belongs to the user.
    await this.findOneOrThrow(id, actor);

    const updatedWorkbook = await this.db.client.workbook.update({
      where: { id },
      data: updateWorkbookDto,
      include: WorkbookCluster._validator.include,
    });

    this.posthogService.trackUpdateWorkbook(actor, updatedWorkbook);
    this.workbookEventService.sendWorkbookEvent(id, {
      type: 'workbook-updated',
      data: { source: 'user', entityId: id, message: 'Workbook modified' },
    });

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated snapshot ${updatedWorkbook.name}`,
      entityId: updatedWorkbook.id as WorkbookId,
      context: {
        changes: Object.keys(updateWorkbookDto),
      },
    });

    return updatedWorkbook;
  }

  async pullFiles(id: WorkbookId, actor: Actor, dataFolderIds?: string[]): Promise<PullFilesResponseDto> {
    // Verify the workbook exists and the user has access
    const workbook = await this.findOneOrThrow(id, actor);

    // Fetch data folders that have connectors (linked folders)
    let foldersToProcess = await this.db.client.dataFolder.findMany({
      where: {
        workbookId: id,
        connectorAccountId: { not: null },
      },
      include: {
        connectorAccount: true,
      },
    });

    // Filter to specific folders if IDs provided
    if (dataFolderIds && dataFolderIds.length > 0) {
      foldersToProcess = foldersToProcess.filter((f) => dataFolderIds.includes(f.id));
    }

    if (foldersToProcess.length === 0) {
      return {
        warning:
          'No data folders are linked so pull is a no-op. Please link folders in the web app or with `scratchmd link add`.',
      };
    }

    // Set lock='pull' for all folders before enqueuing jobs
    await this.db.client.dataFolder.updateMany({
      where: {
        id: { in: foldersToProcess.map((f) => f.id) },
      },
      data: {
        lock: 'pull',
      },
    });

    foldersToProcess.forEach((folder) => {
      this.workbookEventService.sendWorkbookEvent(id, {
        type: 'folder-updated',
        data: { source: 'user', entityId: folder.id, message: 'Folder status set to pull' },
      });
    });

    // Group folders by connectorAccountId and enqueue one pull job per connection
    const foldersByConnection = new Map<string, typeof foldersToProcess>();
    for (const folder of foldersToProcess) {
      const connKey = folder.connectorAccountId!;
      const group = foldersByConnection.get(connKey) ?? [];
      group.push(folder);
      foldersByConnection.set(connKey, group);
    }

    const jobs: { id: string }[] = [];
    for (const [, connFolders] of foldersByConnection) {
      const firstFolder = connFolders[0];
      const job = await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
        id,
        actor,
        connFolders.map((f) => f.id as DataFolderId),
        {
          totalFiles: 0,
          folderCount: connFolders.length,
          connectionName: firstFolder.connectorAccount?.displayName ?? 'Unknown connection',
          folderId: firstFolder.id,
          folderName: firstFolder.name,
          connector: firstFolder.connectorService ?? 'unknown',
          filter: (firstFolder.options as unknown as ConnectorPullOptions)?.filter ?? null,
          status: 'pending',
          createdPaths: [],
          updatedPaths: [],
          deletedPaths: [],
        },
      );
      jobs.push({ id: job.id as string });
    }

    this.posthogService.trackPullFilesForWorkbook(actor, workbook, {
      dataFolderCount: foldersToProcess.length,
    });

    return {
      // Return the first job ID for backward compatibility
      jobId: jobs[0].id,
      jobIds: jobs.map((j) => j.id),
    };
  }

  /**
   * Fetches all schedules for a workbook and groups them by entityId.
   */
  public async fetchSchedulesByEntityId(workbookId: WorkbookId): Promise<Map<string, Schedule[]>> {
    const schedules = await this.db.client.schedule.findMany({
      where: { workbookId },
    });
    const map = new Map<string, Schedule[]>();
    for (const schedule of schedules) {
      const existing = map.get(schedule.entityId);
      if (existing) {
        existing.push(schedule);
      } else {
        map.set(schedule.entityId, [schedule]);
      }
    }
    return map;
  }
}
