import { AuthMethod } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { useConnectorsMetadata } from './use-connectors-metadata';

/**
 * A utility hook for interacting with connectors, driven entirely by the metadata API.
 */
export const useConnectors = () => {
  const { metadata } = useConnectorsMetadata();

  const getDefaultAuthMethod = useCallback(
    (service: string): AuthMethod => {
      return metadata?.[service]?.defaultAuthMethod ?? 'oauth';
    },
    [metadata],
  );

  const getSupportedAuthMethods = useCallback(
    (service: string): AuthMethod[] => {
      return metadata?.[service]?.supportedAuthMethods ?? [];
    },
    [metadata],
  );

  const availableServices = useMemo(() => {
    if (!metadata) return [];
    return Object.entries(metadata)
      .filter(([, m]) => process.env.NODE_ENV === 'development' || m.visible)
      .map(([s]) => s);
  }, [metadata]);

  return {
    getDefaultAuthMethod,
    getSupportedAuthMethods,
    availableServices,
  };
};
