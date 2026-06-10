import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  AdminWorkbookConnectionDto,
  AdminWorkbookDto,
  DecryptedCredentials,
  GetAllJobsResponseDto,
} from '@spinner/shared-types';
import {
  createSubscriptionId,
  ScratchPlanType,
  SyncId,
  ValidatedChangeUserOrganizationDto,
  ValidatedUpdateSettingsDto,
  WorkbookId,
} from '@spinner/shared-types';
import type { Request } from 'express';
import { AuditLogService } from 'src/audit/audit-log.service';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { EmailService } from 'src/email/email.service';
import { getLastestExpiringSubscription } from 'src/payment/helpers';
import { getPlanTypeFromString } from 'src/payment/plans';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ScratchGitClient } from 'src/scratch-git/scratch-git.client';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { User } from 'src/users/entities/user.entity';
import { userToActor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { DbJobStatus, dbJobToJobEntity } from '../job/entities/job.entity';
import { JobService } from '../job/job.service';
import { UpdateSettingsDto } from '../users/dto/update-settings.dto';
import { DevToolsService, WorkbookExportJson } from './dev-tools.service';
import { ChangeUserOrganizationDto, UpdateDevSubscriptionDto } from './dto/dev-tools.dto';
import { UserDetail } from './entities/user-detail.entity';

interface SyncDataFoldersRequestBody {
  workbookId: WorkbookId;
  syncId: SyncId;
}

/**
 * Controller for special case dev tools
 */
@Controller('dev-tools')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class DevToolsController {
  constructor(
    private readonly configService: ScratchConfigService,
    private readonly dbService: DbService,
    private readonly usersService: UsersService,
    private readonly snapshotService: WorkbookService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly auditLogService: AuditLogService,
    private readonly devToolsService: DevToolsService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly jobService: JobService,
    private readonly scratchGitClient: ScratchGitClient,
    private readonly slackNotificationService: SlackNotificationService,
    private readonly emailService: EmailService,
  ) {}

  @Post('users/change-organization')
  @HttpCode(204)
  async changeUserOrganization(
    @Body() dtoParam: ChangeUserOrganizationDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException("Only admins can change a user's organization");
    }

    const dto = dtoParam as ValidatedChangeUserOrganizationDto;
    await this.devToolsService.changeUserOrganization(dto.userId, dto.newOrganizationId, dto.deleteOldOrganization);
  }

  @Get('users/search')
  async searchUsers(@Query('query') query: string, @Req() req: RequestWithUser): Promise<User[]> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can query users');
    }

    const results = await this.usersService.search(query);

    return results.map((result) => new User(result));
  }

  @Get('users/:id/details')
  async getUserDetails(@Param('id') id: string, @Req() req: RequestWithUser): Promise<UserDetail> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can get user details');
    }

    const targetUser = await this.usersService.findOne(id);
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    const actor = userToActor(targetUser);
    const snapshots = await this.snapshotService.findAllForUser(actor);
    const connectorAccounts = await this.connectorAccountService.findAllForOrganization(actor);
    const auditLogs = await this.auditLogService.findEventsForUser(actor.userId, 20, undefined);
    return new UserDetail(targetUser, snapshots, connectorAccounts, auditLogs);
  }

  /* Admin tool to set user settings for a target user */
  @Patch('users/:id/settings')
  @HttpCode(204)
  async updateUserSettings(
    @Param('id') id: string,
    @Body() dtoParam: UpdateSettingsDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const dto = dtoParam as ValidatedUpdateSettingsDto;
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can update user settings');
    }

    const targetUser = await this.usersService.findOne(id);
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    await this.usersService.updateUserSettings(targetUser, dto);
  }

  /* Subscription testing tools */
  @Post('subscription/plan/update')
  async updateUserSubscription(@Req() req: RequestWithUser, @Body() dto: UpdateDevSubscriptionDto): Promise<void> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can cancel their developer subscription');
    }

    if (this.configService.isProductionEnvironment()) {
      throw new BadRequestException('This endpoint is only available in non-production environments');
    }
    const currentSubscription = getLastestExpiringSubscription(req.user.organization?.subscriptions ?? []);
    const planType = getPlanTypeFromString(dto.planType ?? '');
    if (!planType) {
      throw new BadRequestException(`Invalid plan type: ${dto.planType}`);
    }

    if (planType === ScratchPlanType.FREE_PLAN && !currentSubscription) {
      throw new BadRequestException('You cannot downgrade to the free plan if you do not have an active subscription');
    }

    if (currentSubscription) {
      if (planType === ScratchPlanType.FREE_PLAN) {
        // cancel the current subscription
        await this.dbService.client.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            expiration: new Date(),
            stripeStatus: 'canceled',
            cancelAt: new Date(),
            lastInvoicePaid: false,
          },
        });
      } else {
        await this.dbService.client.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            planType: dto.planType,
            expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
            stripeStatus: 'active',
            cancelAt: null,
            lastInvoicePaid: true,
          },
        });
      }
    } else if (planType !== ScratchPlanType.FREE_PLAN) {
      // create a fake new subscription
      await this.dbService.client.subscription.create({
        data: {
          id: createSubscriptionId(),
          userId: req.user.id,
          organizationId: req.user.organizationId ?? '',
          planType: dto.planType,
          expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
          stripeSubscriptionId: createSubscriptionId(), // create a fake stripe subscription id
          cancelAt: null,
          lastInvoicePaid: true,
          stripeStatus: 'active',
        },
      });
    }
  }

  @Post('subscription/plan/expire')
  async forceExpireSubscription(@Req() req: RequestWithUser): Promise<void> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can cancel their developer subscription');
    }

    if (this.configService.isProductionEnvironment()) {
      throw new BadRequestException('This endpoint is only available in non-production environments');
    }

    const currentSubscription = getLastestExpiringSubscription(req.user.organization?.subscriptions ?? []);
    if (!currentSubscription) {
      throw new BadRequestException('You do not have an active subscription to expire');
    }

    await this.dbService.client.subscription.update({
      where: { id: currentSubscription.id },
      data: {
        expiration: new Date(),
        stripeStatus: 'expired',
        cancelAt: null,
        lastInvoicePaid: true,
      },
    });
  }
  @Post('subscription/plan/cancel')
  async forceCancelSubscription(@Req() req: RequestWithUser): Promise<void> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can cancel their developer subscription');
    }

    if (this.configService.isProductionEnvironment()) {
      throw new BadRequestException('This endpoint is only available in non-production environments');
    }

    const currentSubscription = getLastestExpiringSubscription(req.user.organization?.subscriptions ?? []);
    if (!currentSubscription) {
      throw new BadRequestException('You do not have an active subscription to cance');
    }

    const newCancelDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);

    await this.dbService.client.subscription.update({
      where: { id: currentSubscription.id },
      data: {
        expiration: newCancelDate,
        cancelAt: newCancelDate,
        stripeStatus: 'active',
        lastInvoicePaid: true,
      },
    });
  }

  /* Connector account credentials (admin) */
  @Get('connections/:id')
  async getConnectionCredentials(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can view connection credentials');
    }

    const account = await this.connectorAccountService.findOneByIdAdmin(id);
    const { id: accountId, service, ...rest } = account;

    // Extract only DecryptedCredentials fields (strip ConnectorAccount DB fields)
    const credentialKeys: (keyof DecryptedCredentials)[] = [
      'apiKey',
      'username',
      'password',
      'endpoint',
      'domain',
      'connectionString',
      'supabaseProjects',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthExpiresAt',
      'oauthWorkspaceId',
      'customOAuthClientId',
      'customOAuthClientSecret',
    ];
    const credentials: Record<string, unknown> = {};
    for (const key of credentialKeys) {
      if (rest[key] !== undefined) {
        credentials[key] = rest[key];
      }
    }

    return { id: accountId, service, credentials };
  }

  /* Admin job listing */
  @Get('jobs')
  async getAllJobs(
    @Req() req: RequestWithUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('statuses') statuses?: string,
    @Query('userId') userId?: string,
  ): Promise<GetAllJobsResponseDto> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can list all jobs');
    }

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const statusFilter = statuses ? (statuses.split(',') as DbJobStatus[]) : undefined;

    const { jobs, total } = await this.jobService.getAllJobs(limitNum, offsetNum, {
      statuses: statusFilter,
      userId,
    });

    return {
      jobs: jobs.map((job) => {
        const entity = dbJobToJobEntity(job);
        return {
          dbJobId: job.id,
          bullJobId: entity.bullJobId,
          runId: entity.runId,
          workbookId: entity.workbookId,
          dataFolderId: entity.dataFolderId,
          userId: job.userId,
          type: entity.type,
          state: entity.state,
          publicProgress: entity.publicProgress as Record<string, unknown>,
          processedOn: job.processedOn?.toISOString() ?? null,
          finishedOn: job.finishedOn?.toISOString() ?? null,
          createdAt: job.createdAt.toISOString(),
          failedReason: entity.failedReason,
          runContext: entity.runContext,
        };
      }),
      total,
      limit: limitNum,
      offset: offsetNum,
    };
  }

  /* Admin workbooks listing (cross-org) */
  @Get('workbooks')
  async getAllWorkbooks(
    @Req() req: RequestWithUser,
    @Query('search') search?: string,
    @Query('services') services?: string,
    @Query('serviceMode') serviceMode?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ workbooks: AdminWorkbookDto[]; total: number }> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can list all workbooks');
    }

    const limitNum = limit ? parseInt(limit, 10) : 25;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const serviceList = services ? services.split(',').filter(Boolean) : [];
    const isAnd = serviceMode === 'AND';

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { organization: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (serviceList.length > 0) {
      if (isAnd) {
        // AND: workbook must have at least one connection for each requested service
        where.AND = serviceList.map((s) => ({ connectorAccounts: { some: { service: s } } }));
      } else {
        // OR: workbook must have at least one connection whose service is in the list
        where.connectorAccounts = { some: { service: { in: serviceList } } };
      }
    }

    const [workbooks, total] = await Promise.all([
      this.dbService.client.workbook.findMany({
        where,
        include: {
          organization: { select: { name: true } },
          connectorAccounts: {
            select: { id: true, displayName: true, service: true, authType: true, createdAt: true, repoPath: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limitNum,
        skip: offsetNum,
      }),
      this.dbService.client.workbook.count({ where }),
    ]);

    const result: AdminWorkbookDto[] = workbooks.map((w) => {
      const org = (w as unknown as { organization: { name: string } }).organization;
      const connections: AdminWorkbookConnectionDto[] = w.connectorAccounts.map((ca) => ({
        id: ca.id,
        displayName: ca.displayName,
        service: ca.service,
        authType: ca.authType,
        createdAt: ca.createdAt.toISOString(),
        repoPath: ca.repoPath,
      }));
      return {
        id: w.id as WorkbookId,
        name: w.name,
        version: w.version,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
        organizationId: w.organizationId,
        organizationName: org.name,
        userId: w.userId,
        isPendingDelete: w.isPendingDelete,
        connections,
      };
    });

    return { total, workbooks: result };
  }

  /* Sync data folders job trigger */
  @Post('jobs/sync-data-folders')
  async syncDataFoldersJob(@Body() body: SyncDataFoldersRequestBody, @Req() req: RequestWithUser) {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can trigger sync data folders jobs');
    }

    // Look up workbook to get userId and organizationId
    const workbook = await this.dbService.client.workbook.findUnique({
      where: { id: body.workbookId },
      select: { userId: true, organizationId: true },
    });

    if (!workbook) {
      throw new NotFoundException(`Workbook ${body.workbookId} not found`);
    }

    const job = await this.bullEnqueuerService.enqueueSyncDataFoldersJob(
      body.workbookId,
      body.syncId,
      {
        userId: workbook.userId ?? req.user.id,
        organizationId: workbook.organizationId,
      },
      undefined,
      createRunContext('web'),
    );

    return {
      success: true,
      jobId: job.id,
      message: 'Sync data folders job queued successfully',
    };
  }

  /* Export a workbook as JSON (decrypted credentials) */
  @Get('workbooks/:id/export')
  async exportWorkbook(@Param('id') id: string, @Req() req: RequestWithUser): Promise<WorkbookExportJson> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can export workbooks');
    }

    return this.devToolsService.exportWorkbook(id);
  }

  /* Import a workbook from JSON */
  @Post('workbooks/import')
  async importWorkbook(@Body() body: unknown, @Req() req: RequestWithUser) {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can import workbooks');
    }

    return this.devToolsService.importWorkbook(
      body as Parameters<typeof this.devToolsService.importWorkbook>[0],
      req.user.id,
      req.user.organizationId ?? '',
    );
  }

  /* Get the git URL and clone command for a connector account's repo (for `git clone`). */
  @Get('connections/:id/git-url')
  async getConnectionGitUrl(
    @Param('id') connectorAccountId: string,
    @Req() req: RequestWithUser & Request,
  ): Promise<{ gitUrl: string; gitCloneCommand: string }> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can view connection git URLs');
    }

    const account = await this.dbService.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      select: { id: true, workbookId: true },
    });

    if (!account) {
      throw new NotFoundException(`Connector account ${connectorAccountId} not found`);
    }

    // The CLI git endpoint requires `Authorization: API-Token <token>`. Build a clone
    // command that injects the requesting user's API token via http.extraHeader so
    // `git clone` works without prompting.
    const now = new Date();
    const apiToken = req.user.apiTokens?.find((t) => t.expiresAt > now);
    if (!apiToken) {
      throw new BadRequestException('No valid API token found for the current user');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const gitUrl = `${baseUrl}/cli/v1/workbooks/${account.workbookId}/connectors/${account.id}/git`;
    const gitCloneCommand = `git -c http.extraHeader="Authorization: API-Token ${apiToken.token}" clone ${gitUrl}`;
    return { gitUrl, gitCloneCommand };
  }

  /* Move a connection's git repo to a new path (copy -> update DB -> delete old) */
  @Post('connections/:id/move-repo')
  async moveRepo(
    @Param('id') connectorAccountId: string,
    @Body() body: { newRepoPath: string },
    @Req() req: RequestWithUser,
  ) {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can move repos');
    }

    const account = await this.dbService.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      select: { id: true, repoPath: true, displayName: true },
    });

    if (!account) {
      throw new NotFoundException(`Connector account ${connectorAccountId} not found`);
    }
    if (!account.repoPath) {
      throw new BadRequestException(`Connector account ${connectorAccountId} has no repoPath`);
    }
    if (account.repoPath === body.newRepoPath) {
      throw new BadRequestException('New repo path is the same as the current one');
    }

    // 1. Copy repo on the git server
    await this.scratchGitClient.copyRepo(account.repoPath, body.newRepoPath);

    // 2. Update repoPath in the database
    await this.dbService.client.connectorAccount.update({
      where: { id: connectorAccountId },
      data: { repoPath: body.newRepoPath },
    });

    // 3. Delete the old repo
    try {
      await this.scratchGitClient.deleteRepo(account.repoPath);
    } catch (e) {
      // Log but don't fail — the copy and DB update succeeded
      console.warn(`[DevTools] Failed to delete old repo ${account.repoPath}:`, e);
    }

    return {
      success: true,
      oldRepoPath: account.repoPath,
      newRepoPath: body.newRepoPath,
    };
  }

  /* Waitlist management */
  @Get('users/waitlist-pending')
  async getWaitlistPending(@Req() req: RequestWithUser): Promise<User[]> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can view the waitlist');
    }

    const users = await this.dbService.client.user.findMany({
      where: { waitlistApproved: false },
      orderBy: { createdAt: 'desc' },
      include: UserCluster._validator.include,
    });

    return users.map((user) => new User(user));
  }

  @Patch('users/:id/waitlist-approved')
  @HttpCode(204)
  async approveWaitlistUser(@Param('id') id: string, @Req() req: RequestWithUser): Promise<void> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can approve waitlist users');
    }

    const targetUser = await this.usersService.findOne(id);
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    await this.dbService.client.user.update({
      where: { id },
      data: { waitlistApproved: true },
    });

    const adminUser = await this.usersService.findOne(req.user.id);
    if (adminUser) {
      await this.slackNotificationService.sendMessage(SlackFormatters.waitlistUserApproved(targetUser, adminUser));
    }

    if (targetUser.email) {
      void this.emailService.sendWaitlistApproved({ to: targetUser.email });
    }
  }

  /* Email testing */
  @Post('email/send-test')
  async sendTestEmail(
    @Body() body: { templateId: string; to: string; dynamicTemplateData: Record<string, string> },
    @Req() req: RequestWithUser,
  ): Promise<{ success: true }> {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can send test emails');
    }

    if (!body.templateId || !body.to) {
      throw new BadRequestException('templateId and to are required');
    }

    await this.emailService.sendTestEmail({
      to: body.to,
      templateId: body.templateId,
      dynamicTemplateData: body.dynamicTemplateData ?? {},
    });
    return { success: true };
  }
}
