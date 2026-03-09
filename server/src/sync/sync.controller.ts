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
  AiEditSyncBody,
  AiGenerateSyncBody,
  AiGenerateSyncResponse,
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
import { checkWorkspacePermissions } from 'src/users/permissions';
import { userToActor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { AiSyncBuilderService } from './ai-sync-builder.service';
import { SyncService } from './sync.service';
import { WhalesyncImportApiService } from './whalesync-import';

@Controller('workbooks/:workbookId/syncs')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly aiSyncBuilderService: AiSyncBuilderService,
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
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.syncService.createSync(workbookId, body, actor);
  }

  @Patch(':syncId')
  async updateSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Body() body: SaveSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.syncService.updateSync(workbookId, syncId, body, actor);
  }
  @Get()
  async listSyncs(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.syncService.findAllForWorkbook(workbookId, actor);
  }

  @Get('ai-context')
  async getAiContext(
    @Param('workbookId') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<AiContextResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.syncService.generateAiContext(workbookId, actor);
  }

  @Post('ai-generate')
  async aiGenerateSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: AiGenerateSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<AiGenerateSyncResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.aiSyncBuilderService.generateSyncFromPrompt(workbookId, body.prompt, actor, body.model);
  }

  @Post(':syncId/ai-edit')
  async aiEditSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Body() body: AiEditSyncBody,
    @Req() req: RequestWithUser,
  ): Promise<AiGenerateSyncResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.aiSyncBuilderService.editSyncWithPrompt(workbookId, syncId, body.prompt, actor, body.model);
  }

  @Get(':syncId')
  async getSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.syncService.findOneForWorkbook(workbookId, syncId, actor);
  }

  @Post(':syncId/run')
  async runSync(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('syncId') syncId: SyncId,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);

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

    const job = await this.bullEnqueuerService.enqueueSyncDataFoldersJob(
      workbookId,
      syncId,
      {
        userId: req.user.id,
        organizationId: req.user.organizationId ?? workbook.organizationId,
      },
      undefined,
      createRunContext('web'),
    );

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
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.syncService.deleteSync(workbookId, syncId as SyncId, actor);
  }

  @Post('import-preview')
  async previewWhalesyncImport(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: WhalesyncImportPreviewBody,
    @Req() req: RequestWithUser,
  ): Promise<WhalesyncImportPreviewResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.whalesyncImportApiService.previewImport(workbookId, body, actor);
  }

  @Post('preview-record')
  async previewRecord(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PreviewRecordBody,
    @Req() req: RequestWithUser,
  ): Promise<PreviewRecordResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.syncService.previewRecord(workbookId, body, actor);
  }

  @Post('validate-mapping')
  async validateMapping(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: ValidateMappingBody,
    @Req() req: RequestWithUser,
  ): Promise<{ valid: boolean }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const valid = await this.syncService.validateFolderMapping(
      workbookId,
      body.sourceId as DataFolderId,
      body.destId as DataFolderId,
      body.columnMappings,
      actor,
    );
    return { valid };
  }
}
