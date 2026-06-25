import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  ForbiddenException,
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
  DeleteWorkbookResponseDto,
  OrganizationUsageSummaryResponseDto,
  PullAssetsResponseDto,
  PullFilesResponseDto,
  RecordCountResponseDto,
  WorkbookId,
  Workspace,
  WorkspaceInviteId,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { RunCountService } from 'src/run-count/run-count.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { WorkspacePermissionRole, userToActor } from '../users/types';
import { UsersService } from '../users/users.service';
import { DataFolderService } from './data-folder.service';
import { WorkbookListQueryDto } from './dto/list-workbooks-query.dto';
import {
  AddWorkspacePermissionDto,
  CreateWorkbookDto,
  PullAssetsDto,
  PullFilesDto,
  UpdateWorkbookDto,
  UpdateWorkbookSettingsDto,
  UpdateWorkspacePermissionDto,
} from './dto/workbook.dto';
import { WorkspaceEntity, WorkspaceInviteEntity, WorkspacePermissionEntity } from './entities';

import { WorkbookCluster } from 'src/db/cluster-types';
import { ScratchConfigService } from '../config/scratch-config.service';
import { WorkbookService } from './workbook.service';
import { WorkspacePermissionsService } from './workspace-permissions.service';

@Controller('workbook')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class WorkbookController {
  constructor(
    private readonly service: WorkbookService,
    private readonly dataFolderService: DataFolderService,
    private readonly usersService: UsersService,
    private readonly workspacePermissionsService: WorkspacePermissionsService,
    private readonly configService: ScratchConfigService,
    private readonly runCountService: RunCountService,
  ) {}

  @Post()
  async create(@Body() createWorkbookDto: CreateWorkbookDto, @Req() req: RequestWithUser): Promise<Workspace> {
    const dto = createWorkbookDto;
    const workbook = await this.service.create(dto, userToActor(req.user));

    // Set this as the user's last workbook
    await this.usersService.updateLastWorkbook(req.user.id, workbook.id);

    return WorkspaceEntity.from(workbook);
  }

  @Get()
  async findAll(@Query() query: WorkbookListQueryDto, @Req() req: RequestWithUser): Promise<Workspace[]> {
    const { connectorAccountId, sortBy, sortOrder, managedBy } = query;
    let workbooks: WorkbookCluster.Workbook[] = [];
    if (connectorAccountId) {
      workbooks = await this.service.findAllForConnectorAccount(
        connectorAccountId,
        userToActor(req.user),
        sortBy,
        sortOrder,
        managedBy,
      );
    } else {
      workbooks = await this.service.findAllForUser(userToActor(req.user), sortBy, sortOrder, managedBy);
    }

    const workbookIds = workbooks.map((s) => s.id as WorkbookId);
    const allSchedules = await this.service.fetchSchedulesByWorkbookIds(workbookIds);

    // Resolve incremental-pull support for every embedded data folder across all workbooks in
    // one pass so the client can decide per folder whether incremental pull is available without
    // a follow-up request. Without this the embedded DataFolderEntity would default to NOT_SUPPORTED.
    const incrementalPullSupportByDataFolderId =
      await this.dataFolderService.computeIncrementalPullSupportByDataFolderId(
        workbooks.flatMap((workbook) => workbook.dataFolders),
      );

    return workbooks.map((s) =>
      WorkspaceEntity.from(s, allSchedules.get(s.id as WorkbookId), incrementalPullSupportByDataFolderId),
    );
  }

  /**
   * Total record count across every workbook in the authenticated user's organization.
   * Workbooks are owned by the organization (not the individual user), so this is the
   * org-wide total for the caller. Declared before `:id` so the static `record-count/total`
   * path is never captured as a workbook id.
   */
  @Get('record-count/total')
  async getOrganizationRecordCount(@Req() req: RequestWithUser): Promise<RecordCountResponseDto> {
    const { organizationId } = userToActor(req.user);
    const recordCount = await this.dataFolderService.sumRecordCountForOrganization(organizationId);
    return { recordCount };
  }

  /**
   * Organization-wide usage summary for the billing page: workbook count, total record count, and
   * the connector services in use. Org-scoped (by `Workbook.organizationId`), unlike the
   * membership-scoped workspace list. Declared before `:id` so the static path is never captured
   * as a workbook id.
   */
  @Get('organization-usage-summary')
  async getOrganizationUsageSummary(@Req() req: RequestWithUser): Promise<OrganizationUsageSummaryResponseDto> {
    const { organizationId } = userToActor(req.user);
    const [workbookCount, recordCount, whalesyncEligibleRecordCount, connectorServices, monthlyRunCounts] =
      await Promise.all([
        this.service.countForOrganization(organizationId),
        this.dataFolderService.sumRecordCountForOrganization(organizationId),
        this.dataFolderService.sumWhalesyncEligibleRecordCountForOrganization(organizationId),
        this.dataFolderService.listConnectorServicesForOrganization(organizationId),
        this.runCountService.getCurrentMonthRunCounts(organizationId),
      ]);
    return { workbookCount, recordCount, whalesyncEligibleRecordCount, connectorServices, monthlyRunCounts };
  }

  /** Total record count for a single workbook (sum of its folders' counts). */
  @Get(':id/record-count')
  async getWorkbookRecordCount(
    @Param('id') id: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<RecordCountResponseDto> {
    const actor = userToActor(req.user);
    await this.service.assertReadableWorkbook(actor, id);
    const recordCount = await this.dataFolderService.sumRecordCountForWorkbook(id);
    return { recordCount };
  }

  @Get(':id')
  async findOne(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<Workspace> {
    const actor = userToActor(req.user);
    const workbook = await this.service.assertReadableWorkbook(actor, id);
    const schedulesByEntityId = await this.service.fetchSchedulesByEntityId(workbook.id as WorkbookId);
    const incrementalPullSupportByDataFolderId =
      await this.dataFolderService.computeIncrementalPullSupportByDataFolderId(workbook.dataFolders);
    return WorkspaceEntity.from(workbook, schedulesByEntityId, incrementalPullSupportByDataFolderId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: WorkbookId,
    @Body() updateWorkbookDto: UpdateWorkbookDto,
    @Req() req: RequestWithUser,
  ): Promise<Workspace> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, id);
    const dto = updateWorkbookDto;
    return WorkspaceEntity.from(await this.service.update(id, dto, actor));
  }

  @Patch(':id/settings')
  @HttpCode(204)
  async updateSettings(
    @Param('id') id: WorkbookId,
    @Body() updateSettingsDto: UpdateWorkbookSettingsDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    const workbook = await this.service.assertWritableWorkbook(actor, id);
    await this.service.updateWorkbookSettings(workbook, updateSettingsDto);
  }

  @Post(':id/pull-files')
  async pullFiles(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullFilesDto,
    @Req() req: RequestWithUser,
  ): Promise<PullFilesResponseDto> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, id);
    const dto = pullDto;
    return this.service.pullFiles(id, actor, dto.dataFolderIds, createRunContext('web'), dto.mode);
  }

  @Post(':id/pull-assets')
  async pullAssets(
    @Param('id') id: WorkbookId,
    @Body() pullDto: PullAssetsDto,
    @Req() req: RequestWithUser,
  ): Promise<PullAssetsResponseDto> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, id);
    return this.service.pullAssets(id, actor, pullDto.dataFolderIds, createRunContext('web'), {
      rehost: pullDto.rehost,
    });
  }

  @Delete(':id')
  @HttpCode(202)
  async remove(
    @Param('id') id: WorkbookId,
    @Query('force') force: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<DeleteWorkbookResponseDto> {
    const actor = userToActor(req.user);

    // `force=true` runs the synchronous hard-delete. Reserved for admins (production) or any
    // caller in non-production envs so integration/smoke tests can assert on a fully-deleted
    // workbook without polling for the background worker.
    const forceRequested = force === 'true' || force === '1';
    if (forceRequested) {
      const allowed = actor.isAdmin || !this.configService.isProductionEnvironment();
      if (!allowed) {
        throw new ForbiddenException('force=true is restricted to admins in production');
      }
      // Permission check happens inside service.delete via findOneOrThrow.
      await this.service.delete(id, actor);
      return { status: 'deleted', workbookId: id };
    }

    // Standard async path: read-only assertion (so non-admins can re-trigger on a workbook
    // that's already pending without leaking 404s mid-deletion). requestDeletion is idempotent.
    await this.service.assertReadableWorkbook(actor, id);
    await this.service.requestDeletion(id, actor);
    return { status: 'deletion_scheduled', workbookId: id };
  }

  @Post(':id/discard-changes')
  @HttpCode(204)
  async discardChanges(
    @Param('id') id: WorkbookId,
    @Body() body: { path?: string },
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, id);
    await this.service.discardChanges(id, actor, body.path);
  }

  @Post(':id/reset')
  @HttpCode(204)
  async reset(@Param('id') id: WorkbookId, @Req() req: RequestWithUser): Promise<void> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, id);
    await this.service.resetWorkbook(id, actor);
  }

  /* Start new Data Folder functions */
  @Get(':id/data-folders/list')
  async listDataFolders(@Param('id') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<DataFolderGroup[]> {
    const actor = userToActor(req.user);
    await this.service.assertReadableWorkbook(actor, workbookId);
    return await this.dataFolderService.listGroupedByConnectorBases(workbookId, actor);
  }

  /* Workspace Permission endpoints */
  @Get(':id/permissions')
  async listPermissions(
    @Param('id') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity[]> {
    const actor = userToActor(req.user);
    await this.service.assertReadableWorkbook(actor, workbookId);
    const permissions = await this.workspacePermissionsService.listByWorkbook(workbookId);
    return permissions.map((p) => new WorkspacePermissionEntity(p));
  }

  @Get(':id/invites')
  async listInvites(
    @Param('id') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<WorkspaceInviteEntity[]> {
    const actor = userToActor(req.user);
    await this.service.assertReadableWorkbook(actor, workbookId);
    const invites = await this.workspacePermissionsService.listInvitesByWorkbook(workbookId);
    return invites.map((i) => new WorkspaceInviteEntity(i));
  }

  @Post(':id/permissions/add')
  async addPermission(
    @Param('id') workbookId: WorkbookId,
    @Body() dto: AddWorkspacePermissionDto,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity | void> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, workbookId);
    const role = (dto.role ?? 'editor') as WorkspacePermissionRole;

    if (dto.userId) {
      await this.workspacePermissionsService.createByUserId(workbookId, dto.userId, role, actor);
    } else if (dto.email) {
      await this.workspacePermissionsService.createByEmail(workbookId, dto.email, role, actor);
    } else {
      throw new BadRequestException('Either userId or email must be provided');
    }
  }

  @Delete(':id/permission/:permissionId')
  @HttpCode(204)
  async removePermission(
    @Param('id') workbookId: WorkbookId,
    @Param('permissionId') permissionId: WorkspacePermissionId,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, workbookId);
    await this.workspacePermissionsService.delete(permissionId, actor);
  }

  @Delete(':id/invite/:inviteId')
  @HttpCode(204)
  async removeInvite(
    @Param('id') workbookId: WorkbookId,
    @Param('inviteId') inviteId: WorkspaceInviteId,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, workbookId);
    await this.workspacePermissionsService.deleteInvite(inviteId, actor);
  }

  @Patch(':id/permission/:permissionId')
  async updatePermission(
    @Param('id') workbookId: WorkbookId,
    @Param('permissionId') permissionId: WorkspacePermissionId,
    @Body() dto: UpdateWorkspacePermissionDto,
    @Req() req: RequestWithUser,
  ): Promise<WorkspacePermissionEntity> {
    const actor = userToActor(req.user);
    await this.service.assertWritableWorkbook(actor, workbookId);
    const role = dto.role as WorkspacePermissionRole;
    const permission = await this.workspacePermissionsService.update(permissionId, role, actor);
    return new WorkspacePermissionEntity(permission);
  }
}
