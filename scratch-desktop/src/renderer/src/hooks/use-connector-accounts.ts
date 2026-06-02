import { ConnectorAccount, CreateConnectorAccountDto, UpdateConnectorAccountDto } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';
import { connectorAccountsApi, TestConnectionResponse } from '../lib/connector-accounts-api';

const SWR_KEY_PREFIX = 'connector-accounts';

export function useConnectorAccounts(workbookId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<ConnectorAccount[], Error>(
    workbookId ? [SWR_KEY_PREFIX, workbookId] : null,
    () => {
      if (!workbookId) throw new Error('workbookId is required');
      return connectorAccountsApi.list(workbookId);
    },
    { revalidateOnFocus: false },
  );

  const refreshConnectorAccounts = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const createConnectorAccount = useCallback(
    async (dto: CreateConnectorAccountDto): Promise<ConnectorAccount> => {
      if (!workbookId) throw new Error('No workbook ID');
      const result = await connectorAccountsApi.create(workbookId, dto);
      await mutate();
      return result;
    },
    [workbookId, mutate],
  );

  const updateConnectorAccount = useCallback(
    async (id: string, dto: UpdateConnectorAccountDto): Promise<ConnectorAccount> => {
      if (!workbookId) throw new Error('No workbook ID');
      const result = await connectorAccountsApi.update(workbookId, id, dto);
      await mutate();
      return result;
    },
    [workbookId, mutate],
  );

  const deleteConnectorAccount = useCallback(
    async (id: string): Promise<void> => {
      if (!workbookId) throw new Error('No workbook ID');
      await connectorAccountsApi.delete(workbookId, id);
      await mutate();
    },
    [workbookId, mutate],
  );

  const testConnection = useCallback(
    async (id: string): Promise<TestConnectionResponse> => {
      if (!workbookId) throw new Error('No workbook ID');
      return connectorAccountsApi.test(workbookId, id);
    },
    [workbookId],
  );

  return {
    connectorAccounts: data ?? [],
    isLoading,
    error,
    createConnectorAccount,
    updateConnectorAccount,
    deleteConnectorAccount,
    testConnection,
    refreshConnectorAccounts,
  };
}
