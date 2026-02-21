import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { SaveSyncBody, SyncId, WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { SyncService } from 'src/sync/sync.service';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';

/**
 * Controller for CLI sync operations.
 * All endpoints are workbook-scoped and require API token authentication.
 */
@Controller('cli/v1/workbooks/:workbookId')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(ScratchAuthGuard)
export class CliSyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly workbookService: WorkbookService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly db: DbService,
    private readonly posthogService: PostHogService,
  ) {}

  @Get('syncs')
  async listSyncs(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<unknown> {
    const actor = userToActor(req.user);
    await this.verifyWorkbookAccess(workbookId, req);
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
    await this.verifyWorkbookAccess(workbookId, req);
    return await this.syncService.createSync(workbookId, body, userToActor(req.user));
  }

  @Get('syncs/:syncId')
  async getSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    await this.verifyWorkbookAccess(workbookId, req);
    const sync = await this.db.client.sync.findUnique({
      where: { id: syncId },
      include: { syncTablePairs: true },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
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
    await this.verifyWorkbookAccess(workbookId, req);
    return await this.syncService.updateSync(workbookId, syncId as SyncId, body, userToActor(req.user));
  }

  @Delete('syncs/:syncId')
  async deleteSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ): Promise<{ success: boolean }> {
    await this.verifyWorkbookAccess(workbookId, req);
    await this.syncService.deleteSync(workbookId, syncId as SyncId, userToActor(req.user));
    return { success: true };
  }

  @Post('syncs/:syncId/run')
  async runSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ) {
    const workbook = await this.verifyWorkbookAccess(workbookId, req);

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

    const job = await this.bullEnqueuerService.enqueueSyncDataFoldersJob(workbookId, syncId as SyncId, {
      userId: req.user.id,
      organizationId: req.user.organizationId ?? workbook.organizationId,
    });

    this.posthogService.trackStartSyncRun(userToActor(req.user), sync);

    return {
      success: true,
      jobId: job.id,
      message: 'Sync job queued successfully',
    };
  }

  private async verifyWorkbookAccess(workbookId: WorkbookId, req: RequestWithUser) {
    const workbook = await this.workbookService.findOne(workbookId, userToActor(req.user));
    if (!workbook) {
      throw new ForbiddenException('You do not have access to this workbook');
    }
    return workbook;
  }
}
