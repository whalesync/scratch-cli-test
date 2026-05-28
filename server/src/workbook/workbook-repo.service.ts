import { Injectable, NotFoundException } from '@nestjs/common';
import { TableMappingV1, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ScratchGitClient } from 'src/scratch-git/scratch-git.client';
import { parseStoredMappings } from 'src/sync/sync-mapping.schema';
import { Actor } from 'src/users/types';
import { formatJsonWithPrettier } from 'src/utils/json-formatter';

/** Repo ID for the workbook repo: same pattern as connector repos but uses workbookId twice. */
export function getWorkbookRepoPath(orgId: string, workbookId: WorkbookId): string {
  return `${orgId}/${workbookId}/${workbookId}`;
}

/** Portable sync config format stored in the workbook git repo (mirrors experimental v4 format). */
export interface WorkbookSyncConfig {
  version: 1;
  displayName: string;
  source: { connection: string; folder: string };
  destination: { connection: string; folder: string };
  fieldMappings: { sourceField: string; destField: string }[];
  recordMatching?: { sourceField: string; destField: string };
}

@Injectable()
export class WorkbookRepoService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitClient: ScratchGitClient,
  ) {}

  async initWorkbookRepo(orgId: string, workbookId: WorkbookId): Promise<void> {
    const repoId = getWorkbookRepoPath(orgId, workbookId);
    await this.scratchGitClient.initRepo(repoId);
  }

  async deleteWorkbookRepo(orgId: string, workbookId: WorkbookId): Promise<void> {
    const repoId = getWorkbookRepoPath(orgId, workbookId);
    // Best-effort delete — ignore if repo doesn't exist
    try {
      await this.scratchGitClient.deleteRepo(repoId);
    } catch {
      // ignore
    }
  }

  /**
   * Convert all syncs for a workbook to the portable v4 format and commit them to the
   * workbook repo at syncs/{slug}.json on the main branch.
   */
  async pushSyncs(orgId: string, workbookId: WorkbookId, actor: Actor): Promise<{ count: number }> {
    const workbook = await this.db.client.workbook.findUnique({ where: { id: workbookId } });
    if (!workbook) throw new NotFoundException('Workbook not found');

    // eslint-disable-next-line no-restricted-syntax -- TODO(DEV-10008): direct read; circular DI with SyncService prevents using the choke point method. Mappings parsed via parseStoredMappings below.
    const syncs = await this.db.client.sync.findMany({
      where: { workbookId },
      include: { syncTablePairs: true },
      orderBy: { createdAt: 'asc' },
    });

    if (syncs.length === 0) {
      return { count: 0 };
    }

    // Load all referenced data folders + connector accounts in one query
    const allDataFolderIds = syncs.flatMap((s) =>
      s.syncTablePairs.flatMap((p) => [p.sourceDataFolderId, p.destinationDataFolderId]),
    );
    const uniqueFolderIds = [...new Set(allDataFolderIds)];

    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { id: { in: uniqueFolderIds } },
      include: { connectorAccount: true },
    });
    const folderMap = new Map(dataFolders.map((df) => [df.id, df]));

    const files: { path: string; content: string }[] = [];

    for (const sync of syncs) {
      const stored = parseStoredMappings(sync);
      if (stored.mappings.version !== 1) {
        // WorkbookSyncConfig is the v1-shaped portable format. V2 export
        // support is future work — until then, v2 syncs are skipped from
        // the repo push and a warning is logged.
        continue;
      }
      const tableMappings: TableMappingV1[] = stored.mappings.tableMappings;

      for (let i = 0; i < tableMappings.length; i++) {
        const tm = tableMappings[i];
        const sourceDF = folderMap.get(tm.sourceDataFolderId);
        const destDF = folderMap.get(tm.destinationDataFolderId);

        if (!sourceDF || !destDF) continue;

        const sourceCA = sourceDF.connectorAccount;
        const destCA = destDF.connectorAccount;
        if (!sourceCA || !destCA) continue;

        const config: WorkbookSyncConfig = {
          version: 1,
          displayName: sync.displayName,
          source: {
            connection: `${sourceCA.service} - ${sourceCA.displayName}`,
            folder: (sourceDF.path ?? '').replace(/^\//, ''),
          },
          destination: {
            connection: `${destCA.service} - ${destCA.displayName}`,
            folder: (destDF.path ?? '').replace(/^\//, ''),
          },
          fieldMappings: tm.columnMappings.map((cm) => ({
            sourceField: cm.sourceColumnId,
            destField: cm.destinationColumnId,
          })),
          recordMatching: tm.recordMatching
            ? {
                sourceField: tm.recordMatching.sourceColumnId,
                destField: tm.recordMatching.destinationColumnId,
              }
            : undefined,
        };

        const slug = tableMappings.length > 1 ? `${toSlug(sync.displayName)}-${i + 1}` : toSlug(sync.displayName);

        files.push({
          path: `syncs/${slug}.json`,
          content: formatJsonWithPrettier(config as unknown as Record<string, unknown>),
        });
      }
    }

    if (files.length > 0) {
      const repoId = getWorkbookRepoPath(orgId, workbookId);
      await this.scratchGitClient.commitFiles(repoId, 'main', files, `Update syncs (${actor.userId})`);
    }

    return { count: files.length };
  }
}

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'sync'
  );
}
