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
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  AiContextResponse,
  DataFolderId,
  PreviewRecordBody,
  PreviewRecordResponse,
  SaveSyncBody,
  SyncId,
  ValidateMappingBody,
  WhalesyncImportPreviewBody,
  WhalesyncImportPreviewResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { userToActor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { SyncService } from './sync.service';
import { WhalesyncImportApiService } from './whalesync-import';

@Controller('workbooks/:workbookId/syncs')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly whalesyncImportApiService: WhalesyncImportApiService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly dbService: DbService,
    private readonly posthogService: PostHogService,
  ) {}

  @Post()
  async createSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: SaveSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    return await this.syncService.createSync(workbookId, body, userToActor(req.user));
  }

  @Patch(':syncId')
  async updateSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Body() body: SaveSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    return await this.syncService.updateSync(workbookId, syncId, body, userToActor(req.user));
  }
  @Get()
  async listSyncs(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<unknown> {
    return await this.syncService.findAllForWorkbook(workbookId, userToActor(req.user));
  }

  @Get('ai-context')
  async getAiContext(
    @Param('workbookId') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<AiContextResponse> {
    return this.syncService.generateAiContext(workbookId, userToActor(req.user));
  }

  @Get(':syncId')
  async getSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    return await this.syncService.findOneForWorkbook(workbookId, syncId, userToActor(req.user));
  }

  @Post(':syncId/run')
  async runSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Req() req: RequestWithUser,
  ) {
    const workbook = await this.dbService.client.workbook.findUnique({
      where: { id: workbookId },
      select: { userId: true, organizationId: true },
    });

    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    const sync = await this.dbService.client.sync.findFirst({
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
      throw new NotFoundException(`Sync ${syncId} not found`);
    }

    const job = await this.bullEnqueuerService.enqueueSyncDataFoldersJob(workbookId, syncId, {
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
  @Delete(':syncId')
  async deleteSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return await this.syncService.deleteSync(workbookId, syncId as SyncId, userToActor(req.user));
  }

  @Post('import-preview')
  async previewWhalesyncImport(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: WhalesyncImportPreviewBody,
    @Req() req: RequestWithUser,
  ): Promise<WhalesyncImportPreviewResponse> {
    return this.whalesyncImportApiService.previewImport(workbookId, body, userToActor(req.user));
  }

  @Post('preview-record')
  async previewRecord(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PreviewRecordBody,
    @Req() req: RequestWithUser,
  ): Promise<PreviewRecordResponse> {
    return this.syncService.previewRecord(workbookId, body, userToActor(req.user));
  }

  @Post('validate-mapping')
  async validateMapping(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: ValidateMappingBody,
    @Req() req: RequestWithUser,
  ): Promise<{ valid: boolean }> {
    const valid = await this.syncService.validateFolderMapping(
      workbookId,
      body.sourceId as DataFolderId,
      body.destId as DataFolderId,
      body.columnMappings,
      userToActor(req.user),
    );
    return { valid };
  }
}
