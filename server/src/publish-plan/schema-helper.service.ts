import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

// Define minimal interface if BaseJsonTableSpec is not easily available or to avoid circular deps,
// but better to import it if possible.
// It comes from '../remote-service/connectors/types' or similar.
// Let's use 'any' or imported type if I can find the import path.
// pipeline-run imports from types. Let me check pipeline-run imports.
import { Schema } from 'src/utils/objects';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';

@Injectable()
export class SchemaHelperService {
  constructor(private readonly db: DbService) {}

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
        select: { schema: true },
      });

      const spec = (dataFolder?.schema as unknown as BaseJsonTableSpec) || null;
      if (cache) {
        cache.set(folderPath, spec);
      }
      return spec;
    } catch (error) {
      console.error(`Error fetching table spec for folder: ${folderPath}`, error);
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
   * Look up the DataFolder for a given path and return its ID and TableSpec.
   */
  async getDataFolderInfo(
    workbookId: string,
    folderPath: string,
    cache?: Map<string, { id: string; spec: BaseJsonTableSpec } | null>,
  ): Promise<{ id: string; spec: BaseJsonTableSpec } | null> {
    if (cache && cache.has(folderPath)) {
      return cache.get(folderPath) ?? null;
    }

    try {
      const dataFolder = await this.db.client.dataFolder.findFirst({
        where: {
          workbookId,
          path: { in: [folderPath, `/${folderPath}`] },
        },
        select: { id: true, schema: true },
      });

      if (!dataFolder) {
        if (cache) {
          cache.set(folderPath, null);
        }
        return null;
      }

      const spec = (dataFolder.schema as unknown as BaseJsonTableSpec) || null;
      const result = { id: dataFolder.id, spec };
      if (cache) {
        cache.set(folderPath, result);
      }
      return result;
    } catch (error) {
      console.error(`Error fetching data folder info for: ${folderPath}`, error);
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
        select: { schema: true },
      });

      const spec = (dataFolder?.schema as unknown as BaseJsonTableSpec) || null;
      if (cache) {
        cache.set(dataFolderId, spec);
      }
      return spec;
    } catch (error) {
      console.error(`Error fetching table spec for dataFolderId: ${dataFolderId}`, error);
      if (cache) {
        cache.set(dataFolderId, null);
      }
      return null;
    }
  }
}
