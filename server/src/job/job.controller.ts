import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { RunId, WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { SkipApiRateLimit } from '../rate-limiter/api-rate-limit.decorator';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { checkWorkspacePermissions } from '../users/permissions';
import { userToActor } from '../users/types';
import { dbJobToJobEntity, JobEntity } from './entities/job.entity';
import { JobService } from './job.service';

@Controller('jobs')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Get()
  async getJobs(
    @Req() req: RequestWithUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('workbookId') workbookId?: string,
    @Query('type') type?: string,
    @Query('syncId') syncId?: string,
    @Query('dataFolderId') dataFolderId?: string,
  ): Promise<JobEntity[]> {
    const actor = userToActor(req.user);
    if (workbookId) {
      // Read access: job history is observable for pending workbooks so users can see
      // background deletion progress.
      checkWorkspacePermissions(actor, workbookId as WorkbookId);
    }
    const userId = req.user.id;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const filter = type || syncId || dataFolderId ? { type, syncId, dataFolderId } : undefined;

    const dbJobs = workbookId
      ? await this.jobService.getJobsForWorkbook(workbookId, limitNum, offsetNum, filter)
      : await this.jobService.getJobsByUserId(userId, limitNum, offsetNum, undefined, filter);
    return dbJobs.map(dbJobToJobEntity);
  }

  // Polled by workspace-level "active jobs" indicators (pull-in-progress
  // modals, header status badges). Cheap Redis read — exempt from the
  // per-user 60-req/min CLI budget so live UI doesn't compete with writes.
  @Get('workbook/:workbookId/active')
  @SkipApiRateLimit()
  async getActiveJobsByWorkbook(
    @Param('workbookId') workbookId: string,
    @Req() req: RequestWithUser,
  ): Promise<JobEntity[]> {
    const actor = userToActor(req.user);
    // Read access: pending workbooks should still surface active jobs (the deletion job runs against them).
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return await this.jobService.getActiveJobsByWorkbookId(workbookId);
  }

  // Single-job progress poll. Same rationale as `bulk-status` — cheap read,
  // UI polling shape.
  @Get(':jobId/progress')
  @SkipApiRateLimit()
  async getJobProgress(@Param('jobId') jobId: string): Promise<JobEntity> {
    return this.jobService.getJobProgress(jobId);
  }

  // Raw BullMQ job payload — used by job-inspection UIs (debug views).
  // Read-only, no DB writes; safe to exempt.
  @Get(':jobId/raw')
  @SkipApiRateLimit()
  async getJobRaw(@Param('jobId') jobId: string): Promise<unknown> {
    return await this.jobService.getJobRaw(jobId);
  }

  @Post(':jobId/cancel')
  async cancelJob(
    @Param('jobId') jobId: string,
    @Req() req: RequestWithUser,
  ): Promise<{ success: boolean; message: string }> {
    const actor = userToActor(req.user);
    return await this.jobService.cancelJob(jobId, actor);
  }

  // Run-scoped job lookup used by sync run UIs. Polled while a run is
  // active; same exemption rationale as `bulk-status`.
  @Get('run/:runId')
  @SkipApiRateLimit()
  async getJobsByRunId(@Param('runId') runId: string): Promise<JobEntity[]> {
    const dbJobs = await this.jobService.getJobsByRunId(runId as RunId);
    return dbJobs.map(dbJobToJobEntity);
  }

  // Polled by the desktop publish modal (and other UI status views) once
  // per second across all in-flight jobs. The default 60-req/min cap is
  // designed for CLI write operations, not UI live progress — and this
  // endpoint is a cheap Redis read. Exempt it from the per-user budget.
  @Post('bulk-status')
  @SkipApiRateLimit()
  async getBulkJobStatus(@Body() body: { jobIds: string[] }): Promise<JobEntity[]> {
    return await this.jobService.getJobsProgress(body.jobIds);
  }
}
