import { Service } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { useConnectorsMetadata } from './use-connectors-metadata';
import { useScratchPadUser } from './useScratchpadUser';

export type AuthMethod = 'user_provided_params' | 'oauth' | 'oauth_custom';

/**
 * A utility hook for interacting with connectors and obtaingin connector specific config based on the current user.
 */
export const useConnectors = () => {
  const { user, isAdmin } = useScratchPadUser();
  const { metadata } = useConnectorsMetadata();

  const getDefaultAuthMethod = useCallback(
    (service: Service): AuthMethod => {
      // Services that support OAuth
      const oauthSupportedServices = [
        Service.NOTION,
        Service.YOUTUBE,
        Service.WIX_BLOG,
        Service.SUPABASE,
        Service.AIRTABLE,
      ];

      if (service === Service.WEBFLOW && user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }
      oauthSupportedServices.push(Service.SHOPIFY);

      // Services that use generic parameters
      const genericParametersSupportedServices = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        Service.SHOPIFY,
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
        Service.PIPEDRIVE,
      ];
      if (oauthSupportedServices.includes(service)) {
        return 'oauth';
      } else if (genericParametersSupportedServices.includes(service)) {
        return 'user_provided_params';
      } else {
        return 'oauth'; // Default fallback
      }
    },
    [user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH],
  );

  const getSupportedAuthMethods = useCallback(
    (service: Service): AuthMethod[] => {
      const oauthSupportedServices = [
        Service.NOTION,
        Service.YOUTUBE,
        Service.WIX_BLOG,
        Service.SUPABASE,
        Service.AIRTABLE,
      ];

      if (service === Service.WEBFLOW && user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }
      oauthSupportedServices.push(Service.SHOPIFY);

      const userProvidedParamsSupportedServices = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        ...(user?.experimentalFlags?.SHOPIFY_API_KEYS ? [Service.SHOPIFY] : []),
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
        Service.PIPEDRIVE,
      ];
      const methods: AuthMethod[] = [];
      if (oauthSupportedServices.includes(service)) {
        methods.push('oauth');
        // Enable Private OAuth only for YouTube (generic-ready for future services)
        if (service === Service.YOUTUBE) {
          methods.push('oauth_custom');
        }
      }
      if (userProvidedParamsSupportedServices.includes(service)) {
        methods.push('user_provided_params');
      }
      return methods;
    },
    [user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH, user?.experimentalFlags?.SHOPIFY_API_KEYS],
  );

  // For admins show all visible services. Dedupe in case of overlap between flags and metadata.
  // In development, show all connectors without filtering.
  const availableServices = useMemo(() => {
    if (process.env.NODE_ENV === 'development') {
      return Object.values(Service);
    }
    const connectorListFromFlags = (user?.experimentalFlags?.CONNECTOR_LIST ?? []) as Service[];
    if (!isAdmin) return connectorListFromFlags;
    const visibleServices = metadata
      ? (Object.entries(metadata)
          .filter(([, m]) => m.visible)
          .map(([s]) => s) as Service[])
      : [];
    return [...new Set([...connectorListFromFlags, ...visibleServices])];
  }, [user?.experimentalFlags?.CONNECTOR_LIST, isAdmin, metadata]);

  return {
    getDefaultAuthMethod,
    getSupportedAuthMethods,
    availableServices,
  };
};
