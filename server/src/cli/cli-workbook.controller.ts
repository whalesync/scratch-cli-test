import {
  All,
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DeleteWorkbookResponseDto, WorkbookId } from '@spinner/shared-types';
import type { Request, Response } from 'express';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { PublishFromGitDto, PublishPlanBuildDto, PublishPlanRunDto } from 'src/publish-plan/dto/publish-v2.dto';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { userToActor } from 'src/users/types';
import { WorkbookRepoService, getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { Readable } from 'stream';
import {
  CliConnectorAccountDto,
  CliWorkbookResponseDto,
  CreateCliWorkbookDto,
  ListWorkbooksQueryDto,
  ListWorkbooksResponseDto,
} from './dtos/cli-workbook.dto';

/**
 * Controller for CLI workbook operations.
 * Provides simplified endpoints for CLI access to workbook management.
 *
 * All endpoints require API token authentication via Authorization header.
 */
@Controller('cli/v1/workbooks')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class CliWorkbookController {
  private readonly gitBackendUrl: string;

  constructor(
    private readonly workbookService: WorkbookService,
    private readonly configService: ScratchConfigService,
    private readonly posthogService: PostHogService,
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookRepoService: WorkbookRepoService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly publishPlanBuildService: PublishPlanBuildService,
    private readonly auditLogService: AuditLogService,
  ) {
    this.gitBackendUrl = this.configService.getScratchGitBackendUrl();
  }

  /**
   * List all workbooks for the authenticated user.
   */
  @Get()
  async listWorkbooks(
    @Req() req: RequestWithUser,
    @Query() query: ListWorkbooksQueryDto,
  ): Promise<ListWorkbooksResponseDto> {
    const actor = userToActor(req.user);
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';

    const allWorkbooks = await this.workbookService.findAllForUser(actor, sortBy, sortOrder);
    const workbooks = allWorkbooks.filter((wb) => !wb.isPendingDelete);

    this.posthogService.trackCliListWorkbooks(actor, { workbookCount: workbooks.length, scope: 'list' });

    return {
      workbooks: workbooks.map((wb) => this.toCliResponse(wb)),
    };
  }

  /**
   * Create a new workbook.
   */
  @Post()
  async createWorkbook(
    @Req() req: RequestWithUser,
    @Body() dto: CreateCliWorkbookDto,
  ): Promise<CliWorkbookResponseDto> {
    const actor = userToActor(req.user);

    const workbook = await this.workbookService.create(
      {
        name: dto.name,
      },
      actor,
    );

    return this.toCliResponse(workbook);
  }

  /**
   * Get a single workbook by ID.
   */
  @Get(':id')
  async getWorkbook(@Req() req: RequestWithUser & Request, @Param('id') id: string): Promise<CliWorkbookResponseDto> {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, id as WorkbookId);

    this.posthogService.trackCliListWorkbooks(actor, { scope: 'single', workbookId: id });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const accounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId: id },
      include: { dataFolders: { select: { id: true, name: true, path: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const connectorAccounts: CliConnectorAccountDto[] = accounts.map((ca) => ({
      id: ca.id,
      displayName: ca.displayName,
      service: ca.service,
      repoPath: ca.repoPath ?? undefined,
      gitUrl: `${baseUrl}/cli/v1/workbooks/${id}/connectors/${ca.id}/git`,
      dataFolders: ca.dataFolders.map((df) => ({ id: df.id, name: df.name, path: df.path })),
    }));

    const configGitUrl = `${baseUrl}/cli/v1/workbooks/${id}/config/git`;
    return this.toCliResponse(workbook, baseUrl, connectorAccounts, configGitUrl);
  }

  /**
   * Delete a workbook by ID. Returns 202 with `status: 'deletion_scheduled'` for the
   * default async path. With `?force=true` (admin-only in production), runs the synchronous
   * hard-delete and returns `status: 'deleted'`.
   */
  @Delete(':id')
  async deleteWorkbook(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Query('force') force: string | undefined,
  ): Promise<DeleteWorkbookResponseDto> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;

    const forceRequested = force === 'true' || force === '1';
    if (forceRequested) {
      const allowed = actor.isAdmin || !this.configService.isProductionEnvironment();
      if (!allowed) {
        throw new ForbiddenException('force=true is restricted to admins in production');
      }
      await this.workbookService.delete(workbookId, actor);
      return { status: 'deleted', workbookId };
    }

    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    await this.workbookService.requestDeletion(workbookId, actor);
    return { status: 'deletion_scheduled', workbookId };
  }

  /**
   * V2 per-connector git HTTP proxy endpoint.
   * Proxies git operations for a specific connector account's repo.
   */
  @All(':id/connectors/:connectorAccountId/git/*path')
  async connectorGitProxy(
    @Req() req: RequestWithUser & Request,
    @Param('id') id: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Res() res: Response,
  ): Promise<void> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    // Git proxy is treated as a read for visibility purposes — pending workbooks remain
    // cloneable so users can pull final state before the deletion job purges the repo.
    await this.workbookService.assertReadableWorkbook(actor, workbookId);

    this.posthogService.trackCliGitOperation(actor, workbookId, { method: req.method });

    // Resolve the V2 composite repo ID
    let repoId: string;
    try {
      repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    } catch (err) {
      WSLogger.error({
        source: 'CliWorkbookController.connectorGitProxy',
        message: 'Failed to resolve V2 repo ID',
        workbookId,
        connectorAccountId,
        error: err,
      });
      res.status(404).json({
        statusCode: 404,
        message: `Connector account ${connectorAccountId} not found or has no repo`,
      });
      return;
    }

    const gitPath = req.url.replace(`/cli/v1/workbooks/${id}/connectors/${connectorAccountId}/git`, '');
    const targetUrl = `${this.gitBackendUrl}/${repoId}.git${gitPath}`;

    WSLogger.info({
      source: 'CliWorkbookController.connectorGitProxy',
      message: `Proxying V2 git request`,
      method: req.method,
      targetUrl,
      workbookId,
      connectorAccountId,
      repoId,
    });

    await this.proxyToGitBackend(targetUrl, workbookId, req, res);
  }

  @Post(':id/connectors/:connectorAccountId/discard-remote-dirty-changes')
  @HttpCode(204)
  async discardRemoteDirtyChanges(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Body() body: { path: string },
  ): Promise<void> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    // Mutation: discarding dirty changes blocked once the workbook is pending deletion.
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    await this.scratchGitService.discardChanges(repoId, body.path);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Discarded remote dirty changes at ${body.path} for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.discard_remote_dirty_changes',
        workbookId,
        connectorAccountId,
        path: body.path,
      },
    });
  }

  /**
   * Proxy an HTTP request to the git backend and stream the response back.
   */
  private async proxyToGitBackend(
    targetUrl: string,
    workbookId: WorkbookId,
    req: Request,
    res: Response,
  ): Promise<void> {
    // Stream the request body directly to the git backend without buffering.
    // This avoids body-parser size limits and reduces memory usage for large packfiles.
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    const body: BodyInit | undefined = hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined;

    let proxyResponse: globalThis.Response;
    try {
      // Proxy the request to git backend
      const proxyHeaders: Record<string, string> = {
        'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      };
      if (req.headers['content-length']) {
        proxyHeaders['Content-Length'] = req.headers['content-length'];
      }

      proxyResponse = await fetch(targetUrl, {
        method: req.method,
        headers: proxyHeaders,
        body,
        // @ts-expect-error -- Node fetch requires duplex for streaming request bodies
        duplex: 'half',
      });
    } catch (fetchError) {
      WSLogger.error({
        source: 'CliWorkbookController.proxyToGitBackend',
        message: `Failed to connect to git backend`,
        targetUrl,
        gitBackendUrl: this.gitBackendUrl,
        workbookId,
        error: fetchError,
      });
      res.status(502).json({
        statusCode: 502,
        message: 'Git backend is unreachable',
        detail: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
      return;
    }

    // Dump full response metadata for debugging
    const responseHeaders: Record<string, string> = {};
    proxyResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    WSLogger.debug({
      source: 'CliWorkbookController.proxyToGitBackend',
      message: `Git backend response received`,
      method: req.method,
      targetUrl,
      workbookId,
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      type: proxyResponse.type,
      redirected: proxyResponse.redirected,
      url: proxyResponse.url,
      hasBody: !!proxyResponse.body,
      responseHeaders,
    });

    if (!proxyResponse.ok) {
      // Clone the response so we can read the body for logging without consuming the stream
      const cloned = proxyResponse.clone();
      const responseBody = await cloned.text().catch(() => '(unable to read body)');
      WSLogger.error({
        source: 'CliWorkbookController.proxyToGitBackend',
        message: `Git backend returned error`,
        targetUrl,
        workbookId,
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        responseHeaders,
        responseBody,
      });
    }

    // Copy response headers
    proxyResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(proxyResponse.status);

    // Stream the response body
    if (proxyResponse.body) {
      const reader = proxyResponse.body.getReader();
      let bytesTransferred = 0;
      try {
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (!done && result.value) {
            bytesTransferred += result.value.length;
            res.write(result.value);
          }
        }
        res.end();
        WSLogger.debug({
          source: 'CliWorkbookController.proxyToGitBackend',
          message: `Git proxy stream completed`,
          targetUrl,
          workbookId,
          bytesTransferred,
        });
      } catch (streamError) {
        WSLogger.error({
          source: 'CliWorkbookController.proxyToGitBackend',
          message: `Stream error while proxying git response`,
          targetUrl,
          workbookId,
          bytesTransferred,
          status: proxyResponse.status,
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
        // Try to end the response so the client gets a proper error instead of "hung up"
        if (!res.writableEnded) {
          res.end();
        }
      }
    } else {
      WSLogger.warn({
        source: 'CliWorkbookController.proxyToGitBackend',
        message: `Git backend returned no response body`,
        targetUrl,
        workbookId,
        status: proxyResponse.status,
      });
      res.end();
    }
  }

  /**
   * Convert a workbook to the CLI response format.
   */
  private toCliResponse(
    workbook: {
      id: string;
      name: string | null;
      createdAt: Date;
      updatedAt: Date;
      version?: number;
      snapshotTables?: unknown[];
    },
    baseUrl?: string,
    connectorAccounts?: CliConnectorAccountDto[],
    configGitUrl?: string,
  ): CliWorkbookResponseDto {
    return {
      id: workbook.id,
      name: workbook.name ?? undefined,
      createdAt: workbook.createdAt.toISOString(),
      updatedAt: workbook.updatedAt.toISOString(),
      tableCount: workbook.snapshotTables?.length ?? 0,
      version: workbook.version ?? 2,
      connectorAccounts,
      configGitUrl,
    };
  }

  // ── Publish from git ────────────────────────────────────────────────────────

  /**
   * Trigger a publish job from a local publish plan stored in the connector's git repo (dirty branch).
   * The CLI calls this after `scratchmd2 files upload` has pushed the plan to the server.
   */
  @Post(':id/publish-v2/run-from-git')
  async runPublishFromGit(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: PublishFromGitDto,
  ): Promise<{ jobId: string | number | undefined }> {
    const actor = userToActor(req.user);
    const workbook = await this.workbookService.assertWritableWorkbook(actor, id as WorkbookId);

    const job = await this.bullEnqueuerService.enqueuePublishFromGitJob(
      id as WorkbookId,
      req.user.id,
      body.connectorAccountId,
      body.planPath,
    );

    await this.auditLogService.logEvent({
      actor,
      eventType: 'publish',
      message: `Queued legacy publish-from-git job for ${workbook.name ?? id}`,
      entityId: id as WorkbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.publish_v2.run_from_git',
        workbookId: id,
        connectorAccountId: body.connectorAccountId,
        planPath: body.planPath,
        jobId: job.id ? String(job.id) : null,
        deprecated: true,
      },
    });

    return { jobId: job.id };
  }

  /**
   * CLI shim over `PublishPlanController.planAsJob`. Same behavior as the web
   * client's `/workbook/:id/publish-v2/plan-job`, just lifted into the
   * versioned `/cli/v1/...` namespace so the CLI doesn't have to leave it.
   * The CLI calls this AFTER `/upload-patch/commit` has applied its patches
   * to the dirty branch — `/upload-patch/commit` is intentionally patch-only.
   */
  @Post(':id/publish-v2/plan-job')
  async planPublishAsJob(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: PublishPlanBuildDto,
  ): Promise<{ jobId: string | number | null; pipelineId: string | null }> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    if (!body.connectorAccountId) {
      throw new BadRequestException('connectorAccountId is required');
    }

    const hasDiffs = await this.publishPlanBuildService.hasDiffs(
      workbookId,
      body.connectorAccountId,
      body.folderPath,
      body.filePath,
    );
    if (!hasDiffs) {
      return { jobId: null, pipelineId: null };
    }

    const { pipelineId } = await this.publishPlanBuildService.createPipeline(
      workbookId,
      req.user.id,
      body.connectorAccountId,
    );

    const job = await this.bullEnqueuerService.enqueuePlanPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      pipelineId,
      body.connectorAccountId,
      body.runAfterPlan ?? false,
      body.folderPath,
      body.filePath,
      undefined,
      createRunContext('cli'),
    );
    await this.publishPlanBuildService.setActiveJob(pipelineId, job.id!.toString());

    await this.auditLogService.logEvent({
      actor,
      eventType: 'publish',
      message: `Queued publish-plan job for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.publish_v2.plan_job',
        workbookId,
        connectorAccountId: body.connectorAccountId,
        pipelineId,
        jobId: job.id ? String(job.id) : null,
        runAfterPlan: body.runAfterPlan ?? false,
        folderPath: body.folderPath ?? null,
        filePath: body.filePath ?? null,
      },
    });

    return { jobId: job.id ?? null, pipelineId };
  }

  /**
   * CLI shim over `PublishPlanController.runAsJob`. Runs the publish pipeline
   * created by an earlier plan-job call.
   */
  @Post(':id/publish-v2/run-job')
  async runPublishAsJob(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: PublishPlanRunDto,
  ): Promise<{ jobId: string | number | null }> {
    const actor = userToActor(req.user);
    const workbookId = id as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    const job = await this.bullEnqueuerService.enqueueRunPipelineJob(
      workbookId,
      { userId: req.user.id, organizationId: req.user.organization?.id ?? '' },
      body.pipelineId,
      body.executeSinglePhase,
      undefined,
      createRunContext('cli'),
    );
    await this.publishPlanBuildService.setActiveJob(body.pipelineId, job.id!.toString());

    await this.auditLogService.logEvent({
      actor,
      eventType: 'publish',
      message: `Queued publish-run job for ${workbook.name ?? workbookId}`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.publish_v2.run_job',
        workbookId,
        pipelineId: body.pipelineId,
        jobId: job.id ? String(job.id) : null,
        executeSinglePhase: body.executeSinglePhase ?? null,
      },
    });

    return { jobId: job.id ?? null };
  }

  // ── Workbook repo endpoints ─────────────────────────────────────────────────

  /**
   * @deprecated Legacy/manual endpoint.
   *
   * Normal sync flows already initialize the workbook config repo automatically when syncs
   * are created, updated, or deleted via SyncService.
   *
   * Initializes the workbook git repo (idempotent).
   * Creates the repo at org/{orgId}/{workbookId}/{workbookId}.git.
   */
  @Post(':id/config/init')
  async initWorkbookRepo(@Req() req: RequestWithUser, @Param('id') id: string): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    // Init is a mutation — block on pending workbooks.
    const workbook = await this.workbookService.assertWritableWorkbook(actor, id as WorkbookId);
    WSLogger.warn({
      source: 'CliWorkbookController.initWorkbookRepo',
      message: 'Deprecated workbook config init endpoint called',
      workbookId: id,
      userId: actor.userId,
    });
    await this.workbookRepoService.initWorkbookRepo(workbook.organizationId, id as WorkbookId);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Initialized workbook config repo for ${workbook.name ?? id}`,
      entityId: id as WorkbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.config.init',
        workbookId: id,
        deprecated: true,
      },
    });

    return { success: true };
  }

  /**
   * @deprecated Legacy/manual endpoint.
   *
   * Normal sync flows already push the current sync definitions to the workbook config repo
   * automatically when syncs are created, updated, or deleted via SyncService.
   *
   * Pushes all Postgres syncs for this workbook to the workbook git repo as JSON files.
   * Converts from Postgres SyncMapping format to portable v4 format.
   */
  @Post(':id/config/push-syncs')
  async pushSyncsToGit(@Req() req: RequestWithUser, @Param('id') id: string): Promise<{ count: number }> {
    const actor = userToActor(req.user);
    // Push-syncs is a mutation — block on pending workbooks.
    const workbook = await this.workbookService.assertWritableWorkbook(actor, id as WorkbookId);
    WSLogger.warn({
      source: 'CliWorkbookController.pushSyncsToGit',
      message: 'Deprecated workbook config push-syncs endpoint called',
      workbookId: id,
      userId: actor.userId,
    });
    const result = await this.workbookRepoService.pushSyncs(workbook.organizationId, id as WorkbookId, actor);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Pushed ${result.count} sync definition(s) to config repo for ${workbook.name ?? id}`,
      entityId: id as WorkbookId,
      organizationId: workbook.organizationId,
      context: {
        action: 'workbook.config.push_syncs',
        workbookId: id,
        count: result.count,
        deprecated: true,
      },
    });

    return result;
  }

  /**
   * Git HTTP proxy for the workbook repo.
   * Allows `git clone/fetch/push` of the workbook repo from the CLI.
   */
  @All(':id/config/git/*path')
  async configGitProxy(
    @Req() req: RequestWithUser & Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const actor = userToActor(req.user);
    // Config git proxy is a read for visibility purposes — pending workbooks remain
    // cloneable so users can pull final state before the deletion job purges the repo.
    const workbook = await this.workbookService.assertReadableWorkbook(actor, id as WorkbookId);
    const repoId = getWorkbookRepoPath(workbook.organizationId, id as WorkbookId);
    const gitPath = req.url.replace(`/cli/v1/workbooks/${id}/config/git`, '');
    const targetUrl = `${this.gitBackendUrl}/${repoId}.git${gitPath}`;

    WSLogger.info({
      source: 'CliWorkbookController.configGitProxy',
      message: 'Proxying config git request',
      method: req.method,
      targetUrl,
      workbookId: id,
    });

    await this.proxyToGitBackend(targetUrl, id as WorkbookId, req, res);
  }
}
