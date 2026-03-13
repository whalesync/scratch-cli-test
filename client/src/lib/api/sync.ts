import {
  AiContextResponse,
  ColumnMapping,
  DataFolderId,
  MappingTypeTraceResponse,
  PreviewRecordResponse,
  SaveSyncBody,
  Sync,
  SyncId,
  ValidateMappingTypeBody,
  WhalesyncImportPreviewBody,
  WhalesyncImportPreviewResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

interface RunSyncResponse {
  success: boolean;
  jobId: string;
  message: string;
}

export const syncApi = {
  create: async (workbookId: WorkbookId, body: SaveSyncBody): Promise<Sync> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Sync>(`/workbooks/${workbookId}/syncs`, body);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create sync');
    }
  },

  update: async (workbookId: WorkbookId, syncId: SyncId, body: SaveSyncBody): Promise<unknown> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch(`/workbooks/${workbookId}/syncs/${syncId}`, body);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update sync');
    }
  },

  list: async (workbookId: WorkbookId): Promise<Sync[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Sync[]>(`/workbooks/${workbookId}/syncs`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list syncs');
      return [];
    }
  },

  run: async (workbookId: WorkbookId, syncId: SyncId): Promise<RunSyncResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<RunSyncResponse>(`/workbooks/${workbookId}/syncs/${syncId}/run`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to run sync');
    }
  },
  previewRecord: async (
    workbookId: WorkbookId,
    sourceFolderId: DataFolderId,
    destFolderId: DataFolderId,
    filePath: string,
    columnMappings: ColumnMapping[],
    recordMatching?: { sourceColumnId: string; destinationColumnId: string },
  ): Promise<PreviewRecordResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<PreviewRecordResponse>(`/workbooks/${workbookId}/syncs/preview-record`, {
        sourceFolderId,
        destFolderId,
        filePath,
        columnMappings,
        ...(recordMatching ? { recordMatching } : {}),
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to preview record');
    }
  },

  getAiContext: async (workbookId: WorkbookId): Promise<AiContextResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<AiContextResponse>(`/workbooks/${workbookId}/syncs/ai-context`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get AI context');
    }
  },

  importPreview: async (
    workbookId: WorkbookId,
    body: WhalesyncImportPreviewBody,
  ): Promise<WhalesyncImportPreviewResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<WhalesyncImportPreviewResponse>(
        `/workbooks/${workbookId}/syncs/import-preview`,
        body,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to preview Whalesync import');
    }
  },

  delete: async (workbookId: WorkbookId, syncId: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbooks/${workbookId}/syncs/${syncId}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete sync');
      throw error;
    }
  },

  /** Admin only: trace type through a single mapping's transformer pipeline. */
  validateMappingType: async (
    workbookId: WorkbookId,
    body: ValidateMappingTypeBody,
  ): Promise<MappingTypeTraceResponse | { error: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<MappingTypeTraceResponse | { error: string }>(
        `/workbooks/${workbookId}/syncs/validate-mapping-type`,
        body,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to validate mapping type');
      return { error: 'Request failed' };
    }
  },
};
