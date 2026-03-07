import {
  BadRequestException,
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
import type {
  DataFolderGroup,
  PullAssetsResponseDto,
  PullFilesResponseDto,
  WorkbookId,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import {
  AddWorkspacePermissionDto,
  CreateWorkbookDto,
  PullAssetsDto,
  PullFilesDto,
  UpdateWorkbookDto,
  UpdateWorkspacePermissionDto,
} from '@spinner/shared-types';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { WorkspacePermissionRole, userToActor } from '../users/types';
import { UsersService } from '../users/users.service';
import { DataFolderService } from './data-folder.service';
import { Workbook, WorkspacePermissionEntity } from './entities';

import { WorkbookCluster } from 'src/db/cluster-types';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { WorkbookService } from './workbook.service';
import { WorkspacePermissionsService } from './workspace-permissions.service';

@Controller('workbook')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class WorkbookController {
  constructor(
    private readonly service: WorkbookService,
    private readonly dataFolderService: DataFolderService,
    private readonly usersService: UsersService,
    private readonly workspacePermissionsService: WorkspacePermissionsService,
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
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);

    const workbook = await this.service.findOne(id, actor);
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
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    const dto = updateWorkbookDto;
    return new Workbook(await this.service.update(id, dto, actor));
  }

  @Post(':id/pull-files')
  async pullFiles(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullFilesDto,
    @Req() req: RequestWithUser,
  ): Promise<PullFilesResponseDto> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    const dto = pullDto;
    return this.service.pullFiles(id, actor, dto.dataFolderIds, createRunContext('web'));
  }

  @Post(':id/pull-assets')
  async pullAssets(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullAssetsDto,
    @Req() req: RequestWithUser,
  ): Promise<PullAssetsResponseDto> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    return this.service.pullAssets(id, actor, pullDto.dataFolderId, createRunContext('web'));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    await this.service.delete(id, actor);
  }

  @Post(':id/discard-changes')
  @HttpCode(204)
  async discardChanges(
    @Param('id') id: WorkbookId,
    @Body() body: { path?: string },
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    await this.service.discardChanges(id, actor, body.path);
  }

  @Post(':id/reset')
  @HttpCode(204)
  async reset(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id);
    await this.service.resetWorkbook(id, actor);
  }

  /* Start new Data Folder functions */
  @Get(':id/data-folders/list')
  async listDataFolders(@Param('id') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<DataFolderGroup[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return await this.dataFolderService.listGroupedByConnectorBases(workbookId, actor);
  }

  /* Workspace Permission endpoints */
  @Get(':id/permissions')
  async listPermissions(
    @Param('id') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const permissions = await this.workspacePermissionsService.listByWorkbook(workbookId);
    return permissions.map((p) => new WorkspacePermissionEntity(p));
  }

  @Post(':id/permissions/add')
  async addPermission(
    @Param('id') workbookId: WorkbookId,
    @Body() dto: AddWorkspacePermissionDto,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const role = (dto.role ?? 'editor') as WorkspacePermissionRole;

    let permission;
    if (dto.userId) {
      permission = await this.workspacePermissionsService.createByUserId(workbookId, dto.userId, role, actor);
    } else if (dto.email) {
      permission = await this.workspacePermissionsService.createByEmail(workbookId, dto.email, role, actor);
    } else {
      throw new BadRequestException('Either userId or email must be provided');
    }

    return new WorkspacePermissionEntity(permission);
  }

  @Delete(':id/permission/:permissionId')
  @HttpCode(204)
  async removePermission(
    @Param('id') workbookId: WorkbookId,
    @Param('permissionId') permissionId: WorkspacePermissionId,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    await this.workspacePermissionsService.delete(permissionId, actor);
  }

  @Patch(':id/permission/:permissionId')
  async updatePermission(
    @Param('id') workbookId: WorkbookId,
    @Param('permissionId') permissionId: WorkspacePermissionId,
    @Body() dto: UpdateWorkspacePermissionDto,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const role = dto.role as WorkspacePermissionRole;
    const permission = await this.workspacePermissionsService.update(permissionId, role, actor);
    return new WorkspacePermissionEntity(permission);
  }
}
