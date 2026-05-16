import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { DataFolderId, PullFilesResponseDto, WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { JobEntity } from 'src/job/entities/job.entity';
import { JobService } from 'src/job/job.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { userToActor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { CliPullDto, CreateCliLinkedTableDto, ValidatedCreateCliLinkedTableDto } from './dtos/cli-linked.dto';

/**
 * Controller for CLI linked table operations.
 * Provides endpoints for managing linked tables (data folders connected to external CRM connectors).
 *
 * All endpoints require API token authentication via Authorization header.
 */
@Controller('cli/v1')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class CliLinkedController {
  constructor(
    private readonly dataFolderService: DataFolderService,
    private readonly workbookService: WorkbookService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly posthogService: PostHogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly db: DbService,
    private readonly jobService: JobService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly publishPlanBuildService: PublishPlanBuildService,
  ) {}

  /**
   * Get the progress/state of a job by ID.
   */
  @Get('jobs/:jobId/progress')
  async getJobProgress(@Param('jobId') jobId: string, @Req() req: RequestWithUser): Promise<JobEntity> {
    const actor = userToActor(req.user);
    const result = await this.jobService.getJobProgress(jobId);
    this.posthogService.trackCliGetJobProgress(actor, jobId);
    return result;
  }

  /**
   * List linked tables in a workbook, grouped by connector.
   */
  @Get('workbooks/:workbookId/linked')
  async listLinkedTables(@Req() req: RequestWithUser, @Param('workbookId') workbookId: string) {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);
    const result = await this.dataFolderService.listGroupedByConnectorBases(workbookId as WorkbookId, actor);
    this.posthogService.trackCliListDataFolders(actor, workbookId, { scope: 'list' });
    return result;
  }

  /**
   * Link a new table to a workbook.
   */
  @Post('workbooks/:workbookId/linked')
  async createLinkedTable(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Body() dto: CreateCliLinkedTableDto,
  ) {
    const actor = userToActor(req.user);
    // Mutation: 404 if workbook is missing or pending deletion.
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);
    const validatedDto = dto as ValidatedCreateCliLinkedTableDto;

    // Check if the table is disabled (e.g. no unique column)
    const { tables } = await this.connectorAccountService.listTables(validatedDto.connectorAccountId, actor);
    const tableIdStr = validatedDto.tableId.join(',');
    const matchedTable = tables.find((t) => [...t.id.remoteId].join(',') === tableIdStr);
    if (matchedTable?.disabled) {
      throw new BadRequestException('This table is not available for linking');
    }

    return await this.dataFolderService.createFolder(
      {
        name: validatedDto.name,
        workbookId: workbookId as WorkbookId,
        connectorAccountId: validatedDto.connectorAccountId,
        tableId: validatedDto.tableId,
        filter: validatedDto.filter,
      },
      actor,
      createRunContext('cli'),
    );
  }

  /**
   * Unlink a table from a workbook.
   */
  @Delete('workbooks/:workbookId/linked/:folderId')
  async deleteLinkedTable(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Param('folderId') folderId: string,
  ): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    // Mutation: 404 if workbook is missing or pending deletion.
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);

    await this.dataFolderService.deleteFolder(folderId as DataFolderId, actor);

    return { success: true };
  }

  /**
   * Show details for a linked table, including publish status (change counts).
   */
  @Get('workbooks/:workbookId/linked/:folderId')
  async getLinkedTable(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Param('folderId') folderId: string,
  ) {
    const actor = userToActor(req.user);
    // Read access: pending workbooks remain inspectable.
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);

    const dataFolder = await this.dataFolderService.findOne(folderId as DataFolderId, actor);
    if (!dataFolder) {
      throw new NotFoundException('Linked table not found');
    }

    this.posthogService.trackCliListDataFolders(actor, workbookId, { folderId, scope: 'single' });

    // Get publish status (change counts) for this specific folder
    let creates = 0;
    let updates = 0;
    let deletes = 0;
    let hasChanges = false;

    if (dataFolder.connectorAccountId && dataFolder.path) {
      try {
        const diff = await this.scratchGitService.getFolderDiff(workbookId as WorkbookId, dataFolder.path);
        for (const file of diff) {
          if (!file.path.endsWith('.json')) continue;
          if (file.status === 'added') creates++;
          else if (file.status === 'modified') updates++;
          else if (file.status === 'deleted') deletes++;
        }
        hasChanges = creates > 0 || updates > 0 || deletes > 0;
      } catch {
        // If git operations fail, continue with zero counts
      }
    }

    return {
      ...dataFolder,
      creates,
      updates,
      deletes,
      hasChanges,
    };
  }

  /**
   * Pull CRM changes into the workbook for a specific linked table.
   */
  @Post('workbooks/:workbookId/linked/pull-all')
  async pullAllLinkedTables(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Body() body: CliPullDto,
  ): Promise<PullFilesResponseDto> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);

    return await this.workbookService.pullFiles(
      workbookId as WorkbookId,
      actor,
      undefined,
      createRunContext('cli'),
      body.mode,
    );
  }

  /**
   * Pull CRM changes into the workbook for a specific linked table.
   */
  @Post('workbooks/:workbookId/linked/:folderId/pull')
  async pullLinkedTable(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Param('folderId') folderId: string,
    @Body() body: CliPullDto,
  ): Promise<PullFilesResponseDto> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);

    return await this.workbookService.pullFiles(
      workbookId as WorkbookId,
      actor,
      [folderId],
      createRunContext('cli'),
      body.mode,
    );
  }

  /**
   * Pull specific files from the remote source for a linked table.
   */
  @Post('workbooks/:workbookId/linked/:folderId/pull-files')
  async pullLinkedTableFiles(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Param('folderId') folderId: string,
    @Body() body: { filePaths: string[] },
  ): Promise<{ jobId: string }> {
    const actor = userToActor(req.user);
    const wbId = workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, wbId);
    const dfId = folderId as DataFolderId;

    // Verify the data folder exists and belongs to this workbook
    const dataFolder = await this.dataFolderService.findOne(dfId, actor);
    if (!dataFolder) {
      throw new NotFoundException('Linked table not found');
    }
    if (dataFolder.workbookId !== wbId) {
      throw new BadRequestException('Linked table does not belong to this workbook');
    }
    if (!dataFolder.connectorAccountId) {
      throw new BadRequestException('Linked table does not have a connected source');
    }

    if (!body.filePaths || body.filePaths.length === 0) {
      throw new BadRequestException('At least one file path is required');
    }

    // Check if folder is already locked by another operation
    if (dataFolder.lock) {
      throw new BadRequestException(
        `Linked table "${dataFolder.name}" is currently locked by another ${dataFolder.lock} operation`,
      );
    }

    // Acquire lock before enqueueing the job
    await this.db.client.dataFolder.update({
      where: { id: dfId },
      data: { lock: 'pull' },
    });

    const job = await this.bullEnqueuerService.enqueuePullFilesJob(
      wbId,
      actor,
      dfId,
      body.filePaths,
      undefined,
      createRunContext('cli'),
    );

    this.posthogService.trackPullFiles(actor, wbId, dfId);

    return { jobId: job.id ?? '' };
  }

  /**
   * Publish changes from the workbook to the CRM for a specific linked table.
   * Uses the publish-v2 pipeline (plan + run) for modern publish flow.
   */
  @Post('workbooks/:workbookId/linked/:folderId/publish')
  async publishLinkedTable(
    @Req() req: RequestWithUser,
    @Param('workbookId') workbookId: string,
    @Param('folderId') folderId: string,
  ): Promise<{ jobId: string }> {
    // Check if CLI publishing is enabled for this user
    const userSettings = req.user.settings as Record<string, unknown> | undefined;
    if (!userSettings?.cliCanPublish) {
      throw new ForbiddenException(
        'CLI publishing is disabled. Enable it in Settings > Integrations to publish changes from the CLI.',
      );
    }

    const actor = userToActor(req.user);
    const wbId = workbookId as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, wbId);
    const dfId = folderId as DataFolderId;

    // Verify the data folder exists and belongs to this workbook
    const dataFolder = await this.dataFolderService.findOne(dfId, actor);
    if (!dataFolder) {
      throw new NotFoundException('Linked table not found');
    }
    if (dataFolder.workbookId !== wbId) {
      throw new BadRequestException('Linked table does not belong to this workbook');
    }

    // Validate that the folder has the required fields for publish-v2
    if (!dataFolder.path || !dataFolder.connectorAccountId) {
      throw new BadRequestException('Linked table is missing a path or connector account — cannot publish');
    }

    // Check if folder is already locked by another operation
    if (dataFolder.lock) {
      throw new BadRequestException(
        `Linked table "${dataFolder.name}" is currently locked by another ${dataFolder.lock} operation`,
      );
    }

    // Create the publish-v2 pipeline
    const { pipelineId } = await this.publishPlanBuildService.createPipeline(
      wbId,
      req.user.id,
      dataFolder.connectorAccountId,
    );

    // Enqueue a combined plan+run job (runAfterPlan=true) scoped to this folder
    const job = await this.bullEnqueuerService.enqueuePlanPipelineJob(
      wbId,
      actor,
      pipelineId,
      dataFolder.connectorAccountId,
      true, // runAfterPlan
      dataFolder.path,
      undefined,
      undefined,
      createRunContext('cli'),
    );

    await this.publishPlanBuildService.setActiveJob(pipelineId, job.id!.toString());

    this.posthogService.trackPublishDataFromWorkbook(actor, workbook, { dataFolderCount: 1 });

    return { jobId: job.id ?? '' };
  }
}
