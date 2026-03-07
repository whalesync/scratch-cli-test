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
import { checkWorkspacePermissions } from '../users/permissions';
import { userToActor } from '../users/types';
import { dbJobToJobEntity, JobEntity } from './entities/job.entity';
import { JobService } from './job.service';

@Controller('jobs')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Get()
  async getJobs(
    @Req() req: RequestWithUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('workbookId') workbookId?: string,
  ): Promise<JobEntity[]> {
    const actor = userToActor(req.user);
    if (workbookId) {
      checkWorkspacePermissions(actor, workbookId as WorkbookId);
    }
    const userId = req.user.id;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    const dbJobs = await this.jobService.getJobsByUserId(userId, limitNum, offsetNum, workbookId);
    return dbJobs.map(dbJobToJobEntity);
  }

  @Get('workbook/:workbookId/active')
  async getActiveJobsByWorkbook(
    @Param('workbookId') workbookId: string,
    @Req() req: RequestWithUser,
  ): Promise<JobEntity[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return await this.jobService.getActiveJobsByWorkbookId(workbookId);
  }

  @Get(':jobId/progress')
  async getJobProgress(@Param('jobId') jobId: string): Promise<JobEntity> {
    return this.jobService.getJobProgress(jobId);
  }

  @Get(':jobId/raw')
  async getJobRaw(@Param('jobId') jobId: string): Promise<any> {
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

  @Get('run/:runId')
  async getJobsByRunId(@Param('runId') runId: string): Promise<JobEntity[]> {
    const dbJobs = await this.jobService.getJobsByRunId(runId as RunId);
    return dbJobs.map(dbJobToJobEntity);
  }

  @Post('bulk-status')
  async getBulkJobStatus(@Body() body: { jobIds: string[] }): Promise<JobEntity[]> {
    return await this.jobService.getJobsProgress(body.jobIds);
  }
}
