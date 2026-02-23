import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { BullEnqueuerService } from '../worker-enqueuer/bull-enqueuer.service';
import { PlanPublishV2Dto, RunPublishV2Dto } from './dto/publish-v2.dto';
import { PublishAdminService } from './publish-admin.service';
import { PublishPlanService } from './publish-plan.service';
import { PublishRunService } from './publish-run.service';

@Controller('workbook/:workbookId/publish-v2')
@UseGuards(ScratchAuthGuard)
export class PublishPipelineController {
  constructor(
    private readonly publishPlanService: PublishPlanService,
    private readonly publishRunService: PublishRunService,
    private readonly publishAdminService: PublishAdminService,
    private readonly bullEnqueuerService: BullEnqueuerService,
  ) {}

  // ── Direct API (synchronous) ─────────────────────────────────────

  @Post('plan')
  async plan(@Param('workbookId') workbookId: WorkbookId, @Body() body: PlanPublishV2Dto, @Req() req: RequestWithUser) {
    return this.publishPlanService.buildPipeline(workbookId, req.user.id, body.connectorAccountId);
  }

  @Post('run')
  async run(@Param('workbookId') workbookId: WorkbookId, @Body() body: RunPublishV2Dto) {
    return this.publishRunService.runPipeline(body.pipelineId, body.phase);
  }

  // ── Job API (asynchronous, resumable) ────────────────────────────

  @Post('plan-job')
  async planAsJob(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PlanPublishV2Dto,
    @Req() req: RequestWithUser,
  ) {
    const hasDiffs = await this.publishPlanService.hasDiffs(workbookId, body.connectorAccountId);
    if (!hasDiffs) {
      return { jobId: null, pipelineId: null };
    }

    // Create the pipeline record first so we can return the pipelineId immediately
    const { pipelineId } = await this.publishPlanService.createPipeline(
      workbookId,
      req.user.id,
      body.connectorAccountId,
    );

    const job = await this.bullEnqueuerService.enqueuePlanPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      pipelineId,
      body.connectorAccountId,
      body.runAfterPlan,
    );
    await this.publishPlanService.setActiveJob(pipelineId, job.id!.toString());
    return { jobId: job.id, pipelineId };
  }

  @Post('run-job')
  async runAsJob(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: RunPublishV2Dto,
    @Req() req: RequestWithUser,
  ) {
    const job = await this.bullEnqueuerService.enqueueRunPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      body.pipelineId,
      body.phase,
    );
    await this.publishPlanService.setActiveJob(body.pipelineId, job.id!.toString());
    return { jobId: job.id };
  }

  // ── Admin / Query ────────────────────────────────────────────────

  @Get()
  async list(@Param('workbookId') workbookId: WorkbookId, @Query('connectorAccountId') connectorAccountId?: string) {
    return this.publishAdminService.listPipelines(workbookId, connectorAccountId);
  }

  @Get(':pipelineId/entries')
  async entries(@Param('pipelineId') pipelineId: string) {
    return this.publishAdminService.listPipelineEntries(pipelineId);
  }

  @Get('index/files')
  async fileIndex(@Param('workbookId') workbookId: WorkbookId) {
    return this.publishAdminService.listFileIndex(workbookId);
  }

  @Get('index/refs')
  async refIndex(@Param('workbookId') workbookId: WorkbookId) {
    return this.publishAdminService.listRefIndex(workbookId);
  }

  @Delete(':pipelineId')
  async delete(@Param('pipelineId') pipelineId: string) {
    return this.publishAdminService.deletePipeline(pipelineId);
  }
}
