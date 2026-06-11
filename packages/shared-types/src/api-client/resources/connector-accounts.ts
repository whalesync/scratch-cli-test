import type {
  CreateDestinationList,
  TableList,
  TableSchemaPreview,
  TableSearchResult,
} from '../../connector/table-list';
import type { ConnectorAccount } from '../../db';
import type {
  ApiQuotaResponse,
  RevealCredentialsResponse,
  TestConnectionResponse,
} from '../../dto/connector-account/connection-responses.dto';
import type { CreateConnectorAccountDto } from '../../dto/connector-account/create-connector-account.dto';
import type { UpdateConnectorAccountDto } from '../../dto/connector-account/update-connector-account.dto';
import type { Http } from '../http';

/**
 * Connector-account (a.k.a. "connection") CRUD and table-introspection surface for a workbook,
 * rooted at `/workbooks/:id/connections/*`. Reached as `client.connectorAccounts.*`.
 *
 * WEB vs DESKTOP: the web client (`connector-accounts.ts`) and the desktop app
 * (`connector-accounts-api.ts`) call the SAME routes/bodies/returns for every method the desktop
 * has. The desktop module exposes only a subset — `list`, `create`, `update`, `delete`,
 * `listTables`, `searchTables`, `getTableSchema`, `test` — so `detail`, `getQuota`, `reset`, and
 * `revealCredentials` below are WEB-ONLY. No method diverges in route/body/return, so each is a
 * single shared method. (The desktop module also ships a pure `isTableFullyLocked` UI helper that
 * is not an HTTP call — it stays app-local and is not ported here.)
 */
export function createConnectorAccountsApi(http: Http) {
  return {
    /** GET `/workbooks/:id/connections` — list a workbook's connections. (web + desktop) */
    list: async (workbookId: string): Promise<ConnectorAccount[]> => {
      const res = await http.get<ConnectorAccount[]>(`/workbooks/${workbookId}/connections`, {
        fallbackMessage: 'Failed to fetch connections',
      });
      return res.data;
    },

    /** GET `/workbooks/:id/connections/:id` — fetch a single connection. (web-only) */
    detail: async (workbookId: string, id: string): Promise<ConnectorAccount> => {
      const res = await http.get<ConnectorAccount>(`/workbooks/${workbookId}/connections/${id}`, {
        fallbackMessage: 'Failed to fetch connection',
      });
      return res.data;
    },

    /** POST `/workbooks/:id/connections` — create a connection. (web + desktop) */
    create: async (workbookId: string, dto: CreateConnectorAccountDto): Promise<ConnectorAccount> => {
      const res = await http.post<ConnectorAccount>(`/workbooks/${workbookId}/connections`, dto, {
        fallbackMessage: 'Failed to create connection',
      });
      return res.data;
    },

    /** PATCH `/workbooks/:id/connections/:id` — update a connection. (web + desktop) */
    update: async (workbookId: string, id: string, dto: UpdateConnectorAccountDto): Promise<ConnectorAccount> => {
      const res = await http.patch<ConnectorAccount>(`/workbooks/${workbookId}/connections/${id}`, dto, {
        fallbackMessage: 'Failed to update connection',
      });
      return res.data;
    },

    /** DELETE `/workbooks/:id/connections/:id` — delete a connection. (web + desktop) */
    delete: async (workbookId: string, id: string): Promise<void> => {
      await http.delete(`/workbooks/${workbookId}/connections/${id}`, {
        fallbackMessage: 'Failed to delete connection',
      });
    },

    /** GET `/workbooks/:id/connections/:connectionId/tables` — list tables for a connection. (web + desktop) */
    listTables: async (workbookId: string, connectorAccountId: string): Promise<TableList> => {
      const res = await http.get<TableList>(`/workbooks/${workbookId}/connections/${connectorAccountId}/tables`, {
        fallbackMessage: 'Failed to list tables',
      });
      return res.data;
    },

    /** GET `/workbooks/:id/connections/:connectionId/create-destinations` — list where a new table can be created. (web + desktop) */
    listCreateDestinations: async (
      workbookId: string,
      connectorAccountId: string,
    ): Promise<CreateDestinationList> => {
      const res = await http.get<CreateDestinationList>(
        `/workbooks/${workbookId}/connections/${connectorAccountId}/create-destinations`,
        { fallbackMessage: 'Failed to list create destinations' },
      );
      return res.data;
    },

    /** GET `/workbooks/:id/connections/:connectionId/tables/search` — search tables. (web + desktop) */
    searchTables: async (
      workbookId: string,
      connectorAccountId: string,
      searchTerm: string,
    ): Promise<TableSearchResult> => {
      const res = await http.get<TableSearchResult>(
        `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/search`,
        { params: { searchTerm }, fallbackMessage: 'Failed to search tables' },
      );
      return res.data;
    },

    /** GET `/workbooks/:id/connections/:connectionId/tables/schema` — fetch a table's schema preview. (web + desktop) */
    getTableSchema: async (
      workbookId: string,
      connectorAccountId: string,
      tableRemoteId: string,
    ): Promise<TableSchemaPreview> => {
      const res = await http.get<TableSchemaPreview>(
        `/workbooks/${workbookId}/connections/${connectorAccountId}/tables/schema`,
        { params: { tableRemoteId }, fallbackMessage: 'Failed to fetch table schema' },
      );
      return res.data;
    },

    /** POST `/workbooks/:id/connections/:id/test` — test a connection's credentials. (web + desktop) */
    test: async (workbookId: string, id: string): Promise<TestConnectionResponse> => {
      const res = await http.post<TestConnectionResponse>(
        `/workbooks/${workbookId}/connections/${id}/test`,
        undefined,
        {
          fallbackMessage: 'Failed to test connection',
        },
      );
      return res.data;
    },

    /** GET `/workbooks/:id/connections/:id/quota` — current API quota / rate-limit state. (web-only) */
    getQuota: async (workbookId: string, id: string): Promise<ApiQuotaResponse> => {
      const res = await http.get<ApiQuotaResponse>(`/workbooks/${workbookId}/connections/${id}/quota`, {
        fallbackMessage: 'Failed to fetch API quota',
      });
      return res.data;
    },

    /** POST `/workbooks/:id/connections/:id/reset` — reset a connection (deletes data folders + V2 git repo). (web-only) */
    reset: async (workbookId: string, id: string): Promise<void> => {
      await http.post(`/workbooks/${workbookId}/connections/${id}/reset`, undefined, {
        fallbackMessage: 'Failed to reset connection',
      });
    },

    /** GET `/workbooks/:id/connections/:id/credentials/reveal` — admin-only break-glass, audit logged. (web-only) */
    revealCredentials: async (workbookId: string, id: string): Promise<RevealCredentialsResponse> => {
      const res = await http.get<RevealCredentialsResponse>(
        `/workbooks/${workbookId}/connections/${id}/credentials/reveal`,
        { fallbackMessage: 'Failed to reveal connection credentials' },
      );
      return res.data;
    },
  };
}

export type ConnectorAccountsApi = ReturnType<typeof createConnectorAccountsApi>;
