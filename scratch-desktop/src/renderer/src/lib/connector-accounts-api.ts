import type {
  ConnectorAccount,
  CreateConnectorAccountDto,
  TableList,
  TablePreview,
  TableSchemaPreview,
  TableSearchResult,
  TestConnectionResponse,
  UpdateConnectorAccountDto,
} from '@spinner/shared-types';
import { API_CONFIG } from './api';

// TablePreview, TableList, TableSearchResult, TableSchemaPreview, TestConnectionResponse
// are the shared contract — re-exported so existing importers keep working.
export type {
  TableList,
  TablePreview,
  TableSchemaPreview,
  TableSearchResult,
  TestConnectionResponse,
} from '@spinner/shared-types';

export function isTableFullyLocked(table: TablePreview | undefined): boolean {
  return Boolean(table?.disabledCreates && table?.disabledUpdates && table?.disabledDeletes);
}

export const connectorAccountsApi = {
  list: async (workbookId: string): Promise<ConnectorAccount[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<ConnectorAccount[]>(`/workbooks/${workbookId}/connections`);
    return res.data;
  },

  create: async (workbookId: string, dto: CreateConnectorAccountDto): Promise<ConnectorAccount> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<ConnectorAccount>(`/workbooks/${workbookId}/connections`, dto);
    return res.data;
  },

  update: async (workbookId: string, id: string, dto: UpdateConnectorAccountDto): Promise<ConnectorAccount> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.patch<ConnectorAccount>(`/workbooks/${workbookId}/connections/${id}`, dto);
    return res.data;
  },

  delete: async (workbookId: string, id: string): Promise<void> => {
    const axios = API_CONFIG.getAxiosInstance();
    await axios.delete(`/workbooks/${workbookId}/connections/${id}`);
  },

  listTables: async (workbookId: string, connectorAccountId: string): Promise<TableList> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<TableList>(`/workbooks/${workbookId}/connections/${connectorAccountId}/tables`);
    return res.data;
  },

  searchTables: async (
    workbookId: string,
    connectorAccountId: string,
    searchTerm: string,
  ): Promise<TableSearchResult> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<TableSearchResult>(
      `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/search`,
      { params: { searchTerm } },
    );
    return res.data;
  },

  getTableSchema: async (
    workbookId: string,
    connectorAccountId: string,
    tableRemoteId: string,
  ): Promise<TableSchemaPreview> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<TableSchemaPreview>(
      `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/schema`,
      { params: { tableRemoteId } },
    );
    return res.data;
  },

  test: async (workbookId: string, id: string): Promise<TestConnectionResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<TestConnectionResponse>(`/workbooks/${workbookId}/connections/${id}/test`);
    return res.data;
  },
};
