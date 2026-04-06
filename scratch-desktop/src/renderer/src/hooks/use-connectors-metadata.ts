import { connectorsMetadataApi, type ConnectorsMetadataMap } from '@/lib/connectors-metadata-api';
import useSWR from 'swr';

const SWR_KEY = 'connectors/metadata';

export function useConnectorsMetadata() {
  return useSWR<ConnectorsMetadataMap, Error>(SWR_KEY, () => connectorsMetadataApi.getAll(), {
    revalidateOnFocus: false,
  });
}

/** Same behavior as the web client `getLogo` helper. */
export function getConnectorLogoUrl(
  metadata: ConnectorsMetadataMap | undefined,
  service: string | null | undefined,
): string {
  const fallback = 'https://static.scratch.md/connector-icons/csv.svg';
  if (!service) return fallback;
  return metadata?.[service]?.logo ?? fallback;
}
