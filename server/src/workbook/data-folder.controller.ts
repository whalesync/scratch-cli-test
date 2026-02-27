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
  ValidatedCreateDataFolderDto,
  ValidatedMoveDataFolderDto,
  ValidatedRenameDataFolderDto,
  ValidatedUpdateDataFolderDto,
  WorkbookId,
} from '@spinner/shared-types';
import {
  CreateDataFolderDto,
  MoveDataFolderDto,
  RenameDataFolderDto,
  UpdateDataFolderDto,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { PostHogService } from '../posthog/posthog.service';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { userToActor } from '../users/types';
import { SchemaField } from '../utils/schema-helpers';
import { BullEnqueuerService } from '../worker-enqueuer/bull-enqueuer.service';
import { DataFolderService } from './data-folder.service';
import { WorkbookService } from './workbook.service';

@Controller('data-folder')
@UseGuards(ScratchAuthGuard)
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

    // Verify the user has access to the workbook
    const workbook = await this.workbookService.findOne(dto.workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    return await this.dataFolderService.createFolder(dto, actor);
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

  @Patch(':id/rename')
  async rename(
    @Param('id') id: DataFolderId,
    @Body() renameDto: RenameDataFolderDto,
    @Req() req: RequestWithUser,
  ): Promise<DataFolder> {
    const dto = renameDto as ValidatedRenameDataFolderDto;
    return await this.dataFolderService.renameFolder(id, dto.name, userToActor(req.user));
  }

  @Patch(':id/move')
  async move(
    @Param('id') id: DataFolderId,
    @Body() moveDto: MoveDataFolderDto,
    @Req() req: RequestWithUser,
  ): Promise<DataFolder> {
    const dto = moveDto as ValidatedMoveDataFolderDto;
    return await this.dataFolderService.moveFolder(id, dto.parentFolderId ?? null, userToActor(req.user));
  }

  @Post(':id/files')
  async createFile(
    @Param('id') id: DataFolderId,
    @Body() body: { name: string; useTemplate?: boolean; workbookId: string },
    @Req() req: RequestWithUser,
  ) {
    return await this.dataFolderService.createFile(
      body.workbookId as WorkbookId,
      id,
      { name: body.name, useTemplate: body.useTemplate },
      userToActor(req.user),
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

    // Verify the user has access to the workbook
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Verify the data folder exists and belongs to this workbook
    const dataFolder = await this.dataFolderService.findOne(id, actor);
    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }
    if (dataFolder.workbookId !== workbookId) {
      throw new BadRequestException('Data folder does not belong to this workbook');
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
    const job = await this.bullEnqueuerService.enqueuePublishDataFolderJob(workbookId, actor, [id]);

    this.posthogService.trackPublishDataFromWorkbook(actor, workbook, { dataFolderCount: 1 });

    return { jobId: job.id ?? '' };
  }

  @Post(':id/refresh-records')
  async refreshRecords(
    @Param('id') id: DataFolderId,
    @Body() body: { workbookId: string; filePaths: string[] },
    @Req() req: RequestWithUser,
  ): Promise<{ jobId: string }> {
    const actor = userToActor(req.user);
    const workbookId = body.workbookId as WorkbookId;
    const filePaths = body.filePaths;

    if (!filePaths || filePaths.length === 0) {
      throw new BadRequestException('At least one file path is required');
    }

    // Verify the user has access to the workbook
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
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

    const job = await this.bullEnqueuerService.enqueueRefreshRecordsJob(workbookId, actor, id, filePaths);

    this.posthogService.trackRefreshRecords(actor, workbookId, id);

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
