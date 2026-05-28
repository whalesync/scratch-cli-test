import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { ExportSyncConfig, SaveSyncBody, SyncId, WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { SyncService } from 'src/sync/sync.service';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';

/**
 * Controller for CLI sync operations.
 * All endpoints are workbook-scoped and require API token authentication.
 */
@Controller('cli/v1/workbooks/:workbookId')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class CliSyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly workbookService: WorkbookService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly db: DbService,
    private readonly posthogService: PostHogService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('syncs')
  async listSyncs(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<unknown> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    const result = await this.syncService.findAllForWorkbook(workbookId, actor);
    this.posthogService.trackCliListSyncs(actor, workbookId, { scope: 'list' });
    return result;
  }

  @Post('syncs')
  async createSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: SaveSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const sync = (await this.syncService.createSync(workbookId, body, actor)) as { id: string } & Record<
      string,
      unknown
    >;

    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created sync ${body.displayName} in ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.sync.create',
        workbookId,
        syncId: sync.id,
        displayName: body.displayName,
      },
    });

    return sync;
  }

  @Get('syncs/export')
  async exportSyncs(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('syncId') syncId: SyncId | undefined,
    @Req() req: RequestWithUser,
  ): Promise<ExportSyncConfig[]> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return await this.syncService.exportSyncs(workbookId, syncId, actor);
  }

  @Get('syncs/:syncId')
  async getSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    // findOneForWorkbook routes through the SyncService choke point: scopes
    // the query to the workbook and resolves v1/v2 mappings to the on-disk
    // shape. Throws NotFoundException if the sync is missing.
    const sync = await this.syncService.findOneForWorkbook(workbookId, syncId as SyncId, actor);
    this.posthogService.trackCliListSyncs(actor, workbookId, { syncId, scope: 'single' });
    return sync;
  }

  @Patch('syncs/:syncId')
  async updateSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Body() body: SaveSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const result = await this.syncService.updateSync(workbookId, syncId as SyncId, body, actor);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated sync ${body.displayName} in ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.sync.update',
        workbookId,
        syncId,
        displayName: body.displayName,
      },
    });

    return result;
  }

  @Delete('syncs/:syncId')
  async deleteSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    await this.syncService.deleteSync(workbookId, syncId as SyncId, actor);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted sync ${syncId} from ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.sync.delete',
        workbookId,
        syncId,
      },
    });

    return { success: true };
  }

  @Post('syncs/:syncId/run')
  async runSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    // eslint-disable-next-line no-restricted-syntax -- TODO(DEV-10008): existence check + posthog metadata only; no mappings read.
    const sync = await this.db.client.sync.findFirst({
      where: {
        id: syncId,
        syncTablePairs: {
          some: {
            sourceDataFolder: { workbookId },
          },
        },
      },
    });

    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    const job = await this.bullEnqueuerService.enqueueSyncDataFoldersJob(
      workbookId,
      syncId as SyncId,
      {
        userId: req.user.id,
        organizationId: req.user.organizationId ?? workbook.organizationId,
      },
      undefined,
      createRunContext('cli'),
    );

    this.posthogService.trackStartSyncRun(userToActor(req.user), sync);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Queued sync run ${syncId} for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.sync.run',
        workbookId,
        syncId,
        jobId: job.id ?? null,
      },
    });

    return {
      success: true,
      jobId: job.id,
      message: 'Sync job queued successfully',
    };
  }
}
