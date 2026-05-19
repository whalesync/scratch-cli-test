import { AuthMethod } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { useConnectorsMetadata } from './use-connectors-metadata';
import { useScratchPadUser } from './useScratchpadUser';

export type { AuthMethod } from '@spinner/shared-types';

const ADMIN_ONLY_SERVICES = new Set(['GENERIC_API']);

/**
 * A utility hook for interacting with connectors, driven entirely by the metadata API.
 */
export const useConnectors = () => {
  const { metadata } = useConnectorsMetadata();
  const { user } = useScratchPadUser();
  const isAdmin = !!user?.isAdmin;

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
      .filter(([s, m]) => {
        if (ADMIN_ONLY_SERVICES.has(s) && !isAdmin) return false;
        return process.env.NODE_ENV === 'development' || m.visible;
      })
      .map(([s]) => s);
  }, [metadata, isAdmin]);

  return {
    getDefaultAuthMethod,
    getSupportedAuthMethods,
    availableServices,
  };
};
