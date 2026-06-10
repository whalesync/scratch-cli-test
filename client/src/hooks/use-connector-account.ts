import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import {
  ConnectorAccount,
  CreateConnectorAccountDto,
  TestConnectionResponse,
  UpdateConnectorAccountDto,
  WorkbookId,
} from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { ScratchpadNotifications } from '../app/components/ScratchpadNotifications';
import { getServiceName, useConnectorsMetadata } from './use-connectors-metadata';

export const useConnectorAccounts = (workbookId: string | undefined) => {
  const { mutate } = useSWRConfig();
  const { metadata } = useConnectorsMetadata();
  const {
    data,
    error,
    isLoading,
    mutate: mutateConnectorAccounts,
  } = useSWR<ConnectorAccount[], Error>(workbookId ? SWR_KEYS.connectorAccounts.list(workbookId) : null, () => {
    if (!workbookId) {
      throw new Error('workbookId is required');
    }
    return scratchApiClient.connectorAccounts.list(workbookId);
  });

  const createConnectorAccount = async (dto: CreateConnectorAccountDto): Promise<ConnectorAccount> => {
    if (!workbookId) {
      throw new Error('Workbook ID is required to create a connector account');
    }
    const newAccount = await scratchApiClient.connectorAccounts.create(workbookId, dto);
    mutate(SWR_KEYS.connectorAccounts.list(workbookId));
    return newAccount;
  };

  const updateConnectorAccount = async (id: string, dto: UpdateConnectorAccountDto): Promise<ConnectorAccount> => {
    if (!workbookId) {
      throw new Error('Workbook ID is required to update a connector account');
    }
    const updated = await scratchApiClient.connectorAccounts.update(workbookId, id, dto);
    mutate(SWR_KEYS.connectorAccounts.list(workbookId));
    mutate(SWR_KEYS.connectorAccounts.detail(workbookId, id));
    return updated;
  };

  const deleteConnectorAccount = async (id: string) => {
    if (!workbookId) {
      throw new Error('Workbook ID is required to delete a connector account');
    }
    await scratchApiClient.connectorAccounts.delete(workbookId, id);
    mutate(SWR_KEYS.connectorAccounts.list(workbookId));
    mutate(SWR_KEYS.workbook.detail(workbookId as WorkbookId));
    mutate(SWR_KEYS.dataFolders.list(workbookId as WorkbookId));
  };

  const testConnection = async (con: ConnectorAccount): Promise<TestConnectionResponse> => {
    if (!workbookId) {
      throw new Error('Workbook ID is required to test a connection');
    }
    try {
      const r = await scratchApiClient.connectorAccounts.test(workbookId, con.id);
      mutate(SWR_KEYS.connectorAccounts.detail(workbookId, con.id));
      mutate(SWR_KEYS.connectorAccounts.list(workbookId));
      if (r.health == 'ok') {
        ScratchpadNotifications.success({
          title: 'Connection healthy',
          message: `Scratch can connect to ${getServiceName(metadata, con.service)}`,
        });
      } else {
        ScratchpadNotifications.error({
          title: 'Connection error',
          message: r.error,
        });
      }
      return r;
    } catch (e) {
      ScratchpadNotifications.error({
        title: 'Connection error',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
      return { health: 'error', error: e instanceof Error ? e.message : 'Unknown error' };
    }
  };

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  return {
    connectorAccounts: data ?? undefined,
    isLoading,
    error: displayError,
    createConnectorAccount,
    updateConnectorAccount,
    deleteConnectorAccount,
    testConnection,
    refreshConnectorAccounts: () => mutateConnectorAccounts(),
  };
};

export const useConnectorAccount = (workbookId: string | undefined, id?: string) => {
  const { data, error, isLoading } = useSWR<ConnectorAccount, Error>(
    workbookId && id ? SWR_KEYS.connectorAccounts.detail(workbookId, id) : null,
    () => {
      if (!workbookId || !id) {
        throw new Error('workbookId and id are required');
      }
      return scratchApiClient.connectorAccounts.detail(workbookId, id);
    },
  );

  return {
    connectorAccount: data,
    isLoading,
    error,
  };
};
