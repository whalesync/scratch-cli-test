import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import { Progress } from 'src/types/progress';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { BullEnqueuerService } from '../worker-enqueuer/bull-enqueuer.service';
import { PublishPlanBuildDto, PublishPlanRunDto } from './dto/publish-v2.dto';
import { PublishPlanBuildService } from './publish-plan-build.service';
import { PublishPlanCrudService } from './publish-plan-crud.service';
import { PublishPlanRunService } from './publish-plan-run.service';

@Controller('workbook/:workbookId/publish-v2')
@UseGuards(ScratchAuthGuard)
export class PublishPlanController {
  constructor(
    private readonly publishPlanService: PublishPlanBuildService,
    private readonly publishRunService: PublishPlanRunService,
    private readonly publishAdminService: PublishPlanCrudService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly db: DbService,
  ) {}

  // ── Job API (asynchronous, resumable) ────────────────────────────

  @Post('plan-job')
  async planAsJob(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PublishPlanBuildDto,
    @Req() req: RequestWithUser,
  ) {
    console.log(
      `[DEBUG Controller] /plan-job called. body.filePath: ${body.filePath}, body.folderPath: ${body.folderPath}`,
    );
    const hasDiffs = await this.publishPlanService.hasDiffs(
      workbookId,
      body.connectorAccountId,
      body.folderPath,
      body.filePath,
    );
    if (!hasDiffs) {
      return { jobId: null, pipelineId: null };
    }

    // Create the pipeline record first so we can return the pipelineId immediately
    const { pipelineId } = await this.publishPlanService.createPipeline(
      workbookId,
      req.user.id,
      body.connectorAccountId,
      // body.folderPath,
      // body.filePath,
    );

    let initialProgress: Progress | undefined;
    const existingPlan = await this.db.client.publishPlan.findUnique({ where: { id: pipelineId } });
    if (existingPlan?.activeJobId) {
      const dbJob = await this.db.client.dbJob.findFirst({ where: { bullJobId: existingPlan.activeJobId } });
      if (dbJob?.progress) {
        initialProgress = dbJob.progress as Progress;
      }
    }

    const job = await this.bullEnqueuerService.enqueuePlanPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      pipelineId,
      body.connectorAccountId,
      body.runAfterPlan,
      body.folderPath,
      body.filePath,
      initialProgress,
    );
    await this.publishPlanService.setActiveJob(pipelineId, job.id!.toString());
    return { jobId: job.id, pipelineId };
  }

  @Post('run-job')
  async runAsJob(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PublishPlanRunDto,
    @Req() req: RequestWithUser,
  ) {
    let initialProgress: Progress | undefined;
    const existingPlan = await this.db.client.publishPlan.findUnique({ where: { id: body.pipelineId } });
    if (existingPlan?.activeJobId) {
      const dbJob = await this.db.client.dbJob.findFirst({ where: { bullJobId: existingPlan.activeJobId } });
      if (dbJob?.progress) {
        initialProgress = dbJob.progress as Progress;
      }
    }

    const job = await this.bullEnqueuerService.enqueueRunPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      body.pipelineId,
      body.executeSinglePhase,
      initialProgress,
    );
    await this.publishPlanService.setActiveJob(body.pipelineId, job.id!.toString());
    return { jobId: job.id };
  }

  // ── Admin / Query ────────────────────────────────────────────────

  @Get()
  list(@Param('workbookId') workbookId: WorkbookId, @Query('connectorAccountId') connectorAccountId?: string) {
    return this.publishAdminService.listPublishPlans(workbookId, connectorAccountId);
  }

  @Get(':pipelineId/operations')
  operations(@Param('pipelineId') pipelineId: string) {
    return this.publishAdminService.listPublishPlanOperations(pipelineId);
  }

  @Get('index/files')
  fileIndex(@Param('workbookId') workbookId: WorkbookId) {
    return this.publishAdminService.listFileIndex(workbookId);
  }

  @Get('index/refs')
  refIndex(@Param('workbookId') workbookId: WorkbookId) {
    return this.publishAdminService.listRefIndex(workbookId);
  }

  @Delete(':pipelineId')
  delete(@Param('pipelineId') pipelineId: string) {
    return this.publishAdminService.deletePublishPlan(pipelineId);
  }
}
