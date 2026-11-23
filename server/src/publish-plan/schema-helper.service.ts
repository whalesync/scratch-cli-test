import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

import { WSLogger } from 'src/logger';
import { Schema } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, dotPath } from '../remote-service/connectors/types';
import { EncryptedData } from '../utils/encryption';
import { DataFolderTableSpecStoreService } from '../workbook/table-spec-store/data-folder-table-spec-store.service';
import { readTableSpecOrNullLoggingFailure, type TableSpecStore } from '../workbook/table-spec-store/table-spec-store';

@Injectable()
export class SchemaHelperService {
  constructor(
    private readonly db: DbService,
    /** The default table spec store: the folder's stored spec (DEV-12616), unless a caller supplies its own. */
    private readonly dataFolderTableSpecStore: DataFolderTableSpecStoreService,
    private readonly connectorsService: ConnectorsService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  /**
   * Reads a folder's table spec from `tableSpecStore` (the stored copy unless the caller supplies its own
   * store); null when there is none or it can't be read.
   */
  private readTableSpecOrNull(
    workbookId: string,
    dataFolder: { id: string; connectorAccountId: string | null; path: string | null } | null,
    tableSpecStore: TableSpecStore,
  ): Promise<BaseJsonTableSpec | null> {
    if (!dataFolder) return Promise.resolve(null);
    return readTableSpecOrNullLoggingFailure(
      tableSpecStore,
      { dataFolderId: dataFolder.id, connectorAccountId: dataFolder.connectorAccountId, folderPath: dataFolder.path },
      { source: 'SchemaHelperService.readTableSpecOrNull', workbookId },
    );
  }

  /**
   * Look up the DataFolder for a given path and return its TableSpec.
   * Handles the folder path normalization (checking both `path` and `/path`).
   */
  async getTableSpec(
    workbookId: string,
    folderPath: string,
    cache?: Map<string, BaseJsonTableSpec | null>,
    tableSpecStore: TableSpecStore = this.dataFolderTableSpecStore,
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
        select: { id: true, connectorAccountId: true, path: true },
      });

      const spec = await this.readTableSpecOrNull(workbookId, dataFolder, tableSpecStore);
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
    connectorAccountId?: string | null,
  ): Promise<{ id: string; tableId: string[]; spec: BaseJsonTableSpec } | null> {
    // A workbook can have two connections with folders of the same path (e.g.
    // both a CRM and a generic-api connection expose a "/Contacts" table). The
    // lookup MUST be scoped to the connection, or `findFirst` returns the wrong
    // folder — handing one connector another connector's schema, which then
    // mis-routes writes (e.g. a HighLevel contact create dispatched to the
    // generic-api table id, yielding `POST /objects/GET/records` → 400). Scope
    // both the query and the cache key by connectorAccountId when it's known.
    const cacheKey = `${connectorAccountId ?? ''}::${folderPath}`;
    if (cache && cache.has(cacheKey)) {
      return cache.get(cacheKey) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findFirst({
        where: {
          workbookId,
          path: { in: [folderPath, `/${folderPath}`] },
          ...(connectorAccountId ? { connectorAccountId } : {}),
        },
        select: { id: true, tableId: true, connectorAccountId: true, path: true },
      });

      if (!dataFolder) {
        if (cache) {
          cache.set(cacheKey, null);
        }
        return null;
      }

      const spec = await this.readTableSpecOrNull(workbookId, dataFolder, this.dataFolderTableSpecStore);
      if (!spec) {
        if (cache) {
          cache.set(cacheKey, null);
        }
        return null;
      }
      const result = { id: dataFolder.id, tableId: dataFolder.tableId, spec };
      if (cache) {
        cache.set(cacheKey, result);
      }
      return result;
    } catch (error) {
      WSLogger.error({
        source: 'SchemaHelperService.getDataFolderInfo',
        message: `Error fetching data folder info for: ${folderPath}`,
        error,
      });
      if (cache) {
        cache.set(cacheKey, null);
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
    tableSpecStore: TableSpecStore = this.dataFolderTableSpecStore,
  ): Promise<BaseJsonTableSpec | null> {
    if (cache && cache.has(dataFolderId)) {
      return cache.get(dataFolderId) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findUnique({
        where: { id: dataFolderId },
        select: { id: true, connectorAccountId: true, path: true, workbookId: true },
      });

      const spec = await this.readTableSpecOrNull(dataFolder?.workbookId ?? '', dataFolder, tableSpecStore);
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
   * Fetches fresh schema via the connector and stores it (Postgres, mirrored to git — DEV-12616).
   * Follows the same pattern used in the pull job (pull-linked-folder-files.job.ts).
   */
  async refreshSchemasForConnection(workbookId: string, connectorAccountId: string): Promise<void> {
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
          tableSpec.idPath = dotPath(idOverride);
        }
        if (Array.isArray(nameOverride) && nameOverride.length > 0) {
          tableSpec.titlePath = dotPath(nameOverride.join('.'));
        }

        // The user's idFieldOverride resolves a spec whose own idPath is
        // untrustworthy (see BaseJsonTableSpec.idPathRequiresUserSelection).
        // Marker with no override means the source lost its unique column since
        // the folder was created — throw (caught below, logged per folder)
        // instead of writing a schema addressed by the legacy fallback.
        if (tableSpec.idPathRequiresUserSelection) {
          if (typeof idOverride !== 'string') {
            throw new Error(
              `Folder "${folder.path}" requires an ID field override but none is configured; skipping schema refresh.`,
            );
          }
          delete tableSpec.idPathRequiresUserSelection;
        }

        // Store the refreshed schema and default view. The view is rebuilt from
        // the (override-adjusted) spec via the connector — a pure spec→view stage.
        const tableSpecLocation = { dataFolderId: folder.id, connectorAccountId, folderPath: folder.path };
        await this.dataFolderTableSpecStore.writeTableSpec(tableSpecLocation, tableSpec, 'publish-plan-build');
        const defaultView = connector.buildDefaultView(tableSpec);
        if (defaultView) {
          await this.dataFolderTableSpecStore.writeDefaultView(tableSpecLocation, defaultView, 'publish-plan-build');
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
