import { connectorsMetadataApi } from '@/lib/api/connectors-metadata';
import { SWR_KEYS } from '@/lib/api/keys';
import { ConnectorMetadata, Service } from '@spinner/shared-types';
import capitalize from 'lodash/capitalize';
import useSWR from 'swr';

export const useConnectorsMetadata = () => {
  const { data, error, isLoading } = useSWR(SWR_KEYS.connectorsMetadata.all(), () => connectorsMetadataApi.getAll());

  return {
    metadata: data,
    isLoading,
    error,
  };
};

// Helper functions that work with the metadata record — these replicate the old service-naming-conventions helpers

export const getServiceName = (
  metadata: Record<Service, ConnectorMetadata> | undefined,
  service: Service | null | undefined,
): string => {
  if (!service) return 'Service';
  return metadata?.[service]?.displayName ?? capitalize(service);
};

export const getLogo = (
  metadata: Record<Service, ConnectorMetadata> | undefined,
  service: Service | null | undefined,
): string => {
  const fallback = 'https://static.scratch.md/connector-icons/csv.svg';
  if (!service) return fallback;
  return metadata?.[service]?.logo ?? fallback;
};

export const getOauthLabel = (metadata: Record<Service, ConnectorMetadata> | undefined, service: Service): string => {
  return metadata?.[service]?.oauth?.label ?? 'OAuth';
};

export const getOauthPrivateLabel = (
  metadata: Record<Service, ConnectorMetadata> | undefined,
  service: Service,
): string => {
  return metadata?.[service]?.oauth?.privateLabel ?? 'Private OAuth';
};

export const getPullOperationName = (
  metadata: Record<Service, ConnectorMetadata> | undefined,
  service: Service | null | undefined,
): string => {
  if (!service) return 'Reload';
  return metadata?.[service]?.pullOperationName ?? 'Download';
};

export const getPushOperationName = (
  metadata: Record<Service, ConnectorMetadata> | undefined,
  service: Service | null | undefined,
): string => {
  if (!service) return 'Save';
  return metadata?.[service]?.pushOperationName ?? 'Publish';
};

export const hasOAuth = (metadata: Record<Service, ConnectorMetadata> | undefined, service: Service): boolean => {
  return metadata?.[service]?.oauth !== undefined;
};
