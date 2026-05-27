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

/** Get the display name for a service, falling back to the raw service key. */
export function getServiceName(metadata: ConnectorsMetadataMap | undefined, service: string): string {
  return metadata?.[service]?.displayName ?? service;
}

/** Get the OAuth button label for a service. */
export function getOauthLabel(metadata: ConnectorsMetadataMap | undefined, service: string): string {
  return metadata?.[service]?.oauth?.label ?? 'OAuth';
}

/** Get the private OAuth button label for a service. */
export function getOauthPrivateLabel(metadata: ConnectorsMetadataMap | undefined, service: string): string {
  return metadata?.[service]?.oauth?.privateLabel ?? 'Private OAuth';
}
