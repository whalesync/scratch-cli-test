import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import type { CreateDestination, CreateDestinationList } from '@spinner/shared-types';
import useSWR from 'swr';

/**
 * The places a connector can create a new table (Airtable bases, Postgres
 * schemas, etc.), for the schema-creation dev tool's "Remote parent" picker.
 *
 * `enabled` gates the fetch: this hits the remote service, and the modal is
 * mounted for every connector node, so callers pass `false` until the tool is
 * actually open.
 */
export const useCreateDestinations = (workbookId: string, connectorAccountId: string, enabled: boolean) => {
  const { data, error, isLoading } = useSWR<CreateDestinationList, Error>(
    enabled ? SWR_KEYS.connectorAccounts.createDestinations(workbookId, connectorAccountId) : null,
    () => scratchApiClient.connectorAccounts.listCreateDestinations(workbookId, connectorAccountId),
  );

  const destinations: CreateDestination[] | undefined = data?.destinations;
  return { destinations, isLoading, error };
};
