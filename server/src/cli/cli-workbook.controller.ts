import {
  All,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import type { Request, Response } from 'express';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { userToActor } from 'src/users/types';
import { WorkbookConfigService, getConfigRepoId } from 'src/workbook/workbook-config.service';
import { WorkbookService } from 'src/workbook/workbook.service';
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
@UseGuards(ScratchAuthGuard)
export class CliWorkbookController {
  private readonly gitBackendUrl: string;

  constructor(
    private readonly workbookService: WorkbookService,
    private readonly configService: ScratchConfigService,
    private readonly posthogService: PostHogService,
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookConfigService: WorkbookConfigService,
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

    const workbooks = await this.workbookService.findAllForUser(actor, sortBy, sortOrder);

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
    checkWorkspacePermissions(actor, id as WorkbookId);
    const workbook = await this.workbookService.findOne(id as WorkbookId, actor);

    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    this.posthogService.trackCliListWorkbooks(actor, { scope: 'single', workbookId: id });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const accounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId: id },
      include: { dataFolders: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const connectorAccounts: CliConnectorAccountDto[] = accounts.map((ca) => ({
      id: ca.id,
      displayName: ca.displayName,
      service: ca.service,
      repoPath: ca.repoPath ?? undefined,
      gitUrl: `${baseUrl}/cli/v1/workbooks/${id}/connectors/${ca.id}/git`,
      dataFolders: ca.dataFolders.map((df) => ({ id: df.id, name: df.name })),
    }));

    const configGitUrl = `${baseUrl}/cli/v1/workbooks/${id}/config/git`;
    return this.toCliResponse(workbook, baseUrl, connectorAccounts, configGitUrl);
  }

  /**
   * Delete a workbook by ID.
   */
  @Delete(':id')
  async deleteWorkbook(@Req() req: RequestWithUser, @Param('id') id: string): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id as WorkbookId);

    // Verify workbook exists and user has access
    const workbook = await this.workbookService.findOne(id as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    await this.workbookService.delete(id as WorkbookId, actor);

    return { success: true };
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
    checkWorkspacePermissions(actor, workbookId);

    // Verify access
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    this.posthogService.trackCliGitOperation(actor, workbookId, { method: req.method });

    // Resolve the V2 composite repo ID
    let repoId: string;
    try {
      repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
      proxyResponse = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        },
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
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(value);
        await pump();
      };
      await pump();
    } else {
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

  // ── Workbook config repo endpoints ──────────────────────────────────────────

  /**
   * Initialize the workbook config git repo (idempotent).
   * Creates the repo at org/{orgId}/{workbookId}/{workbookId}.git
   */
  @Post(':id/config/init')
  async initConfigRepo(@Req() req: RequestWithUser, @Param('id') id: string): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id as WorkbookId);
    await this.workbookConfigService.initConfigRepo(actor.organizationId, id as WorkbookId);
    return { success: true };
  }

  /**
   * Push all Postgres syncs for this workbook to the config git repo as JSON files.
   * Converts from Postgres SyncMapping format to portable v4 format.
   */
  @Post(':id/config/push-syncs')
  async pushSyncsToGit(@Req() req: RequestWithUser, @Param('id') id: string): Promise<{ count: number }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id as WorkbookId);
    return this.workbookConfigService.pushSyncs(actor.organizationId, id as WorkbookId, actor);
  }

  /**
   * Git HTTP proxy for the workbook config repo.
   * Allows `git clone/fetch/push` of the config repo from the CLI.
   */
  @All(':id/config/git/*path')
  async configGitProxy(
    @Req() req: RequestWithUser & Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, id as WorkbookId);

    const workbook = await this.workbookService.findOne(id as WorkbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const repoId = getConfigRepoId(actor.organizationId, id as WorkbookId);
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
