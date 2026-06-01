import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

import { WSLogger } from 'src/logger';
import { Schema } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, idPath } from '../remote-service/connectors/types';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';

@Injectable()
export class SchemaHelperService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly connectorsService: ConnectorsService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  /**
   * Reads schema from git.
   */
  private async readSchemaFromGit(
    workbookId: string,
    connectorAccountId: string | null,
    folderPath: string | null,
  ): Promise<BaseJsonTableSpec | null> {
    if (folderPath) {
      try {
        const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId ?? undefined);
        const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
        if (gitSchema) return gitSchema;
      } catch (error) {
        WSLogger.error({
          source: 'SchemaHelperService.readSchemaFromGit',
          message: 'Failed to read schema from git',
          error,
          workbookId,
          folderPath,
        });
      }
    }
    return null;
  }

  /**
   * Look up the DataFolder for a given path and return its TableSpec.
   * Handles the folder path normalization (checking both `path` and `/path`).
   */
  async getTableSpec(
    workbookId: string,
    folderPath: string,
    cache?: Map<string, BaseJsonTableSpec | null>,
  ): Promise<BaseJsonTableSpec | null> {
    if (cache && cache.has(folderPath)) {
      return cache.get(folderPath) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findFirst({
        where: {
          workbookId,
          path: { in: [folderPath, `/${folderPath}`] },
        },
        select: { connectorAccountId: true, path: true },
      });

      const spec = await this.readSchemaFromGit(
        workbookId,
        dataFolder?.connectorAccountId ?? null,
        dataFolder?.path ?? null,
      );
      if (cache) {
        cache.set(folderPath, spec);
      }
      return spec;
    } catch (error) {
      WSLogger.error({
        source: 'SchemaHelperService.getTableSpec',
        message: `Error fetching table spec for folder: ${folderPath}`,
        error,
      });
      if (cache) {
        cache.set(folderPath, null);
      }
      return null;
    }
  }

  /**
   * Helper to get just the inner JSON schema (for ref cleaning, etc.)
   */
  async getJsonSchema(
    workbookId: string,
    folderPath: string,
    cache?: Map<string, BaseJsonTableSpec | null>,
  ): Promise<Schema | null> {
    const spec = await this.getTableSpec(workbookId, folderPath, cache);
    return spec?.schema ?? null;
  }

  /**
   * Look up the DataFolder for a given path and return its ID, tableId, and TableSpec.
   */
  async getDataFolderInfo(
    workbookId: string,
    folderPath: string,
    cache?: Map<string, { id: string; tableId: string[]; spec: BaseJsonTableSpec } | null>,
  ): Promise<{ id: string; tableId: string[]; spec: BaseJsonTableSpec } | null> {
    if (cache && cache.has(folderPath)) {
      return cache.get(folderPath) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findFirst({
        where: {
          workbookId,
          path: { in: [folderPath, `/${folderPath}`] },
        },
        select: { id: true, tableId: true, connectorAccountId: true, path: true },
      });

      if (!dataFolder) {
        if (cache) {
          cache.set(folderPath, null);
        }
        return null;
      }

      const spec = await this.readSchemaFromGit(workbookId, dataFolder.connectorAccountId, dataFolder.path);
      if (!spec) {
        if (cache) {
          cache.set(folderPath, null);
        }
        return null;
      }
      const result = { id: dataFolder.id, tableId: dataFolder.tableId, spec };
      if (cache) {
        cache.set(folderPath, result);
      }
      return result;
    } catch (error) {
      WSLogger.error({
        source: 'SchemaHelperService.getDataFolderInfo',
        message: `Error fetching data folder info for: ${folderPath}`,
        error,
      });
      if (cache) {
        cache.set(folderPath, null);
      }
      return null;
    }
  }
  /**
   * Look up the TableSpec for a given DataFolder ID.
   */
  async getTableSpecById(
    dataFolderId: string,
    cache?: Map<string, BaseJsonTableSpec | null>,
  ): Promise<BaseJsonTableSpec | null> {
    if (cache && cache.has(dataFolderId)) {
      return cache.get(dataFolderId) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findUnique({
        where: { id: dataFolderId },
        select: { connectorAccountId: true, path: true, workbookId: true },
      });

      const spec = await this.readSchemaFromGit(
        dataFolder?.workbookId ?? '',
        dataFolder?.connectorAccountId ?? null,
        dataFolder?.path ?? null,
      );
      if (cache) {
        cache.set(dataFolderId, spec);
      }
      return spec;
    } catch (error) {
      WSLogger.error({
        source: 'SchemaHelperService.getTableSpecById',
        message: `Error fetching table spec for dataFolderId: ${dataFolderId}`,
        error,
      });
      if (cache) {
        cache.set(dataFolderId, null);
      }
      return null;
    }
  }

  /**
   * Refreshes schemas from the remote connector for all data folders belonging to a connection.
   * Fetches fresh schema via the connector and writes to git.
   * Follows the same pattern used in the pull job (pull-linked-folder-files.job.ts).
   */
  async refreshSchemasForConnection(workbookId: string, connectorAccountId: string, repoId: string): Promise<void> {
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId },
      select: {
        id: true,
        path: true,
        tableId: true,
        connectorService: true,
        options: true,
        connectorAccount: true,
      },
    });

    if (dataFolders.length === 0) return;

    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
    });
    if (!account) {
      WSLogger.warn({
        source: 'SchemaHelperService.refreshSchemasForConnection',
        message: `ConnectorAccount not found: ${connectorAccountId}`,
        workbookId,
      });
      return;
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

    const connector = await this.connectorsService.getConnector({
      service: account.service,
      connectorAccount: account,
      decryptedCredentials,
    });

    for (const folder of dataFolders) {
      if (!folder.tableId || folder.tableId.length === 0 || !folder.path) continue;

      try {
        const tableSpec = await connector.fetchJsonTableSpec({
          wsId: folder.tableId[0],
          remoteId: folder.tableId,
        });

        // Re-apply user field overrides from options
        const options =
          folder.options && typeof folder.options === 'object' && !Array.isArray(folder.options) ? folder.options : {};
        const idOverride =
          'idFieldOverride' in options ? (options as Record<string, unknown>).idFieldOverride : undefined;
        const nameOverride =
          'nameFieldOverride' in options ? (options as Record<string, unknown>).nameFieldOverride : undefined;
        if (typeof idOverride === 'string') {
          tableSpec.idColumnRemoteId = idPath(idOverride);
        }
        if (Array.isArray(nameOverride) && nameOverride.length > 0) {
          tableSpec.titleColumnRemoteId = nameOverride;
        }

        // Write refreshed schema and default view to git
        await this.scratchGitService.writeSchemaToGit(repoId, folder.path, tableSpec);
        if (tableSpec.defaultView) {
          await this.scratchGitService.writeViewToGit(repoId, folder.path, 'default', tableSpec.defaultView);
        }

        WSLogger.info({
          source: 'SchemaHelperService.refreshSchemasForConnection',
          message: `Refreshed schema for folder ${folder.path}`,
          workbookId,
          dataFolderId: folder.id,
        });
      } catch (error) {
        WSLogger.error({
          source: 'SchemaHelperService.refreshSchemasForConnection',
          message: `Failed to refresh schema for folder ${folder.path}`,
          error,
          workbookId,
          dataFolderId: folder.id,
        });
        // Continue with other folders — don't fail the entire publish for one schema refresh failure
      }
    }
  }
}
