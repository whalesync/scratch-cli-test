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
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { DataFolderGroup, PullAssetsResponseDto, PullFilesResponseDto, WorkbookId } from '@spinner/shared-types';
import { CreateWorkbookDto, PullAssetsDto, PullFilesDto, UpdateWorkbookDto } from '@spinner/shared-types';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { userToActor } from '../users/types';
import { UsersService } from '../users/users.service';
import { DataFolderService } from './data-folder.service';
import { Workbook } from './entities';

import { WorkbookCluster } from 'src/db/cluster-types';
import { WorkbookService } from './workbook.service';

@Controller('workbook')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class WorkbookController {
  constructor(
    private readonly service: WorkbookService,
    private readonly dataFolderService: DataFolderService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  async create(@Body() createWorkbookDto: CreateWorkbookDto, @Req() req: RequestWithUser): Promise<Workbook> {
    const dto = createWorkbookDto;
    const workbook = await this.service.create(dto, userToActor(req.user));

    // Set this as the user's last workbook
    await this.usersService.updateLastWorkbook(req.user.id, workbook.id);

    return new Workbook(workbook);
  }

  @Get()
  async findAll(
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Query('sortBy') sortBy: 'name' | 'createdAt' | 'updatedAt' | undefined,
    @Query('sortOrder') sortOrder: 'asc' | 'desc' | undefined,
    @Req() req: RequestWithUser,
  ): Promise<Workbook[]> {
    let workbooks: WorkbookCluster.Workbook[] = [];
    if (connectorAccountId) {
      workbooks = await this.service.findAllForConnectorAccount(
        connectorAccountId,
        userToActor(req.user),
        sortBy,
        sortOrder,
      );
    } else {
      workbooks = await this.service.findAllForUser(userToActor(req.user), sortBy, sortOrder);
    }

    return await Promise.all(
      workbooks.map(async (s) => {
        const schedulesByEntityId = await this.service.fetchSchedulesByEntityId(s.id as WorkbookId);
        return new Workbook(s, schedulesByEntityId);
      }),
    );
  }

  @Get(':id')
  async findOne(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<Workbook | null> {
    const workbook = await this.service.findOne(id, userToActor(req.user));
    if (!workbook) {
      return null;
    }
    const schedulesByEntityId = await this.service.fetchSchedulesByEntityId(workbook.id as WorkbookId);
    return new Workbook(workbook, schedulesByEntityId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: WorkbookId,
    @Body() updateWorkbookDto: UpdateWorkbookDto,
    @Req() req: RequestWithUser,
  ): Promise<Workbook> {
    const dto = updateWorkbookDto;
    return new Workbook(await this.service.update(id, dto, userToActor(req.user)));
  }

  @Post(':id/pull-files')
  async pullFiles(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullFilesDto,
    @Req() req: RequestWithUser,
  ): Promise<PullFilesResponseDto> {
    const dto = pullDto;
    return this.service.pullFiles(id, userToActor(req.user), dto.dataFolderIds, createRunContext('web'));
  }

  @Post(':id/pull-assets')
  async pullAssets(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullAssetsDto,
    @Req() req: RequestWithUser,
  ): Promise<PullAssetsResponseDto> {
    return this.service.pullAssets(id, userToActor(req.user), pullDto.dataFolderId, createRunContext('web'));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<void> {
    await this.service.delete(id, userToActor(req.user));
  }

  @Post(':id/discard-changes')
  @HttpCode(204)
  async discardChanges(
    @Param('id') id: WorkbookId,
    @Body() body: { path?: string },
    @Req() req: RequestWithUser,
  ): Promise<void> {
    await this.service.discardChanges(id, userToActor(req.user), body.path);
  }

  @Post(':id/reset')
  @HttpCode(204)
  async reset(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<void> {
    await this.service.resetWorkbook(id, userToActor(req.user));
  }

  /* Start new Data Folder functions */
  @Get(':id/data-folders/list')
  async listDataFolders(@Param('id') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<DataFolderGroup[]> {
    return await this.dataFolderService.listGroupedByConnectorBases(workbookId, userToActor(req.user));
  }
}
