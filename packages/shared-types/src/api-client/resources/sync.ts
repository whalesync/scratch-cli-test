import type { Sync } from '../../db/sync';
import type { RunSyncResponse } from '../../dto/sync/run-sync.dto';
import type {
  AiContextResponse,
  MappingTypeTraceResponse,
  PreviewRecordResponse,
  SaveSyncBody,
  SyncOneRecordResponse,
  ValidateMappingTypeBody,
  ValidateSyncMappingTypesResponse,
} from '../../dto/sync/sync-api';
import type { WhalesyncImportPreviewBody, WhalesyncImportPreviewResponse } from '../../dto/sync/whalesync-import-api';
import type { TestTransformerDto, TestTransformerResponse } from '../../dto/transformer/test-transformer.dto';
import type { ColumnMapping } from '../../sync-mapping';
import type { Http } from '../http';

/**
 * Sync operations for a workspace: create/update/list/delete syncs, run them, preview records,
 * and the admin type-validation surface. Reached as `client.sync.*`.
 */
export function createSyncApi(http: Http) {
  return {
    create: async (workbookId: string, body: SaveSyncBody): Promise<Sync> => {
      const res = await http.post<Sync>(`/workbooks/${workbookId}/syncs`, body, {
        fallbackMessage: 'Failed to create sync',
      });
      return res.data;
    },

    update: async (workbookId: string, syncId: string, body: SaveSyncBody): Promise<unknown> => {
      const res = await http.patch(`/workbooks/${workbookId}/syncs/${syncId}`, body, {
        fallbackMessage: 'Failed to update sync',
      });
      return res.data;
    },

    list: async (workbookId: string): Promise<Sync[]> => {
      const res = await http.get<Sync[]>(`/workbooks/${workbookId}/syncs`, {
        fallbackMessage: 'Failed to list syncs',
      });
      return res.data;
    },

    run: async (workbookId: string, syncId: string): Promise<RunSyncResponse> => {
      const res = await http.post<RunSyncResponse>(`/workbooks/${workbookId}/syncs/${syncId}/run`, undefined, {
        fallbackMessage: 'Failed to run sync',
      });
      return res.data;
    },

    previewRecord: async (
      workbookId: string,
      sourceFolderId: string,
      destFolderId: string,
      filePath: string,
      columnMappings: ColumnMapping[],
      recordMatching?: { sourceColumnId: string; destinationColumnId: string },
    ): Promise<PreviewRecordResponse> => {
      const res = await http.post<PreviewRecordResponse>(
        `/workbooks/${workbookId}/syncs/preview-record`,
        {
          sourceFolderId,
          destFolderId,
          filePath,
          columnMappings,
          ...(recordMatching ? { recordMatching } : {}),
        },
        { fallbackMessage: 'Failed to preview record' },
      );
      return res.data;
    },

    getAiContext: async (workbookId: string): Promise<AiContextResponse> => {
      const res = await http.get<AiContextResponse>(`/workbooks/${workbookId}/syncs/ai-context`, {
        fallbackMessage: 'Failed to get AI context',
      });
      return res.data;
    },

    importPreview: async (
      workbookId: string,
      body: WhalesyncImportPreviewBody,
    ): Promise<WhalesyncImportPreviewResponse> => {
      const res = await http.post<WhalesyncImportPreviewResponse>(
        `/workbooks/${workbookId}/syncs/import-preview`,
        body,
        { fallbackMessage: 'Failed to preview Whalesync import' },
      );
      return res.data;
    },

    syncOneRecord: async (
      workbookId: string,
      syncId: string,
      sourceFilePath: string,
      sourceDataFolderId: string,
    ): Promise<SyncOneRecordResponse> => {
      const res = await http.post<SyncOneRecordResponse>(
        `/workbooks/${workbookId}/syncs/${syncId}/sync-one-record`,
        {
          sourceFilePath,
          sourceDataFolderId,
        },
        { fallbackMessage: 'Failed to sync record' },
      );
      return res.data;
    },

    delete: async (workbookId: string, syncId: string): Promise<void> => {
      await http.delete(`/workbooks/${workbookId}/syncs/${syncId}`, { fallbackMessage: 'Failed to delete sync' });
    },

    /** Admin only: trace type through a single mapping's transformer pipeline. */
    validateMappingType: async (
      workbookId: string,
      body: ValidateMappingTypeBody,
    ): Promise<MappingTypeTraceResponse | { error: string }> => {
      const res = await http.post<MappingTypeTraceResponse | { error: string }>(
        `/workbooks/${workbookId}/syncs/validate-mapping-type`,
        body,
        { fallbackMessage: 'Failed to validate mapping type' },
      );
      return res.data;
    },

    /** Run type validation for all field mappings in a sync; returns error report. */
    validateSyncMappingTypes: async (workbookId: string, syncId: string): Promise<ValidateSyncMappingTypesResponse> => {
      const res = await http.get<ValidateSyncMappingTypesResponse>(
        `/workbooks/${workbookId}/syncs/${syncId}/validate-mapping-types`,
      );
      return res.data;
    },

    /** POST `/sync/transformers/test` — run a transformer against sample input and return the result. */
    testTransformer: async (workbookId: string, dto: TestTransformerDto): Promise<TestTransformerResponse> => {
      const res = await http.post<TestTransformerResponse>('/sync/transformers/test', dto, {
        fallbackMessage: 'Failed to test transformer',
      });
      return res.data;
    },

    /**
     * @deprecated Legacy/manual helper. Normal sync create/update/delete flows already initialize the
     * workbook config repo and push the current sync definitions automatically on the server.
     *
     * POST `/cli/v1/workbooks/:id/config/init` then `/cli/v1/workbooks/:id/config/push-syncs`.
     */
    pushSyncsToGit: async (workbookId: string): Promise<{ count: number }> => {
      await http.post(`/cli/v1/workbooks/${workbookId}/config/init`, undefined, {
        fallbackMessage: 'Failed to push syncs to git',
      });
      const res = await http.post<{ count: number }>(`/cli/v1/workbooks/${workbookId}/config/push-syncs`, undefined, {
        fallbackMessage: 'Failed to push syncs to git',
      });
      return res.data;
    },
  };
}

export type SyncApi = ReturnType<typeof createSyncApi>;
