import { Injectable } from '@nestjs/common';
import { Service } from 'src/types/shared-types';
import * as path from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { ScratchGitClient } from 'src/scratch-git/scratch-git.client';
import { JobHandlerBuilder } from 'src/worker/jobs/base-types';
import { PollJobDefinition } from 'src/worker/jobs/job-definitions/poll.job';

@Injectable()
export class PollJob implements JobHandlerBuilder<PollJobDefinition> {
  constructor(
    private readonly db: DbService,
    private readonly connectorsService: ConnectorsService,
    private readonly scratchGit: ScratchGitClient,
    private readonly config: ScratchConfigService,
  ) {}

  async run(params: Parameters<JobHandlerBuilder<PollJobDefinition>['run']>[0]) {
    const start = Date.now();
    const { data, checkpoint } = params;
    const { workbookId, connectorAccountId } = data;

    WSLogger.info({ source: 'PollJob', message: 'Starting poll', workbookId, connectorAccountId });

    const connectorAccount = await this.db.client.connectorAccount.findUniqueOrThrow({
      where: { id: connectorAccountId },
    });

    const service = connectorAccount.service as Service;
    const apiKey = this.resolveApiKey(service);

    const connector = await this.connectorsService.getConnector({ service, connectorAccount, apiKey });
    const allTables = await connector.listTables();
    const tableIdFilter =
      service === Service.AIRTABLE ? this.config.getAirtableTableIds() :
      service === Service.WEBFLOW ? this.config.getWebflowCollectionIds() :
      undefined;
    const tables = tableIdFilter
      ? allTables.filter((t) => t.id.remoteId.some((id) => tableIdFilter.includes(id)))
      : allTables;
    WSLogger.info({ source: 'PollJob', message: 'Tables to poll', service, total: allTables.length, filtered: tables.length, names: tables.map((t) => t.displayName) });
    let totalFiles = 0;

    for (const table of tables) {
      const tableSpec = await connector.fetchJsonTableSpec(table.id);
      const repoPath = connectorAccount.repoPath ?? this.buildRepoPath(workbookId, connectorAccountId);

      // Build folder path: /<basePath...>/<tableName>  e.g. /MyBase/Table 1
      const folderParts = [...(tableSpec.basePath ?? []), tableSpec.name];
      const folder = '/' + folderParts.join('/');

      // Write schema to .scratch/<basePath...>/<tableName>/schema.json
      await this.scratchGit.upsertFiles({
        repoPath,
        folder: '.scratch/' + folderParts.join('/'),
        message: `schema: ${tableSpec.name}`,
        files: [{ path: 'schema.json', content: JSON.stringify(tableSpec.schema, null, 2) }],
      });

      await connector.pullRecordFiles(
        tableSpec,
        async ({ files }) => {
          if (files.length === 0) return;

          await this.scratchGit.upsertFiles({
            repoPath,
            folder,
            message: `poll: ${tableSpec.name}`,
            files: files.map((f) => {
              const record = f.fields ?? f;
              let filename = String(f.id);
              if (tableSpec.slugColumnRemoteId) {
                const slugValue = tableSpec.slugColumnRemoteId.split('.').reduce<unknown>((obj, key) => {
                  return obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
                }, record);
                if (typeof slugValue === 'string' && slugValue.length > 0) {
                  filename = slugValue;
                }
              }
              return { path: `${filename}.json`, content: JSON.stringify(record, null, 2) };
            }),
          });

          totalFiles += files.length;
          try {
            await checkpoint({ publicProgress: { filesProcessed: totalFiles }, jobProgress: {}, connectorProgress: {} });
          } catch {
            // checkpoint is non-critical for the experiment
          }
        },
        {} as never,
        {},
      );
    }

    // Rebase dirty onto master (FF for now; will become JSON-aware rebase later)
    const repoPath = connectorAccount.repoPath ?? this.buildRepoPath(workbookId, connectorAccountId);
    const rebase = await this.scratchGit.rebaseDirty(repoPath);
    WSLogger.info({ source: 'PollJob', message: 'Poll complete', workbookId, totalFiles, rebaseAdvanced: rebase.advanced });
    return { success: true, result: totalFiles, executionTime: Date.now() - start };
  }

  private resolveApiKey(service: Service): string {
    if (service === Service.AIRTABLE) return this.config.getAirtableApiKey();
    if (service === Service.WEBFLOW) return this.config.getWebflowApiKey();
    throw new Error(`No API key configured for service: ${service}`);
  }

  private buildRepoPath(workbookId: string, connectorAccountId: string): string {
    return path.join(this.config.getGitReposDir(), 'default', workbookId, connectorAccountId, 'repo.git');
  }
}
