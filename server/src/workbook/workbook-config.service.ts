import { Injectable, NotFoundException } from '@nestjs/common';
import { SyncMapping, TableMapping, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ScratchGitClient } from 'src/scratch-git/scratch-git.client';
import { Actor } from 'src/users/types';

/** Repo ID for the workbook config repo: same pattern as connector repos but uses workbookId twice. */
export function getConfigRepoId(orgId: string, workbookId: WorkbookId): string {
  return `${orgId}/${workbookId}/${workbookId}`;
}

/** Portable sync config format stored in the workbook config git repo (mirrors experimental v4 format). */
export interface WorkbookSyncConfig {
  version: 1;
  displayName: string;
  source: { connection: string; folder: string };
  destination: { connection: string; folder: string };
  fieldMappings: { sourceField: string; destField: string }[];
  recordMatching?: { sourceField: string; destField: string };
}

@Injectable()
export class WorkbookConfigService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitClient: ScratchGitClient,
  ) {}

  async initConfigRepo(orgId: string, workbookId: WorkbookId): Promise<void> {
    const repoId = getConfigRepoId(orgId, workbookId);
    await this.scratchGitClient.initRepo(repoId);
  }

  async deleteConfigRepo(orgId: string, workbookId: WorkbookId): Promise<void> {
    const repoId = getConfigRepoId(orgId, workbookId);
    // Best-effort delete — ignore if repo doesn't exist
    try {
      await this.scratchGitClient.deleteRepo(repoId);
    } catch {
      // ignore
    }
  }

  /**
   * Convert all syncs for a workbook to the portable v4 format and commit them to the
   * workbook config repo at syncs/{slug}.json on the main branch.
   */
  async pushSyncs(orgId: string, workbookId: WorkbookId, actor: Actor): Promise<{ count: number }> {
    const workbook = await this.db.client.workbook.findUnique({ where: { id: workbookId } });
    if (!workbook) throw new NotFoundException('Workbook not found');

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
      const mappings = sync.mappings as unknown as SyncMapping;
      const tableMappings: TableMapping[] = mappings?.tableMappings ?? [];

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

        files.push({ path: `syncs/${slug}.json`, content: JSON.stringify(config, null, 2) });
      }
    }

    if (files.length > 0) {
      const repoId = getConfigRepoId(orgId, workbookId);
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
