import { TestConnectionResponse } from '@/types/server-entities/connector-accounts';
import { ConnectorAccount, CreateConnectorAccountDto, UpdateConnectorAccountDto } from '@spinner/shared-types';
import { TableList, TableSchemaPreview, TableSearchResult } from '../../types/server-entities/table-list';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const connectorAccountsApi = {
  list: async (workbookId: string): Promise<ConnectorAccount[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<ConnectorAccount[]>(`/workbooks/${workbookId}/connections`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch connections');
    }
  },

  // GET a single connection
  detail: async (workbookId: string, id: string): Promise<ConnectorAccount> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<ConnectorAccount>(`/workbooks/${workbookId}/connections/${id}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch connection');
    }
  },

  // POST a new connection
  create: async (workbookId: string, dto: CreateConnectorAccountDto): Promise<ConnectorAccount> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<ConnectorAccount>(`/workbooks/${workbookId}/connections`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create connection');
    }
  },

  // PATCH an existing connection
  update: async (workbookId: string, id: string, dto: UpdateConnectorAccountDto): Promise<ConnectorAccount> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<ConnectorAccount>(`/workbooks/${workbookId}/connections/${id}`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update connection');
    }
  },

  // DELETE a connection
  delete: async (workbookId: string, id: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbooks/${workbookId}/connections/${id}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete connection');
    }
  },

  // GET tables for a specific connection
  listTables: async (workbookId: string, connectorAccountId: string): Promise<TableList> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<TableList>(`/workbooks/${workbookId}/connections/${connectorAccountId}/tables`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list tables');
    }
  },

  // GET search tables for a specific connection
  searchTables: async (
    workbookId: string,
    connectorAccountId: string,
    searchTerm: string,
  ): Promise<TableSearchResult> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<TableSearchResult>(
        `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/search`,
        { params: { searchTerm } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to search tables');
    }
  },

  // GET table schema for a specific table
  getTableSchema: async (
    workbookId: string,
    connectorAccountId: string,
    tableRemoteId: string,
  ): Promise<TableSchemaPreview> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<TableSchemaPreview>(
        `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/schema`,
        { params: { tableRemoteId } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch table schema');
    }
  },

  // POST to test a connection
  test: async (workbookId: string, id: string): Promise<TestConnectionResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<TestConnectionResponse>(`/workbooks/${workbookId}/connections/${id}/test`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to test connection');
    }
  },

  // POST to reset a connection (deletes data folders and V2 git repo)
  reset: async (workbookId: string, id: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/workbooks/${workbookId}/connections/${id}/reset`);
    } catch (error) {
      handleAxiosError(error, 'Failed to reset connection');
      throw error;
    }
  },
};
