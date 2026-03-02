import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from '../db/db.service';

import { WSLogger } from 'src/logger';
import { Schema } from 'src/utils/objects';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { ScratchGitService } from '../scratch-git/scratch-git.service';

@Injectable()
export class SchemaHelperService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
  ) {}

  /**
   * Reads schema from git first, falling back to the DB value.
   */
  private async readSchemaWithFallback(
    workbookId: string,
    connectorAccountId: string | null,
    folderPath: string | null,
    dbSchema: unknown,
  ): Promise<BaseJsonTableSpec | null> {
    if (folderPath) {
      try {
        const repoId = await this.scratchGitService.resolveRepoId(
          workbookId as WorkbookId,
          connectorAccountId ?? undefined,
        );
        const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
        if (gitSchema) return gitSchema;
      } catch (error) {
        WSLogger.error({
          source: 'SchemaHelperService.readSchemaWithFallback',
          message: 'Failed to read schema from git, falling back to DB',
          error,
          workbookId,
          folderPath,
        });
      }
    }
    // Fallback to DB schema
    return (dbSchema as BaseJsonTableSpec) || null;
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
        select: { schema: true, connectorAccountId: true, path: true },
      });

      const spec = await this.readSchemaWithFallback(
        workbookId,
        dataFolder?.connectorAccountId ?? null,
        dataFolder?.path ?? null,
        dataFolder?.schema,
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
        select: { id: true, tableId: true, schema: true, connectorAccountId: true, path: true },
      });

      if (!dataFolder) {
        if (cache) {
          cache.set(folderPath, null);
        }
        return null;
      }

      const spec = await this.readSchemaWithFallback(
        workbookId,
        dataFolder.connectorAccountId,
        dataFolder.path,
        dataFolder.schema,
      );
      const result = { id: dataFolder.id, tableId: dataFolder.tableId, spec: spec! };
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
        select: { schema: true, connectorAccountId: true, path: true, workbookId: true },
      });

      const spec = await this.readSchemaWithFallback(
        dataFolder?.workbookId ?? '',
        dataFolder?.connectorAccountId ?? null,
        dataFolder?.path ?? null,
        dataFolder?.schema,
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
}
