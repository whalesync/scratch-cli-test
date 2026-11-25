import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { CliTableSpecArtifact, CliWorkbookTableSpecsResponse, WorkbookId } from '@spinner/shared-types';
import type { Request } from 'express';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { PostHogService } from 'src/posthog/posthog.service';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import { assertUnreachable } from 'src/utils/asserts';
import {
  DataFolderTableSpecStoreService,
  type StoredTableSpecsForCliCacheRefreshConnection,
} from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { CliListWorkbookTableSpecsQueryDto } from './dtos/cli-workbook-table-specs-query.dto';
import { CliWorkbookTableSpecsEntity } from './entities/cli-workbook-table-specs.entity';
import { classifyScratchmdClientFromUserAgent } from './scratchmd-client-identification';

/**
 * Serves each linked folder's table spec and default view to `scratchmd` (DEV-13025), which writes them into its
 * local cache (`<ws>/.scratch/connections/scratch/<conn>/<folder>/schema.json` and `views/default.json`) instead of
 * copying them from the connection repo's git `.scratch/` mirror. Postgres is the only source; see
 * {@link DataFolderTableSpecStoreService.readTableSpecsAndDefaultViewsForCliCacheRefresh}.
 */
@Controller('cli/v1/workbooks')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class CliTableSpecsController {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly dataFolderTableSpecStore: DataFolderTableSpecStoreService,
    private readonly posthogService: PostHogService,
  ) {}

  /**
   * `GET /cli/v1/workbooks/:workbookId/table-specs[?connectorAccountId=coa_…][&metadataOnly=true]`: a complete
   * listing of the workbook's (or one connection's) linked folders, each with its table spec and default view as
   * `present` (verbatim stored text plus its SHA-256), `absent`, or `unreadable`. With `metadataOnly=true`, `present`
   * files carry only their SHA-256, so a client can find what changed with a small call and fetch content only then.
   * A `connectorAccountId` that isn't in the workbook is a 404.
   */
  @Get(':workbookId/table-specs')
  async listWorkbookTableSpecs(
    @Req() req: RequestWithUser & Request,
    @Param('workbookId') workbookId: string,
    @Query() query: CliListWorkbookTableSpecsQueryDto,
  ): Promise<CliWorkbookTableSpecsResponse> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);

    const metadataOnly = query.metadataOnly ?? false;
    const connectionsForCliCacheRefresh =
      await this.dataFolderTableSpecStore.readTableSpecsAndDefaultViewsForCliCacheRefresh(workbookId, {
        connectorAccountId: query.connectorAccountId,
        includeContent: !metadataOnly,
      });

    this.posthogService.trackCliListWorkbookTableSpecs(actor, workbookId, {
      connectorAccountId: query.connectorAccountId,
      metadataOnly,
      ...countListedTableSpecFiles(connectionsForCliCacheRefresh),
      scratchmdClient: classifyScratchmdClientFromUserAgent(req.get('user-agent')),
    });

    return CliWorkbookTableSpecsEntity.from(workbookId, connectionsForCliCacheRefresh);
  }
}

/** Tallies a listing for analytics: connections, folders, both files' statuses, and the content bytes sent. */
function countListedTableSpecFiles(connectionsForCliCacheRefresh: StoredTableSpecsForCliCacheRefreshConnection[]) {
  const listedFileCounts = {
    connectionCount: connectionsForCliCacheRefresh.length,
    folderCount: 0,
    presentFileCount: 0,
    absentFileCount: 0,
    unreadableFileCount: 0,
    contentBytes: 0,
  };
  const countListedFile = (listedFile: CliTableSpecArtifact): void => {
    switch (listedFile.status) {
      case 'present':
        listedFileCounts.presentFileCount++;
        if (listedFile.content !== undefined) {
          listedFileCounts.contentBytes += Buffer.byteLength(listedFile.content, 'utf8');
        }
        return;
      case 'absent':
        listedFileCounts.absentFileCount++;
        return;
      case 'unreadable':
        listedFileCounts.unreadableFileCount++;
        return;
      default:
        return assertUnreachable(listedFile);
    }
  };
  for (const { dataFolders } of connectionsForCliCacheRefresh) {
    listedFileCounts.folderCount += dataFolders.length;
    for (const { tableSpec, defaultView } of dataFolders) {
      countListedFile(tableSpec);
      countListedFile(defaultView);
    }
  }
  return listedFileCounts;
}
