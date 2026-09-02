import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { PublishPlanChangedFilesResponse, PublishPlanFileDiff, WorkbookId } from '@spinner/shared-types';
import { Progress } from 'src/types/progress';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { checkWorkspacePermissions } from '../users/permissions';
import { userToActor } from '../users/types';
import { BullEnqueuerService } from '../worker-enqueuer/bull-enqueuer.service';
import { PublishPlanBuildDto, PublishPlanRunDto } from './dto/publish-v2.dto';
import { PublishPlanBuildService } from './publish-plan-build.service';
import { PublishPlanCrudService } from './publish-plan-crud.service';
import { PublishPlanDiffService } from './publish-plan-diff.service';
import { PublishPlanRunService } from './publish-plan-run.service';

@Controller('workbook/:workbookId/publish-v2')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class PublishPlanController {
  constructor(
    private readonly publishPlanService: PublishPlanBuildService,
    private readonly publishRunService: PublishPlanRunService,
    private readonly publishAdminService: PublishPlanCrudService,
    private readonly publishPlanDiffService: PublishPlanDiffService,
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
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);

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
      createRunContext('web'),
      body.expectedBaseDirtyHead,
    );
    if (job.id === undefined) {
      throw new Error(`Plan-pipeline job for pipeline ${pipelineId} was enqueued without an id`);
    }
    await this.publishPlanService.setActiveJob(pipelineId, job.id.toString());
    return { jobId: job.id, pipelineId };
  }

  @Post('run-job')
  async runAsJob(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: PublishPlanRunDto,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);

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
      createRunContext('web'),
      body.publishOrigin,
    );
    if (job.id === undefined) {
      throw new Error(`Run-pipeline job for pipeline ${body.pipelineId} was enqueued without an id`);
    }
    await this.publishPlanService.setActiveJob(body.pipelineId, job.id.toString());
    return { jobId: job.id };
  }

  // ── Admin / Query ────────────────────────────────────────────────

  @Get()
  list(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.listPublishPlans(workbookId, {
      connectorAccountId,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get('by-job/:jobId')
  getByJobId(@Param('workbookId') workbookId: WorkbookId, @Param('jobId') jobId: string, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.getPublishPlanByJobId(workbookId, jobId);
  }

  @Get(':planId')
  getById(@Param('workbookId') workbookId: WorkbookId, @Param('planId') planId: string, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.getPublishPlanById(workbookId, planId);
  }

  @Get(':pipelineId/operations')
  operations(
    @Param('pipelineId') pipelineId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('phase') phase?: string,
    @Query('filePath') filePath?: string,
    @Query('hasError') hasError?: string,
  ) {
    return this.publishAdminService.listPublishPlanOperations(pipelineId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      phase,
      filePath,
      hasError: hasError === 'true',
    });
  }

  @Get(':pipelineId/records')
  records(
    @Param('pipelineId') pipelineId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('dataFolderId') dataFolderId?: string,
    @Query('phase') phase?: string,
    @Query('filename') filename?: string,
  ) {
    return this.publishAdminService.listPublishPlanRecords(pipelineId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      dataFolderId,
      phase,
      filename,
    });
  }

  // ── Publish diffs (DEV-11427) ────────────────────────────────────

  /**
   * The files that differ between two anchors of a publish (`from` → `to`, each
   * `pre-main` | `pre-dirty` | `post-main`; default pre-publish `main` →
   * post-publish `main`), paginated. `folderPath` narrows to one folder;
   * `status` narrows to `added` / `modified` / `deleted`.
   */
  @Get(':planId/changed-files')
  changedFiles(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('folderPath') folderPath?: string,
    @Query('status') status?: string,
  ): Promise<PublishPlanChangedFilesResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishPlanDiffService.listChangedFilesForPublishPlan(workbookId, planId, {
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      folderPath,
      status,
    });
  }

  /**
   * Content of one record file at two anchors of a publish (`from` → `to`, each
   * `pre-main` | `pre-dirty` | `post-main`; default pre-publish `main` →
   * post-publish `main`), plus a sparse field-level diff. `path` is the file's
   * full workbook path.
   */
  @Get(':planId/file-diff')
  fileDiff(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('planId') planId: string,
    @Query('path') path: string,
    @Req() req: RequestWithUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PublishPlanFileDiff> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishPlanDiffService.getFileDiffForPublishPlan(workbookId, planId, path, { from, to });
  }

  @Get('index/files')
  fileIndex(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.listFileIndex(workbookId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get('index/refs')
  refIndex(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.listRefIndex(workbookId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get('index/assets')
  assetIndex(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('dataFolderId') dataFolderId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.publishAdminService.listAssetIndex(workbookId, {
      dataFolderId,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Delete(':pipelineId')
  delete(@Param('pipelineId') pipelineId: string) {
    return this.publishAdminService.deletePublishPlan(pipelineId);
  }
}
