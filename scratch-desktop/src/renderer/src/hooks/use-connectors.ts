import { AuthMethod } from '@spinner/shared-types';
import { useMemo } from 'react';
import { useConnectorsMetadata } from './use-connectors-metadata';

export type { AuthMethod };

export function useConnectors() {
  const { data: metadata } = useConnectorsMetadata();

  const availableServices = useMemo(() => {
    if (!metadata) return [];
    return Object.entries(metadata)
      .filter(([, m]) => m.visible)
      .map(([service]) => service);
  }, [metadata]);

  const getDefaultAuthMethod = (service: string): AuthMethod => {
    return metadata?.[service]?.defaultAuthMethod ?? 'oauth';
  };

  const getSupportedAuthMethods = (service: string): AuthMethod[] => {
    return metadata?.[service]?.supportedAuthMethods ?? [];
  };

  return { availableServices, getDefaultAuthMethod, getSupportedAuthMethods };
}
