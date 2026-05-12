import {
  BadRequestException,
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
  DataFolder,
  DataFolderId,
  DataFolderOptions,
  ValidatedCreateDataFolderDto,
  ValidatedUpdateDataFolderDto,
  WorkbookId,
} from '@spinner/shared-types';
import { CreateDataFolderDto, UpdateDataFolderDto } from '@spinner/shared-types';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { PostHogService } from '../posthog/posthog.service';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { userToActor } from '../users/types';
import { SchemaField } from '../utils/schema-helpers';
import { BullEnqueuerService } from '../worker-enqueuer/bull-enqueuer.service';
import { DataFolderService } from './data-folder.service';
import { WorkbookService } from './workbook.service';

@Controller('data-folder')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class DataFolderController {
  constructor(
    private readonly dataFolderService: DataFolderService,
    private readonly workbookService: WorkbookService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly posthogService: PostHogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly db: DbService,
  ) {}

  @Post('/create')
  async create(@Body() createDataFolderDto: CreateDataFolderDto, @Req() req: RequestWithUser): Promise<DataFolder> {
    const dto = createDataFolderDto as ValidatedCreateDataFolderDto;
    const actor = userToActor(req.user);
    // Service-level assertion runs again, but we want to fail fast at the controller boundary.
    await this.workbookService.assertWritableWorkbook(actor, dto.workbookId);
    return await this.dataFolderService.createFolder(dto, actor, createRunContext('web'));
  }

  @Get(':id')
  async findOne(@Param('id') id: DataFolderId, @Req() req: RequestWithUser): Promise<DataFolder> {
    return await this.dataFolderService.findOne(id, userToActor(req.user));
  }

  @Delete(':id')
  async delete(@Param('id') id: DataFolderId, @Req() req: RequestWithUser): Promise<void> {
    await this.dataFolderService.deleteFolder(id, userToActor(req.user));
  }

  @Patch(':id')
  async update(
    @Param('id') id: DataFolderId,
    @Body() updateDto: UpdateDataFolderDto,
    @Req() req: RequestWithUser,
  ): Promise<DataFolder> {
    const dto = updateDto as ValidatedUpdateDataFolderDto;
    return await this.dataFolderService.updateFolder(id, dto, userToActor(req.user));
  }

  @Post(':id/files')
  async createFile(
    @Param('id') id: DataFolderId,
    @Body() body: { name: string; useTemplate?: boolean; workbookId: string },
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, body.workbookId as WorkbookId);
    return await this.dataFolderService.createFile(
      body.workbookId as WorkbookId,
      id,
      { name: body.name, useTemplate: body.useTemplate },
      actor,
    );
  }

  @Post(':id/publish')
  async publishSingleFolder(
    @Param('id') id: DataFolderId,
    @Body() body: { workbookId: string },
    @Req() req: RequestWithUser,
  ): Promise<{ jobId: string }> {
    const actor = userToActor(req.user);
    const workbookId = body.workbookId as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    // Verify the data folder exists and belongs to this workbook
    const dataFolder = await this.dataFolderService.findOne(id, actor);
    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }
    if (dataFolder.workbookId !== workbookId) {
      throw new BadRequestException('Data folder does not belong to this workbook');
    }

    // Read-only folders are excluded from publish flows entirely (DEV-9928).
    if ((dataFolder.options as DataFolderOptions | null)?.readOnly) {
      throw new BadRequestException(`Data folder "${dataFolder.name}" is read-only and cannot be published`);
    }

    // Check if folder is already locked by another operation
    if (dataFolder.lock) {
      throw new BadRequestException(
        `Data folder "${dataFolder.name}" is currently locked by another ${dataFolder.lock} operation`,
      );
    }

    // Acquire lock before enqueueing the job
    await this.db.client.dataFolder.update({
      where: { id },
      data: { lock: 'publish' },
    });

    // Enqueue the publish job with single folder as array
    const job = await this.bullEnqueuerService.enqueuePublishDataFolderJob(
      workbookId,
      actor,
      [id],
      undefined,
      createRunContext('web'),
    );

    this.posthogService.trackPublishDataFromWorkbook(actor, workbook, { dataFolderCount: 1 });

    return { jobId: job.id ?? '' };
  }

  @Post(':id/pull-files')
  async pullFiles(
    @Param('id') id: DataFolderId,
    @Body() body: { workbookId: string; filePaths: string[] },
    @Req() req: RequestWithUser,
  ): Promise<{ jobId: string }> {
    const actor = userToActor(req.user);
    const workbookId = body.workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const filePaths = body.filePaths;

    if (!filePaths || filePaths.length === 0) {
      throw new BadRequestException('At least one file path is required');
    }

    // Verify the data folder exists and belongs to this workbook
    const dataFolder = await this.dataFolderService.findOne(id, actor);
    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }
    if (dataFolder.workbookId !== workbookId) {
      throw new BadRequestException('Data folder does not belong to this workbook');
    }
    if (!dataFolder.connectorAccountId) {
      throw new BadRequestException('Data folder does not have a connected source');
    }

    // Check if folder is already locked by another operation
    if (dataFolder.lock) {
      throw new BadRequestException(
        `Data folder "${dataFolder.name}" is currently locked by another ${dataFolder.lock} operation`,
      );
    }

    // Acquire lock before enqueueing the job
    await this.db.client.dataFolder.update({
      where: { id },
      data: { lock: 'pull' },
    });

    const job = await this.bullEnqueuerService.enqueuePullFilesJob(
      workbookId,
      actor,
      id,
      filePaths,
      undefined,
      createRunContext('web'),
    );

    this.posthogService.trackPullFiles(actor, workbookId, id);

    return { jobId: job.id ?? '' };
  }

  @Get(':id/schema')
  async getDataFolderSchema(@Param('id') id: DataFolderId, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    const schema = await this.dataFolderService.getStoredSchema(id, actor);
    if (!schema) {
      throw new NotFoundException('No schema found for this data folder');
    }
    return schema;
  }

  @Post(':id/refresh-schema')
  async refreshDataFolderSchema(@Param('id') id: DataFolderId, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    const spec = await this.dataFolderService.fetchSchemaSpec(id, actor);
    if (!spec) {
      throw new NotFoundException('No schema found for this data folder');
    }
    return spec;
  }

  @Get(':id/schema-paths')
  async getSchemaPaths(@Param('id') id: DataFolderId, @Req() req: RequestWithUser): Promise<SchemaField[]> {
    return await this.dataFolderService.getSchemaPaths(id, userToActor(req.user));
  }
}
