import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  ApplySyncDraftResponse,
  MaterializeResponse,
  SaveSyncDraftResponse,
  SyncDraft,
  SyncDraftId,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import {
  ApplySyncDraftDtoClass,
  CreateSyncDraftDtoClass,
  PatchSyncDraftDtoClass,
  SaveSyncDraftDtoClass,
} from './dto/sync-draft.dto';
import { SyncDraftService } from './sync-draft.service';

/**
 * SyncDraft HTTP surface. The open call is workbook-scoped; the per-draft routes
 * carry no workbookId — the service loads the draft, reads its workbookId, then
 * runs the readable/writable permission check.
 */
@Controller()
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class SyncDraftController {
  constructor(private readonly syncDraftService: SyncDraftService) {}

  /**
   * Open the editor for a target: get-or-create the active draft keyed by
   * `(workbookId, fromSyncId ?? null)`. Idempotent (200) — safe to call on every
   * cold page load, so the client never tracks the draft id.
   */
  @Post('workbooks/:workbookId/sync-drafts')
  @HttpCode(200)
  async getOrCreate(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateSyncDraftDtoClass,
    @Req() req: RequestWithUser,
  ): Promise<SyncDraft> {
    const actor = userToActor(req.user);
    return this.syncDraftService.getOrCreate(workbookId, dto, actor);
  }

  @Get('sync-drafts/:draftId')
  async get(@Param('draftId') draftId: SyncDraftId, @Req() req: RequestWithUser): Promise<SyncDraft> {
    const actor = userToActor(req.user);
    return this.syncDraftService.get(draftId, actor);
  }

  @Patch('sync-drafts/:draftId')
  async patch(
    @Param('draftId') draftId: SyncDraftId,
    @Body() dto: PatchSyncDraftDtoClass,
    @Req() req: RequestWithUser,
  ): Promise<SyncDraft> {
    const actor = userToActor(req.user);
    return this.syncDraftService.patch(draftId, dto, actor);
  }

  @Post('sync-drafts/:draftId/materialize')
  @HttpCode(200)
  async materialize(@Param('draftId') draftId: SyncDraftId, @Req() req: RequestWithUser): Promise<MaterializeResponse> {
    const actor = userToActor(req.user);
    return this.syncDraftService.materialize(draftId, actor);
  }

  @Post('sync-drafts/:draftId/apply')
  @HttpCode(200)
  async apply(
    @Param('draftId') draftId: SyncDraftId,
    @Body() dto: ApplySyncDraftDtoClass,
    @Req() req: RequestWithUser,
  ): Promise<ApplySyncDraftResponse> {
    const actor = userToActor(req.user);
    return this.syncDraftService.apply(draftId, actor, { createRoutine: dto.createRoutine ?? false });
  }

  /**
   * Save the draft as a background job (DEV-10875): enqueue `apply-sync-draft` (materialize →
   * apply with per-placeholder progress) and acknowledge with 202 `{ jobId }`. Poll the job via
   * GET /jobs/:jobId/progress; while it runs, the draft's `activeSaveJobId` carries the same id so
   * a reloaded page rediscovers the in-flight save. Single-flight per draft — saving while a save
   * job is already running returns that job's id. The synchronous materialize/apply endpoints
   * above remain for rollout/back-compat and 409 (`SYNC_DRAFT_SAVE_IN_PROGRESS`) while a save job
   * is running.
   */
  @Post('sync-drafts/:draftId/save')
  @HttpCode(202)
  async save(
    @Param('draftId') draftId: SyncDraftId,
    @Body() dto: SaveSyncDraftDtoClass,
    @Req() req: RequestWithUser,
  ): Promise<SaveSyncDraftResponse> {
    const actor = userToActor(req.user);
    return this.syncDraftService.save(draftId, { createRoutine: dto.createRoutine ?? false }, actor);
  }

  @Delete('sync-drafts/:draftId')
  @HttpCode(204)
  async delete(@Param('draftId') draftId: SyncDraftId, @Req() req: RequestWithUser): Promise<void> {
    const actor = userToActor(req.user);
    return this.syncDraftService.delete(draftId, actor);
  }
}
